-- ============================================================
-- 04. 部門政策全面改寫（補完 01_department_rbac_refactor.sql 對照表 B）
-- ------------------------------------------------------------
-- 這份檔案把 37/sql/ 原本 17 份檔案裡，所有「current_role_name() in
-- ('admin_a','admin_b','system_admin_s')」這種不分部門的舊寫法，
-- 依照 01_department_rbac_refactor.sql 的對照表，逐一改寫成
-- is_system_admin() / has_department(dept) / is_department_lead(dept)。
--
-- ⚠️ 這仍然是「草案」，尚未在正式/測試 Supabase 環境跑過。套用前：
--   1. 確認 01_department_rbac_refactor.sql、02_pending_changes_approval_system.sql、
--      03_ranking_lock_granularity_fix.sql 都已先執行過。
--   2. 先在測試環境跑一次，用不同部門的測試帳號實際登入驗證每一項操作。
--   3. 每個 drop policy if exists 都是「同名重建」，執行順序內先 drop 再 create，
--      可以重複執行（idempotent），不會因為政策已存在而報錯。
--
-- 檔案內以「原始檔案」分節，方便對照 37/sql/ 裡對應的檔案逐一核對。
-- ============================================================


-- ============================================================
-- 來源：policies.sql
-- ============================================================

-- can_write_score()：管理員不受鎖定限制 → 改成「教務部門或系統管理員」
-- （這個函式後面又被 scores_write_permission_fix.sql create or replace 覆蓋過，
--  下面直接建立「最終版」，兩份草稿檔本身不需要再另外改）
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

  if is_system_admin() or has_department('academic') then
    return true; -- 教務處不受鎖定限制，負責審核與最終處理
  end if;

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

  return p_score_id is not null and has_approved_correction(p_score_id);
end;
$$ language plpgsql stable security definer;

-- scores：讀取
drop policy if exists scores_select on scores;
create policy scores_select on scores
  for select
  using (
    is_system_admin() or has_department('academic')
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

-- attendance（訓導）：would already be superseded by attendance_window_open_requests.sql's
-- can_write_attendance()；改寫如下（見該檔對應段落）。

-- 稽核紀錄：attendance_audit_log → 訓導；score_audit_log → 教務
drop policy if exists admin_only_read_attendance_audit on attendance_audit_log;
create policy admin_only_read_attendance_audit on attendance_audit_log
  for select
  using (is_system_admin() or has_department('discipline'));

drop policy if exists admin_only_read_score_audit on score_audit_log;
create policy admin_only_read_score_audit on score_audit_log
  for select
  using (is_system_admin() or has_department('academic'));

-- 修正申請：依 data_type 分流到教務／訓導「主管(lead)」
-- （原本只給 admin_a，等同「部門主管」層級，因此對應 is_department_lead，不是 has_department）
drop policy if exists teacher_view_own_requests on correction_requests;
create policy teacher_view_own_requests on correction_requests
  for select
  using (
    requested_by = current_teacher_id()
    or is_system_admin()
    or (data_type = '出缺勤' and is_department_lead('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and is_department_lead('academic'))
  );

drop policy if exists admin_a_review_requests on correction_requests;
create policy department_lead_review_requests on correction_requests
  for update
  using (
    is_system_admin()
    or (data_type = '出缺勤' and is_department_lead('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and is_department_lead('academic'))
  );

-- student_remarks（導師評語，跟成績單一起產出）→ 教務
drop policy if exists homeroom_and_admin_only_remarks on student_remarks;
create policy homeroom_and_admin_only_remarks on student_remarks
  for all
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.id = student_remarks.enrollment_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 基礎設定表：curriculum / classes / grading_rules / score_adjustments → 教務
drop policy if exists admin_write_curriculum on curriculum;
create policy admin_write_curriculum on curriculum for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

drop policy if exists admin_write_classes on classes;
create policy admin_write_classes on classes for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

drop policy if exists admin_write_grading_rules on grading_rules;
create policy admin_write_grading_rules on grading_rules for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

drop policy if exists admin_write_score_adjustments on score_adjustments;
create policy admin_write_score_adjustments on score_adjustments for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- submission_windows：依 data_type 分流（原本不分 data_type，一律「管理員B/A/S」都能設）
drop policy if exists admin_manage_submission_windows on submission_windows;
create policy department_manage_submission_windows on submission_windows
  for all
  using (
    is_system_admin()
    or (data_type = '出缺勤' and has_department('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and has_department('academic'))
  )
  with check (
    is_system_admin()
    or (data_type = '出缺勤' and has_department('discipline'))
    or (data_type in ('期中考', '期末考', '平時分') and has_department('academic'))
  );
-- homeroom_lock_own_class_daily_score 政策不含 admin_a/admin_b，維持原樣不變。


-- ============================================================
-- 來源：attendance_alerts_and_guardian_edit.sql（訓導）
-- ============================================================

drop policy if exists admin_write_attendance_alert_settings on attendance_alert_settings;
create policy admin_write_attendance_alert_settings on attendance_alert_settings
  for all
  using (is_system_admin() or has_department('discipline'))
  with check (is_system_admin() or has_department('discipline'));

-- 檔案第 74-77 行、88-91 行這兩段是同一份檔案裡「出缺勤累計節數」相關表的 insert/select 政策，
-- 資料表名稱依實際 schema 為準（該檔內建立的累計/示警表），一律比照訓導部門：
-- 請對照您實際 Supabase 專案裡這兩個 create policy 陳述式的資料表名稱，
-- 把其中的 current_role_name() in ('admin_a','admin_b','system_admin_s')
-- 換成 is_system_admin() or has_department('discipline')，作法與上面 attendance_alert_settings 完全相同。

drop policy if exists teacher_read_own_notifications on staff_notifications;
create policy teacher_read_own_notifications on staff_notifications
  for select
  using (teacher_id = current_teacher_id() or is_system_admin() or has_department('discipline'));

drop policy if exists admin_insert_notifications on staff_notifications;
create policy admin_insert_notifications on staff_notifications
  for insert
  with check (is_system_admin() or has_department('discipline'));


-- ============================================================
-- 來源：attendance_window_open_requests.sql（訓導）
-- ============================================================

create or replace function can_write_attendance(p_student_no text, p_record_date date, p_period_no int, p_attendance_id uuid default null)
returns boolean as $$
declare
  v_is_owner boolean;
begin
  if is_system_admin() or has_department('discipline') then
    return true;
  end if;

  v_is_owner := exists (
    select 1 from enrollments e
    join classes c on c.id = e.class_id
    where e.student_no = p_student_no
      and c.homeroom_teacher_id = current_teacher_id()
  ) or exists (
    select 1 from enrollments e
    join class_schedule cs on cs.class_id = e.class_id
    where e.student_no = p_student_no
      and cs.teacher_id = current_teacher_id()
      and cs.period_no = p_period_no
  );
  if not v_is_owner then
    return false;
  end if;

  if not attendance_locked(p_student_no, p_record_date) then
    return true;
  end if;

  return (p_attendance_id is not null and has_approved_correction(p_attendance_id))
    or exists (
      select 1 from enrollments e
      where e.student_no = p_student_no
        and has_approved_window_open(e.class_id)
    );
end;
$$ language plpgsql stable security definer;
-- homeroom_and_subject_teacher_write_attendance 政策本身呼叫 can_write_attendance()，
-- 上面 create or replace 完就自動套用新規則，政策陳述式不用重建。


-- ============================================================
-- 來源：backups.sql（開發人員）
-- ============================================================

drop policy if exists admin_read_backups on backups;
create policy admin_read_backups on backups
  for select
  using (is_system_admin() or has_department('dev'));


-- ============================================================
-- 來源：conduct_defaults.sql（訓導）
-- ============================================================

drop policy if exists admin_write_conduct_point_defaults on conduct_point_defaults;
create policy admin_write_conduct_point_defaults on conduct_point_defaults for all
  using (is_system_admin() or has_department('discipline'))
  with check (is_system_admin() or has_department('discipline'));


-- ============================================================
-- 來源：phase4_updates.sql
-- ============================================================

-- period_config → 教務
drop policy if exists admin_write_period_config on period_config;
create policy admin_write_period_config on period_config
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- account_audit_log → 開發人員
drop policy if exists admin_read_account_audit_log on account_audit_log;
create policy admin_read_account_audit_log on account_audit_log
  for select
  using (is_system_admin() or has_department('dev'));


-- ============================================================
-- 來源：portal.sql
-- ============================================================

-- students / enrollments → 教務（學籍相關寫入）
drop policy if exists staff_read_students on students;
create policy staff_read_students on students
  for select
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = students.student_no and c.homeroom_teacher_id = current_teacher_id()
    )
    or exists (
      select 1 from class_schedule cs join enrollments e2 on e2.class_id = cs.class_id
      where e2.student_no = students.student_no and cs.teacher_id = current_teacher_id()
    )
  );
-- ⚠️ 上面 using 子句的其餘 exists 條件請對照您正式環境 staff_read_students 原本的完整寫法補上，
-- 這裡只示範把 admin_a/admin_b 判斷換掉，其他既有的授課教師/導師可見範圍條件不變。

drop policy if exists admin_write_students on students;
create policy admin_write_students on students
  for insert
  with check (is_system_admin() or has_department('academic'));

drop policy if exists admin_delete_students on students;
create policy admin_delete_students on students
  for delete
  using (is_system_admin() or has_department('academic'));

drop policy if exists admin_update_students on students;
create policy admin_update_students on students
  for update
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));
-- 注意：student_edit.sql 另外疊加的 homeroom_update_own_class_students 政策不含
-- admin_a/admin_b，不受影響、維持原樣。

drop policy if exists staff_read_enrollments on enrollments;
create policy staff_read_enrollments on enrollments
  for select
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from classes c
      where c.id = enrollments.class_id and c.homeroom_teacher_id = current_teacher_id()
    )
  );
-- ⚠️ 同上，補上您正式環境原本 staff_read_enrollments 其餘的可見範圍條件。

drop policy if exists admin_write_enrollments on enrollments;
create policy admin_write_enrollments on enrollments
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- portal_accounts / profile_edit_requests → 教務
drop policy if exists staff_create_portal_accounts on portal_accounts;
create policy staff_create_portal_accounts on portal_accounts
  for insert
  with check (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = portal_accounts.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

drop policy if exists staff_manage_portal_accounts on portal_accounts;
create policy staff_manage_portal_accounts on portal_accounts
  for update
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

drop policy if exists parent_read_own_edit_requests on profile_edit_requests;
create policy parent_read_own_edit_requests on profile_edit_requests
  for select
  using (
    exists (select 1 from portal_accounts pa where pa.id = profile_edit_requests.requested_by and pa.auth_user_id = auth.uid())
    or is_system_admin() or has_department('academic')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = profile_edit_requests.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- portal.sql 裡的 class_rankings / grade_rankings（含 is_linked_parent 判斷）已經被
-- 03_ranking_lock_granularity_fix.sql 的 create or replace view 完全取代，不需要另外改；
-- 03 檔本身的角色判斷寫法在本檔最下面一併修正（見「來源：03_ranking_lock_granularity_fix.sql」）。


-- ============================================================
-- 來源：promotion.sql（教務）
-- ============================================================

drop policy if exists admin_write_grade_progression on grade_progression;
create policy admin_write_grade_progression on grade_progression for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));


-- ============================================================
-- 來源：registration.sql（教務）
-- ============================================================

drop policy if exists homeroom_and_admin_guardians on guardians;
create policy homeroom_and_admin_guardians on guardians
  for all
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = guardians.student_no and c.homeroom_teacher_id = current_teacher_id()
    )
  );

drop policy if exists admin_only_status_changes on student_status_changes;
create policy admin_only_status_changes on student_status_changes
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

drop policy if exists admin_only_status_attachments on status_change_attachments;
create policy admin_only_status_attachments on status_change_attachments
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));


-- ============================================================
-- 來源：scheduler_backups.sql（教務——排課工具本身的專案存檔）
-- ============================================================

drop policy if exists "scheduler_backups_select_admin" on scheduler_backups;
create policy "scheduler_backups_select_admin" on scheduler_backups
  for select using (
    is_system_admin() or has_department('academic')
  );


-- ============================================================
-- 來源：03_ranking_lock_granularity_fix.sql
-- ------------------------------------------------------------
-- 該檔本身的「誰能查到這個學生」條件仍是 admin_a/admin_b 舊寫法，
-- 這裡用 create or replace view 補上部門判斷（其餘欄位/鎖定邏輯完全不變，
-- 直接複製該檔的最終版本，只替換角色判斷式）。
-- ============================================================

create or replace view class_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.class_rank end as class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_class_rank end as midterm_class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_class_rank end as final_class_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_class_rank end as daily_class_rank

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    et.midterm_total,
    rank() over (partition by e.class_id, e.term order by et.midterm_total desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_total desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_total desc) as daily_class_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  is_system_admin() or has_department('academic')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

create or replace view grade_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.department,
  ranked.grade_level,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.grade_rank end as grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_grade_rank end as midterm_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_grade_rank end as final_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_grade_rank end as daily_grade_rank

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, c.department, c.grade_level,
    st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by t.total_score desc) as grade_rank,
    et.midterm_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_total desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_total desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_total desc) as daily_grade_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  is_system_admin() or has_department('academic')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

-- ============================================================
-- 備註：calculations.sql、exam_type_rankings.sql、portal.sql 裡也各自有一版
-- class_rankings/grade_rankings（開發過程中的舊版本），但這三份 view 定義
-- 全部都被 03_ranking_lock_granularity_fix.sql（以及上面這份更新版）
-- 用 create or replace view 覆蓋取代，所以那三份檔案裡的 admin_a/admin_b
-- 寫法不需要另外處理，執行順序上本來就會被後面的版本蓋掉。
-- ============================================================


-- ============================================================
-- 來源：02_pending_changes_approval_system.sql 段落 D
-- ------------------------------------------------------------
-- B（staff）層級收回對受管資料表的直接寫入權限，只留「送審」這條路。
-- 依 governed_tables 目前登記的 7 張表，逐一改寫：
-- ============================================================

drop policy if exists admin_write_curriculum on curriculum;
create policy department_lead_write_curriculum on curriculum
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

-- class_schedule：目前 schema.sql 裡沒有看到獨立的 admin 寫入政策名稱可對照，
-- 如果您正式環境的 class_schedule 也有一條「is_system_admin() or has_department('academic')」
-- 這種全體教務可寫的政策，請比照下面語法改成「只有 lead 可直接寫」：
--   drop policy if exists <您的政策名稱> on class_schedule;
--   create policy department_lead_write_class_schedule on class_schedule
--     for all
--     using (is_system_admin() or is_department_lead('academic'))
--     with check (is_system_admin() or is_department_lead('academic'));

drop policy if exists admin_write_period_config on period_config;
create policy department_lead_write_period_config on period_config
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

drop policy if exists admin_write_grade_progression on grade_progression;
create policy department_lead_write_grade_progression on grade_progression
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

drop policy if exists admin_write_grading_rules on grading_rules;
create policy department_lead_write_grading_rules on grading_rules
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

drop policy if exists admin_write_attendance_alert_settings on attendance_alert_settings;
create policy department_lead_write_attendance_alert_settings on attendance_alert_settings
  for all
  using (is_system_admin() or is_department_lead('discipline'))
  with check (is_system_admin() or is_department_lead('discipline'));

drop policy if exists admin_write_conduct_point_defaults on conduct_point_defaults;
create policy department_lead_write_conduct_point_defaults on conduct_point_defaults
  for all
  using (is_system_admin() or is_department_lead('discipline'))
  with check (is_system_admin() or is_department_lead('discipline'));

-- ⚠️ 執行完這段之後，governed_tables 內這 7 張表的 B（staff）就不能再直接寫入，
-- 前端這幾張表的「新增/修改」按鈕都必須改成呼叫送審 API（寫進 pending_changes），
-- 否則 B 層級使用者操作既有畫面時會直接收到 RLS 拒絕的錯誤，請務必兩邊同時上線，
-- 不要只套用 SQL、不改前端，會讓 B 帳號整批功能當掉。
