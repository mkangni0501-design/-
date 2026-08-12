-- ============================================================
-- 出缺勤「申請開放」功能：擴充 correction_requests，
-- 讓它除了原本「單筆記錄」的修正申請之外，也能承載「整個班級/範圍」的
-- 開放（解鎖）申請——對應「學生出缺席登錄（一週）」頁面，
-- 整週/整班被鎖定時，導師點選「申請開放」送出的請求。
--
-- 請在 schema.sql / policies.sql 執行後再執行本檔。
-- ============================================================

-- 1) record_id 原本 not null（單筆修正一定要指到 attendance.id 或 scores.id）。
--    整班開放申請沒有單一筆記錄可以指，所以把這個限制放寬，
--    改用下面新增的 scope/scope_ref 來標示「要開放哪個範圍」。
alter table correction_requests
  alter column record_id drop not null;

alter table correction_requests
  add column if not exists scope text check (scope in ('全校', '部別', '班級')),
  add column if not exists scope_ref text,
  add column if not exists academic_year int,
  add column if not exists term text check (term in ('上學期', '下學期'));

-- 2) 至少要有 record_id（單筆修正）或 scope（範圍開放申請）其中一種，不能兩個都空。
alter table correction_requests
  drop constraint if exists correction_requests_target_check;
alter table correction_requests
  add constraint correction_requests_target_check
  check (record_id is not null or scope is not null);

-- 3) 既有的 RLS 政策（teacher_view_own_requests / teacher_create_requests / admin_a_review_requests）
--    本來就沒有限定只能是單筆修正，範圍開放申請沿用同一組政策即可，不需要另外新增。

-- ============================================================
-- 附帶修正：attendance 的寫入政策原本完全沒有檢查 submission_windows 是否鎖定
-- （鎖定狀態只有前端 UI 會顯示，資料庫層級寫入其實一直都沒被擋下來）。
-- 這裡補上跟 scores 一致的鎖定判斷：鎖定後除非有「核准的申請」（單筆修正或本檔新增的
-- 範圍開放申請），否則導師/任課教師都無法再寫入；管理員不受影響。
-- ============================================================

create or replace function attendance_locked(p_student_no text, p_record_date date)
returns boolean as $$
  select exists (
    select 1
    from submission_windows sw
    join enrollments e on e.student_no = p_student_no
    join classes c on c.id = e.class_id
    where sw.data_type = '出缺勤'
      and sw.scope = '班級'
      and sw.scope_ref = c.id::text
      and sw.is_locked = true
  );
$$ language sql stable;

create or replace function has_approved_window_open(p_class_id uuid)
returns boolean as $$
  select exists (
    select 1 from correction_requests cr
    where cr.data_type = '出缺勤'
      and cr.scope = '班級'
      and cr.scope_ref = p_class_id::text
      and cr.status = '核准'
  );
$$ language sql stable;

create or replace function can_write_attendance(p_student_no text, p_record_date date, p_period_no int, p_attendance_id uuid default null)
returns boolean as $$
declare
  v_is_owner boolean;
begin
  if current_role_name() in ('admin_a', 'admin_b', 'system_admin_s') then
    return true;
  end if;

  v_is_owner := exists (
    -- 導師：對自己班級所有學生的出缺勤有直接修正權限（不限節次）
    select 1 from enrollments e
    join classes c on c.id = e.class_id
    where e.student_no = p_student_no
      and c.homeroom_teacher_id = current_teacher_id()
  ) or exists (
    -- 任課教師：僅能寫入課表中指定自己教的節次
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

drop policy if exists homeroom_and_subject_teacher_write_attendance on attendance;

create policy homeroom_and_subject_teacher_write_attendance on attendance
  for all
  using (can_write_attendance(student_no, record_date, period_no, id))
  with check (can_write_attendance(student_no, record_date, period_no, id));
