-- ============================================================
-- 51. 家長／學生查詢入口：新增「是否啟用信箱驗證」開關
-- ------------------------------------------------------------
-- 背景：家長/學生登入原本是「輸入登入代碼＋信箱 → 系統寄一封驗證信 → 點信裡的連結
-- 完成登入」，這個機制需要伺服器能夠寄出Email、使用者的裝置也要能收到那封信──
-- 目前學校還在用區域網路（無法連到校外），這個「寄信、收信」的來回在這個環境下
-- 走不通，需要一個「先關掉驗證、輸入完登入代碼＋信箱就直接進入」的開關，等之後
-- 學校恢復對外連線，再打開驗證。
-- ============================================================

create table if not exists portal_login_settings (
  id boolean primary key default true,
  email_verification_enabled boolean not null default true,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint portal_login_settings_singleton check (id)
);

insert into portal_login_settings (id, email_verification_enabled)
values (true, true)
on conflict (id) do nothing;

alter table portal_login_settings enable row level security;

-- 登入頁本身在使用者還沒登入時就需要知道「要不要顯示驗證信步驟」，所以讀取要對
-- 所有人開放（沒有敏感內容，只是一個開關）；只有系統管理員或「開發人員」部門
-- 能修改（跟【開發人員區】頁面本身的權限判斷一致）。
drop policy if exists public_read_portal_login_settings on portal_login_settings;
create policy public_read_portal_login_settings on portal_login_settings
  for select
  using (true);

drop policy if exists dev_write_portal_login_settings on portal_login_settings;
create policy dev_write_portal_login_settings on portal_login_settings
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

notify pgrst, 'reload schema';
