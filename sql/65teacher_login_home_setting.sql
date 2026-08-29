-- ============================================================
-- 65. 開發人員區新增「教師登入首頁」設定
-- ------------------------------------------------------------
-- 對應反映事項「開發人員區增加一個教師登入首頁設定功能，這樣日後要調整大家登入後
-- 首頁比較方便（目前為教師主選單）」：教師用「教師」卡片登入後目前一律被導去
-- /admin（教師功能目錄，也就是反映事項講的「教師主選單」），這裡把這個目的地
-- 改成可以在開發人員區設定，不用之後要調整還得改程式碼重新部署。單例表格模式跟
-- password_policy_settings／portal_login_settings 一致。
-- ============================================================

create table if not exists teacher_login_settings (
  id boolean primary key default true,
  home_path text not null default '/admin',
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint teacher_login_settings_singleton check (id)
);

insert into teacher_login_settings (id, home_path)
values (true, '/admin')
on conflict (id) do nothing;

alter table teacher_login_settings enable row level security;

-- 登入流程（app/page.tsx 教師卡片登入成功那一刻）需要讀得到這個設定才能決定要導去哪，
-- 那時候使用者剛登入、還沒有任何部門/角色可言，所以讀取一律開放給任何已登入者。
drop policy if exists staff_read_teacher_login_settings on teacher_login_settings;
create policy staff_read_teacher_login_settings on teacher_login_settings
  for select
  using (true);

-- 只有系統管理員或「開發人員」部門能修改，跟 password_policy_settings 的權限設計一致。
drop policy if exists dev_write_teacher_login_settings on teacher_login_settings;
create policy dev_write_teacher_login_settings on teacher_login_settings
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

notify pgrst, 'reload schema';
