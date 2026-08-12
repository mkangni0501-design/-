-- ============================================================
-- 第四階段補充：節次設定顯示、帳號角色編輯與密碼重製稽核
-- 需在 schema.sql / policies.sql 執行後再執行本檔
-- ============================================================

-- ---------- period_config：開放讀取，管理員可寫 ----------
alter table period_config enable row level security;

create policy read_period_config on period_config
  for select
  using (true);

create policy admin_write_period_config on period_config
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ---------- 帳號稽核紀錄：角色變更／密碼重製都留紀錄 ----------
create table account_audit_log (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references app_users(id) on delete cascade,
  action text not null check (action in ('role_change', 'password_reset')),
  old_value text,
  new_value text,
  changed_by uuid references app_users(id),
  changed_at timestamptz not null default now()
);

alter table account_audit_log enable row level security;

-- 只有管理員角色（S/A/B）可以查閱異動紀錄；寫入一律透過伺服器端 API（service role）處理，
-- 不開放前端直接 insert，避免有人偽造變更紀錄。
create policy admin_read_account_audit_log on account_audit_log
  for select
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
