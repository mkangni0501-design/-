-- ============================================================
-- 06. 修正部門政策無限遞迴 ＋ 管理後台六大分類 ＋ 帳號個別可見內容調整
-- 需在 sql/ 資料夾至 25general_affairs_five_tables.sql 都執行過後再執行本檔
-- ============================================================


-- ============================================================
-- ① 修正 app_user_departments 的 RLS 無限遞迴
-- ------------------------------------------------------------
-- 問題：19department_rbac_refactor.sql 建立的 read_own_or_department_lead
-- 政策，USING 子句裡用 EXISTS 查詢「自己這張表」（app_user_departments）；
-- Postgres 檢查這個子查詢時，又必須先套用同一條 SELECT 政策才能決定子查詢
-- 看不看得到那些列，於是無窮迴圈，出現：
--   infinite recursion detected in policy for relation "app_user_departments"
-- has_department() / is_department_lead() 這兩個輔助函式也一樣會查
-- app_user_departments，且沒有下 security definer，只要「任何一張表」的政策
-- 呼叫到這兩個函式，就會連帶觸發同一個無窮迴圈（這就是帳號管理頁「清除舊部門
-- 職務失敗」的真正原因）。
--
-- 修法：讓「查自己這張表」這件事改用 security definer 函式執行。
-- security definer 函式以建立者（superuser，例如 Supabase 的 postgres 角色）
-- 的身分執行，postgres 角色本身有 bypassrls，函式內部的查詢不會再去套用
-- app_user_departments 的 RLS 政策，也就不會再遞迴回來檢查政策本身。
-- ============================================================

drop policy if exists read_own_or_department_lead on app_user_departments;

create or replace function is_department_lead_of(p_department admin_department) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from app_user_departments
    where app_user_id = auth.uid()
      and department = p_department
      and level = 'lead'
  );
$$;

create policy read_own_or_department_lead on app_user_departments
  for select
  using (
    current_role_name() = 'system_admin_s'
    or app_user_id = auth.uid()
    or is_department_lead_of(department)
  );

-- has_department()／is_department_lead() 補上 security definer，
-- 避免被「其他資料表」的政策呼叫時，一樣觸發 app_user_departments 政策的遞迴檢查。
create or replace function has_department(p_dept admin_department) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from app_user_departments
    where app_user_id = auth.uid() and department = p_dept
  );
$$;

create or replace function is_department_lead(p_dept admin_department) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from app_user_departments
    where app_user_id = auth.uid() and department = p_dept and level = 'lead'
  );
$$;

-- system_admin_manage_departments（帳號管理頁「儲存」按鈕用的政策）本身沒有查
-- app_user_departments 自己，不受這個問題影響，不需要修改，這裡列出來只是方便核對：
--   create policy system_admin_manage_departments on app_user_departments
--     for all
--     using (current_role_name() = 'system_admin_s')
--     with check (current_role_name() = 'system_admin_s');


-- ============================================================
-- ② 管理後台首頁分類：從「教務／訓導／總務」三大區塊擴充成六大區塊
-- ------------------------------------------------------------
-- 新增「教師」「家長／學生」「開發人員」三個分類，對應
-- lib/adminModules.ts 的 ModuleCategory 型別擴充。
-- ============================================================

alter table admin_module_categories drop constraint if exists admin_module_categories_category_check;
alter table admin_module_categories add constraint admin_module_categories_category_check
  check (category in ('academic', 'discipline', 'general', 'teacher', 'parent_student', 'dev'));

-- 同一個功能現在可以同時掛在多個分類下（例如「成績相關設定及查詢」同時出現在教務／教師兩區），
-- 原本 module_key 是主鍵、一個模組只能對到一列，這裡改成 (module_key, category) 複合唯一鍵，
-- 允許同一個 module_key 出現多列。
alter table admin_module_categories drop constraint if exists admin_module_categories_pkey;
alter table admin_module_categories add column if not exists id uuid default gen_random_uuid();
update admin_module_categories set id = gen_random_uuid() where id is null;
alter table admin_module_categories alter column id set not null;
alter table admin_module_categories add primary key (id);
alter table admin_module_categories drop constraint if exists admin_module_categories_module_key_category_key;
alter table admin_module_categories add constraint admin_module_categories_module_key_category_key unique (module_key, category);


-- ============================================================
-- ③ 帳號個別可見內容調整（系統管理員S專用）
-- ------------------------------------------------------------
-- 預設情況下，某帳號看不看得到某功能，是由「角色」＋「部門職務」決定的通則。
-- 這張表讓系統管理員S可以再對「單一帳號」做例外調整——
-- 多開放一個功能給某人、或刻意把某個功能從某人畫面上藏起來——
-- 不影響其他同角色/同部門的所有人。
-- ============================================================

create table if not exists app_user_module_overrides (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references app_users(id) on delete cascade,
  module_key text not null,
  visible boolean not null,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  unique (app_user_id, module_key)
);

alter table app_user_module_overrides enable row level security;

-- 只有系統管理員S可以新增/調整/刪除任何人的例外設定
create policy system_admin_manage_module_overrides on app_user_module_overrides
  for all
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

-- 本人可以讀到自己被設定了哪些例外（畫面才知道要多顯示/隱藏哪些功能）
create policy read_own_module_overrides on app_user_module_overrides
  for select
  using (current_role_name() = 'system_admin_s' or app_user_id = auth.uid());
