-- ============================================================
-- Row-Level Security 政策
-- 對應「模組規格文件」第二章角色權限
-- 需在 schema.sql 執行後再執行本檔
-- ============================================================

-- 輔助函式：取得目前登入者的角色與 teacher_id
create or replace function current_role_name() returns user_role as $$
  select role from app_users where id = auth.uid();
$$ language sql stable;

create or replace function current_teacher_id() returns uuid as $$
  select id from teachers where app_user_id = auth.uid();
$$ language sql stable;

-- ---------- 鎖定判斷輔助函式 ----------
create or replace function scores_locked(p_class_id uuid, p_academic_year int, p_term text, p_exam_type text)
returns boolean as $$
  select exists (
    select 1 from submission_windows sw
    where sw.data_type = p_exam_type
      and sw.scope = '班級'
      and sw.scope_ref = p_class_id::text
      and sw.academic_year = p_academic_year
      and sw.term = p_term
      and sw.is_locked = true
  );
$$ language sql stable;

create or replace function has_approved_correction(p_record_id uuid)
returns boolean as $$
  select exists (
    select 1 from correction_requests cr
    where cr.record_id = p_record_id and cr.status = '核准'
  );
$$ language sql stable;

-- 判斷目前登入者是否能寫入某筆成績：
-- 1) 一定要先符合「任課教師教這科」或「導師教這班」或管理員身分
-- 2) 沒鎖定就可以直接寫
-- 3) 鎖定後，只有「這筆資料有核准的修正申請」才能再寫——導師與任課教師一視同仁，都不能繞過
create or replace function can_write_score(p_enrollment_id uuid, p_subject text, p_exam_type text, p_score_id uuid default null)
returns boolean as $$
declare
  v_class_id uuid;
  v_academic_year int;
  v_term text;
  v_is_owner boolean;
begin
  select c.id, c.academic_year, e.term into v_class_id, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if current_role_name() in ('admin_a', 'admin_b', 'system_admin_s') then
    return true; -- 管理員不受鎖定限制，負責審核與最終處理
  end if;

  -- 只認「任課教師設定」裡實際指派的班級＋科目：導師如果沒被指派教這科，一樣不能寫這科的成績
  -- （「看全班成績」不受此限——那是 scores_select 政策的範圍，跟這裡的寫入判斷分開）。
  v_is_owner := exists (
    select 1 from class_schedule cs
    where cs.class_id = v_class_id and cs.teacher_id = current_teacher_id() and cs.subject = p_subject
  );

  if not v_is_owner then
    return false;
  end if;

  if not scores_locked(v_class_id, v_academic_year, v_term, p_exam_type) then
    return true;
  end if;

  -- 鎖定後：導師與任課教師都必須有核准的修正申請才能再寫
  return p_score_id is not null and has_approved_correction(p_score_id);
end;
$$ language plpgsql stable security definer;

-- ---------- scores：讀取（維持原本的授課範圍限制，鎖定不影響查看） ----------
create policy scores_select on scores
  for select
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join class_schedule cs on cs.class_id = e.class_id
      where e.id = scores.enrollment_id
        and cs.teacher_id = current_teacher_id()
        and cs.subject = scores.subject
    )
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.id = scores.enrollment_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- ---------- scores：新增（鎖定後禁止，導師與任課教師都一樣） ----------
create policy scores_insert on scores
  for insert
  with check (can_write_score(enrollment_id, subject, exam_type::text));

-- ---------- scores：修改/刪除（鎖定後除非有核准的修正申請，否則一律禁止） ----------
create policy scores_update on scores
  for update
  using (can_write_score(enrollment_id, subject, exam_type::text, id))
  with check (can_write_score(enrollment_id, subject, exam_type::text, id));

create policy scores_delete on scores
  for delete
  using (can_write_score(enrollment_id, subject, exam_type::text, id));

-- ---------- attendance ----------
create policy homeroom_and_subject_teacher_write_attendance on attendance
  for all
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      -- 導師：對自己班級所有學生的出缺勤有直接修正權限
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = attendance.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
    or exists (
      -- 任課教師：僅能寫入課表中指定自己教的節次
      select 1 from enrollments e
      join class_schedule cs on cs.class_id = e.class_id
      where e.student_no = attendance.student_no
        and cs.teacher_id = current_teacher_id()
        and cs.period_no = attendance.period_no
    )
  );

-- ---------- 稽核紀錄：僅管理員角色可查詢 ----------
create policy admin_only_read_attendance_audit on attendance_audit_log
  for select
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy admin_only_read_score_audit on score_audit_log
  for select
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ---------- 修正申請 ----------
-- 任課教師只能看自己送出的申請；管理員A可看全部並審核
create policy teacher_view_own_requests on correction_requests
  for select
  using (
    requested_by = current_teacher_id()
    or current_role_name() in ('admin_a', 'system_admin_s')
  );

create policy teacher_create_requests on correction_requests
  for insert
  with check (requested_by = current_teacher_id());

create policy admin_a_review_requests on correction_requests
  for update
  using (current_role_name() in ('admin_a', 'system_admin_s'));

-- ---------- student_remarks：只有該班導師與管理員能看/改，任課教師不可見 ----------
create policy homeroom_and_admin_only_remarks on student_remarks
  for all
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.id = student_remarks.enrollment_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- ---------- 基礎設定表：curriculum / classes / grading_rules / score_adjustments ----------
-- 這幾張表的「讀取」要對所有登入使用者開放，因為 subject_weighted_scores 等計算 view
-- 是用 security_invoker 執行，任課教師/導師查詢時也需要能讀到這些設定表才能算出正確結果。
-- 「寫入」（新增/修改/刪除）則限定管理員角色，一般教師不能自己改科目比重或班級設定。
alter table curriculum enable row level security;
alter table classes enable row level security;
alter table grading_rules enable row level security;
alter table score_adjustments enable row level security;

create policy read_curriculum on curriculum for select using (true);
create policy admin_write_curriculum on curriculum for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy read_classes on classes for select using (true);
create policy admin_write_classes on classes for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy read_grading_rules on grading_rules for select using (true);
create policy admin_write_grading_rules on grading_rules for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy read_score_adjustments on score_adjustments for select using (true);
create policy admin_write_score_adjustments on score_adjustments for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
alter table submission_windows enable row level security;

-- 任何登入者都能「讀」目前是否鎖定（不算敏感資訊，前端要用來顯示鎖定狀態）
create policy read_submission_windows on submission_windows
  for select
  using (true);

-- 管理員B（及A、S）可以設定任何範圍的開放時間/鎖定
create policy admin_manage_submission_windows on submission_windows
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- 導師：只能針對「自己班級」的「平時分」建立/更新鎖定紀錄（即「提前結束輸入」按鈕的效果）
-- 刻意限制在 data_type='平時分'、scope='班級'，不讓導師動到出缺勤或其他班級/範圍的設定
create policy homeroom_lock_own_class_daily_score on submission_windows
  for all
  using (
    scope = '班級'
    and data_type = '平時分'
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  )
  with check (
    scope = '班級'
    and data_type = '平時分'
    and exists (
      select 1 from classes c
      where c.id::text = submission_windows.scope_ref
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );
