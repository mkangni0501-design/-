-- ============================================================
-- 系統文字管理（scoped）＋ 全站設定（背景音樂網址等）＋ 音樂上傳用的儲存空間
-- 需在 1schema.sql、2policies.sql 執行過後再執行本檔
-- ------------------------------------------------------------
-- 【範圍說明】這裡先只涵蓋目前已經接上這套機制的文字（六個分類說明＋成績登錄／
-- 出缺勤登錄／出席查詢這幾頁的說明文字），不是系統裡「每一句文字」——要做到那樣，
-- 需要把幾十個檔案裡寫死的中文字都改成從這裡讀，是很大一次重構，這份先建立機制、
-- 涵蓋一部分，之後可以照同樣做法逐步把其他頁面的文字也接進來。
-- ============================================================

-- ---------- 文字內容（key → 目前顯示的文字） ----------
create table if not exists site_content (
  content_key text primary key,   -- 例如 category_hint.academic、page_hint.scores_entry
  content_value text not null,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now()
);

alter table site_content enable row level security;

create policy staff_read_site_content on site_content
  for select
  using (current_role_name() is not null);

create policy system_admin_write_site_content on site_content
  for insert
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_update_site_content on site_content
  for update
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_delete_site_content on site_content
  for delete
  using (current_role_name() = 'system_admin_s');

-- ---------- 全站設定（目前只用來存背景音樂網址／檔名，之後有其他全站開關也可以放這） ----------
create table if not exists site_settings (
  setting_key text primary key,   -- 例如 background_music_url、background_music_filename
  setting_value text,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now()
);

alter table site_settings enable row level security;

create policy staff_read_site_settings on site_settings
  for select
  using (current_role_name() is not null);

create policy system_admin_write_site_settings on site_settings
  for insert
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_update_site_settings on site_settings
  for update
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

create policy system_admin_delete_site_settings on site_settings
  for delete
  using (current_role_name() = 'system_admin_s');

-- ---------- 背景音樂檔案的儲存空間 ----------
-- 比照 student-documents 那個 bucket 的用法（見 components/admin-tabs/StudentsNewTab.tsx），
-- 這裡另外開一個 site-assets，設成公開讀取（背景音樂本來就是要讓所有登入的人都能播放，
-- 不是敏感資料），只有系統管理員S能上傳/更換/刪除。
insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;

create policy public_read_site_assets on storage.objects
  for select
  using (bucket_id = 'site-assets');

create policy system_admin_write_site_assets on storage.objects
  for insert
  with check (bucket_id = 'site-assets' and current_role_name() = 'system_admin_s');

create policy system_admin_update_site_assets on storage.objects
  for update
  using (bucket_id = 'site-assets' and current_role_name() = 'system_admin_s')
  with check (bucket_id = 'site-assets' and current_role_name() = 'system_admin_s');

create policy system_admin_delete_site_assets on storage.objects
  for delete
  using (bucket_id = 'site-assets' and current_role_name() = 'system_admin_s');
