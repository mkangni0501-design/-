-- ============================================================
-- 97. 修正「備份失敗：未知錯誤」——備份改成大檔案走 Storage，不再塞進單一 RPC 請求
-- ------------------------------------------------------------
-- 反映事項：「備份失敗：未知錯誤」。
--
-- 【根因】runBackup() 現在要備份的資料表已經累積到 65 張以上（sql/28～sql/95
-- 陸續加入的功能，每一輪都有把新增的表補進 BACKUP_TABLES），把全校資料（含
-- attendance、scores、conduct_events 這幾張本來就會隨學期累積很多列的表）整包
-- 組成一個 JS 物件後，是直接當成 `p_tables` 這個 jsonb 參數，透過
-- supabaseAdmin.rpc('admin_insert_backup', ...) 一次送給 PostgREST。這個 JSON
-- 大小只會隨資料量、隨表越加越多持續成長，一旦超過 PostgREST／底層 HTTP 用戶端
-- 能處理的單次請求大小，會在網路層直接失敗——這種失敗不一定會有正常的
-- `.message`（可能是連線被中斷、或用戶端拋出一個沒有標準欄位的例外），這條路徑
-- 最後就落到 catch 區塊的 `e.message ?? '未知錯誤'`，使用者只會看到「未知錯誤」，
-- 沒有任何線索。
-- 這正是 sql/79backup_timeout_and_upload_restore.sql 當初處理「上傳檔案還原」
-- 時就已經遇過、也解決過的同一類問題（那裡的解法是：檔案先直接上傳到 Storage，
-- 不經過我們自己 API 的請求本文）——只是這次換成「建立備份」這個方向也需要
-- 同樣的處理，之前沒有一併套用。
--
-- 【修法】
-- 1. backups 表新增 storage_path 欄位、tables 欄位改成可為 null：資料量小的
--    備份還是照舊把內容直接存進 tables；資料量大的備份改成先把 JSON 上傳到
--    Storage，backups 這一列只存放檔案路徑（storage_path），下載/還原時再從
--    Storage 讀出實際內容——判斷「大不大」、實際上傳的邏輯在
--    lib/backupRestore.ts 的 insertBackupSnapshot()。
-- 2. admin_insert_backup() 多一個 p_storage_path 參數（預設 null，兩種舊的呼叫
--    方式不用改就能繼續動作）。
-- ============================================================

alter table backups alter column tables drop not null;
alter table backups add column if not exists storage_path text;
alter table backups add constraint backups_tables_or_storage_chk check (tables is not null or storage_path is not null);

create or replace function admin_insert_backup(
  p_kind text,
  p_created_by uuid,
  p_tables jsonb,
  p_table_counts jsonb,
  p_storage_path text default null
)
returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  return query
    insert into backups (kind, created_by, tables, table_counts, storage_path)
    values (p_kind, p_created_by, p_tables, p_table_counts, p_storage_path)
    returning backups.id, backups.created_at;
end;
$$;

-- 備份快照檔案（大檔案才會用到）用同一個 backup-uploads bucket 存放，路徑加
-- snapshots/ 前綴跟「上傳還原」的檔案（使用者自己上傳的路徑）分開。這個方向的
-- 讀寫一律由伺服器端 API（service role）處理，不需要另外開放 RLS 給任何角色
-- 直接從瀏覽器存取這個 bucket。
