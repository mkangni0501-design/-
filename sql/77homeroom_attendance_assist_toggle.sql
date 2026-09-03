-- ============================================================
-- 77. 開發人員區新增開關：【同意由導師協助任課教師點名】
-- ------------------------------------------------------------
-- 需求（本輪反映事項 1）：開發人員區增加一個勾選功能，勾選（開啟）後，導師在
-- 「學生出缺席登錄（一週）」頁面，即使該節不是自己任教的科目，也可以把顯示
-- 「出席」的學生修正為「事假」／「病假」／「公假」——用於任課教師點名當下
-- 還不知道學生請假（例如家長事後才打電話請假），導師事後協助更正的情境。
--
-- 現況（sql/9attendance_window_open_requests.sql 的 can_write_attendance()）：
-- 導師對自己班級所有學生的出缺勤，資料庫層級其實本來就有完整寫入權限（不限
-- 節次、不限狀態）——這個開關**不是**、也不需要用來鬆綁資料庫權限。真正的限制
-- 是「學生出缺席登錄（一週）」頁面前端自己刻意收得比資料庫更嚴（見該頁
-- isAllowedNonTeachingChange()）：非任教節次目前只開放「曠課→事假／病假／公假」，
-- 「出席」一律唯讀，理由是不希望導師在沒有學校政策共識的情況下，隨意覆蓋任課
-- 教師當下記錄的「出席」。這裡新增的開關，就是讓學校自己決定要不要正式放行
-- 「出席→事假／病假／公假」這條路——開關本身只是「前端要不要多開放這個選項」
-- 的旗標，沿用 sql/66 的 attendance_score_display_settings、sql/65 的
-- teacher_login_home_settings 同一種「單例設定表」模式。
-- ============================================================

create table if not exists homeroom_attendance_assist_settings (
  id boolean primary key default true,
  allow_present_to_leave boolean not null default false, -- 同意由導師協助任課教師點名：開啟後導師可把非任教節次的「出席」改成事假/病假/公假
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint homeroom_attendance_assist_settings_singleton check (id)
);

insert into homeroom_attendance_assist_settings (id, allow_present_to_leave)
values (true, false)
on conflict (id) do nothing;

alter table homeroom_attendance_assist_settings enable row level security;

-- 「學生出缺席登錄（一週）」頁面所有登入的教職員都要讀得到這個開關，才能正確
-- 決定非任教節次要不要多開放「出席→事假/病假/公假」這個選項。
drop policy if exists staff_read_homeroom_attendance_assist_settings on homeroom_attendance_assist_settings;
create policy staff_read_homeroom_attendance_assist_settings on homeroom_attendance_assist_settings
  for select
  using (auth.uid() is not null);

-- 只有系統管理員或「開發人員」部門能修改，跟 attendance_score_display_settings／
-- teacher_login_home_settings 的權限設計一致。
drop policy if exists dev_write_homeroom_attendance_assist_settings on homeroom_attendance_assist_settings;
create policy dev_write_homeroom_attendance_assist_settings on homeroom_attendance_assist_settings
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

notify pgrst, 'reload schema';
