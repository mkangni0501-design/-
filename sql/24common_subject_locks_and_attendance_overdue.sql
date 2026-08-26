-- ============================================================
-- 第二期 SQL：
--   ① 共同科目時間鎖定（先鎖定不排課）
--   ④ 出缺席示警設定補齊兩項：缺曠課扣考次數門檻、出缺登記逾期天數（超過幾天不能補登，需個別申請開放）
--
-- 執行順序：schema.sql → policies.sql → ... → 01 → 02 → 03 → 04 → 05 → 本檔(06)
-- ============================================================

-- ============================================================
-- 一、共同科目時間鎖定
-- ============================================================
-- 教務可以設定「某個範圍（全校/部別/班級）某星期某節」鎖定給共同科目使用
-- （例如：升旗、朝會、班會、聯課活動），這個時段【自動排課工具】不會排入一般課程。
-- 這裡只負責「鎖定」跟「記錄鎖定的科目名稱」，共同科目本身怎麼上課不由本系統安排。
create table if not exists locked_periods (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  scope text not null check (scope in ('全校', '部別', '班級')),
  scope_ref text,                     -- 部別名稱或 class_id，scope='全校' 時為 null
  weekday int not null check (weekday between 1 and 6),
  period_no int not null,
  subject text not null,              -- 共同科目名稱（例如：朝會、班會）
  note text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (academic_year, term, scope, scope_ref, weekday, period_no)
);

alter table locked_periods enable row level security;

-- 所有登入使用者都能讀（排課工具、課表查詢都需要知道哪些時段被鎖定）
create policy read_locked_periods on locked_periods
  for select
  using (auth.uid() is not null);

-- 直接寫入：教務主管(lead)或系統管理員S
create policy department_lead_write_locked_periods on locked_periods
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

-- 登記進送審白名單，讓教務承辦人員(staff)也能透過送審機制新增/修改/刪除
insert into governed_tables (table_name, primary_key_column, department, description) values
  ('locked_periods', 'id', 'academic', '共同科目時間鎖定')
on conflict (table_name) do nothing;


-- ============================================================
-- 二、出缺席示警設定：補上「缺曠課扣考次數門檻」「出缺登記逾期天數」
-- ============================================================
alter table attendance_alert_settings
  add column if not exists exam_deduction_absence_threshold int,
  -- 事假+病假+曠課 累計節數達到這個值，代表可能觸及「扣考」資格，僅供訓導處/導師參考、
  -- 目前不會自動擋下報名或成績登錄，實際是否扣考仍由訓導處人工審查認定。
  add column if not exists backfill_overdue_days int not null default 7;
  -- 出缺席登記表：距離上課日超過這個天數還沒登錄／要修改，一律視為逾期，
  -- 導師/任課教師無法再自行補登或修改，需送「出缺勤鎖定開放申請」給訓導核准。

comment on column attendance_alert_settings.exam_deduction_absence_threshold is
  '事假+病假+曠課累計節數達到此門檻，視為可能觸及扣考資格（僅供提醒，實際扣考由訓導處人工認定）';
comment on column attendance_alert_settings.backfill_overdue_days is
  '出缺席記錄距上課日超過幾天視為逾期，逾期需送「開放申請」才能補登/修改';

-- ---------- 依「逾期天數」自動判斷是否鎖定（取代原本只看 submission_windows.is_locked 的判斷） ----------
-- 原本 attendance_locked() 只檢查該班有沒有被管理員手動整班鎖定（submission_windows）。
-- 這裡擴充：只要「記錄日期」距離今天超過設定的 backfill_overdue_days，也視為鎖定，
-- 即使管理員沒有手動鎖定該班，一樣要走「開放申請」才能補登/修改。
create or replace function attendance_locked(p_student_no text, p_record_date date)
returns boolean as $$
  select
    (
      -- 條件一（沿用原本邏輯）：該班被管理員手動整班鎖定
      exists (
        select 1
        from submission_windows sw
        join enrollments e on e.student_no = p_student_no
        join classes c on c.id = e.class_id
        where sw.data_type = '出缺勤'
          and sw.scope = '班級'
          and sw.scope_ref = c.id::text
          and sw.is_locked = true
      )
    )
    or
    (
      -- 條件二（本次新增）：記錄日期已超過逾期天數，自動視為鎖定
      p_record_date < (current_date - (
        select coalesce(backfill_overdue_days, 7) from attendance_alert_settings where id = 1
      ))
    );
$$ language sql stable;

-- ---------- 供訓導處查看：目前累計節數已達「扣考門檻」的學生名單（僅供參考，不自動限制任何操作） ----------
create view students_exceeding_exam_deduction_threshold
with (security_invoker = true)
as
select sac.student_no, sac.absence_periods
from student_absence_counts sac
where sac.absence_periods >= (
  select exam_deduction_absence_threshold from attendance_alert_settings where id = 1
)
and (select exam_deduction_absence_threshold from attendance_alert_settings where id = 1) is not null;
