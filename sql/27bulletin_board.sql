-- ============================================================
-- 27. 公佈欄（首頁登入卡片上方，未登入也看得到最新消息）
-- 需在 sql/ 資料夾至 26fix_department_recursion_and_module_visibility.sql
-- 都執行過後再執行本檔
-- ============================================================

create table if not exists bulletin_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  thumbnail_url text,
  content text not null default '',
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bulletin_posts enable row level security;

-- 首頁在「登入之前」就要顯示最新公告縮圖，所以已發布的文章要開放給還沒登入的人（anon）也讀得到。
-- 未發布（草稿）只有系統管理員/管理員自己看得到，不會外流。
create policy public_read_published_posts on bulletin_posts
  for select
  using (is_published = true or current_role_name() = any (array['system_admin_s', 'admin_a', 'admin_b']::user_role[]));

create policy admin_manage_posts on bulletin_posts
  for all
  using (current_role_name() = any (array['system_admin_s', 'admin_a', 'admin_b']::user_role[]))
  with check (current_role_name() = any (array['system_admin_s', 'admin_a', 'admin_b']::user_role[]));

-- 確保匿名（未登入）角色也有基本的資料表讀取權限，RLS 才有機會生效
-- （若您的 Supabase 專案已經對 public schema 的表統一開放過 select，這兩行會是多餘但無害的重複授權）
grant select on bulletin_posts to anon;
grant select, insert, update, delete on bulletin_posts to authenticated;
