-- ============================================================
-- 60. 教師/管理者信箱更換功能 ＋ 開發人員區「第一次登入強制改密碼」開關
-- ============================================================

-- ---------- 1. 信箱更換：帳號稽核紀錄新增 email_change 這個動作類型 ----------
alter table account_audit_log drop constraint if exists account_audit_log_action_check;
alter table account_audit_log add constraint account_audit_log_action_check
  check (action in ('role_change', 'password_reset', 'email_change'));

-- ---------- 2. 第一次登入強制改密碼 ----------
-- 開關本身（開發人員區可勾選是否開啟），跟 portal_login_settings 用同一套單例表格模式。
create table if not exists password_policy_settings (
  id boolean primary key default true,
  force_change_on_first_login boolean not null default false,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint password_policy_settings_singleton check (id)
);

insert into password_policy_settings (id, force_change_on_first_login)
values (true, false)
on conflict (id) do nothing;

alter table password_policy_settings enable row level security;

-- 登入流程本身（使用者剛登入、還在判斷要不要導去「請先改密碼」畫面）需要讀得到
-- 這個開關，所以讀取對所有登入者開放；只有系統管理員或「開發人員」部門能修改，
-- 跟 portal_login_settings 的權限設計一致。
drop policy if exists staff_read_password_policy_settings on password_policy_settings;
create policy staff_read_password_policy_settings on password_policy_settings
  for select
  using (true);

drop policy if exists dev_write_password_policy_settings on password_policy_settings;
create policy dev_write_password_policy_settings on password_policy_settings
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

-- 每個帳號自己是否「下次登入要先改密碼」的旗標：開關開啟時，新邀請/新建立的帳號
-- （app/api/admin/invite-user）會把這個設成 true；使用者登入後被導去改密碼、且
-- 真的改成功，這個旗標會被清成 false，之後正常登入。
alter table app_users add column if not exists must_change_password boolean not null default false;

notify pgrst, 'reload schema';
