-- ============================================================
-- 管理後台首頁功能卡片「上下位置」排序
-- 需在 1schema.sql、2policies.sql（以及已經有的
-- 11module_categories.sql）執行過後再執行本檔
-- ------------------------------------------------------------
-- 功能模組本身（網址、名稱、預設分類）寫死在前端程式碼（lib/adminModules.ts），
-- ALL_MODULES 陣列本身的順序就是「程式碼內建的預設排序」。這張表只存
-- 「某個模組目前排在第幾順位」，讓系統管理員S用畫面上的排序功能（▲▼）調整後，
-- 全校所有人登入都看到同一套順序——跟 admin_module_categories／分類調整
-- 是完全一樣的做法，只是這裡存的是排序數字而不是分類。
-- 尚未執行本檔、或表格是空的之前，畫面會自動使用程式碼內建的預設順序，
-- 不會壞掉，可以晚點再執行這份 SQL。
-- ============================================================

create table if not exists admin_module_order (
  module_key text primary key,        -- 對應功能模組的網址，例如 /admin/accounts
  sort_order int not null,            -- 數字越小排越前面；同一批儲存時直接照畫面上目前的順序給 0,1,2...
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now()
);

alter table admin_module_order enable row level security;

-- 所有已登入的校務人員都可以讀取排序結果（決定首頁怎麼排版）
create policy staff_read_module_order on admin_module_order
  for select
  using (current_role_name() is not null);

-- 只有系統管理員S可以調整排序（對應畫面上排序功能只給 S 用）
create policy system_admin_write_module_order on admin_module_order
  for insert
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_update_module_order on admin_module_order
  for update
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_delete_module_order on admin_module_order
  for delete
  using (current_role_name() = 'system_admin_s');
