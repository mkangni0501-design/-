-- ============================================================
-- 管理後台首頁「教務／訓導／總務」自訂分類
-- 需在 schema.sql、policies.sql 執行後再執行本檔
-- ------------------------------------------------------------
-- 功能模組本身（網址、名稱）寫死在前端程式碼（lib/adminModules.ts），
-- 這張表只存「某個模組目前被拖到哪一區」，讓系統管理員S用畫面上的
-- 「修正」按鈕調整分類後，全校所有管理員登入都看到同一套分類結果。
-- 尚未執行本檔、或表格是空的之前，畫面會自動使用程式碼內建的預設分類，
-- 不會壞掉，可以晚點再執行這份 SQL。
-- ============================================================

create table if not exists admin_module_categories (
  module_key text primary key,        -- 對應功能模組的網址，例如 /admin/accounts
  category text not null check (category in ('academic', 'discipline', 'general')), -- academic=教務 / discipline=訓導 / general=總務
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now()
);

alter table admin_module_categories enable row level security;

-- 所有已登入的校務人員都可以讀取分類結果（決定首頁怎麼排版）
create policy staff_read_module_categories on admin_module_categories
  for select
  using (current_role_name() is not null);

-- 只有系統管理員S可以新增／調整分類（對應「修正」按鈕只給 S 用）
create policy system_admin_write_module_categories on admin_module_categories
  for insert
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_update_module_categories on admin_module_categories
  for update
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_delete_module_categories on admin_module_categories
  for delete
  using (current_role_name() = 'system_admin_s');
