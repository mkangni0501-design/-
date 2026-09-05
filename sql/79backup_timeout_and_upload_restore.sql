-- ============================================================
-- 79. 修正「手動備份：備份完成但寫入紀錄失敗：canceling statement due to
--     statement timeout」＋ 新增「上傳備份檔案還原」功能
-- 需在 17backups.sql、2policies.sql 執行過後再執行本檔
-- ------------------------------------------------------------
-- 【問題1 根因，已對照 lib/backupRestore.ts / app/api/admin/backup/create/route.ts
--  / app/api/cron/daily-backup/route.ts 確認過，不是憑空猜測】
-- runBackup() 會把 BACKUP_TABLES 裡幾十張表「目前全部」的資料（隨著開學年數、
-- 學生成績出缺勤紀錄累積，只會越用越大）撈齊、組成一個 JS 物件，最後用「一次」
-- `.insert({ kind, created_by, tables: <整包 JSON>, table_counts })` 寫進
-- backups.tables 這個 jsonb 欄位——也就是說，不管資料多大，寫入 backups 這張表
-- 永遠只有一個 SQL INSERT 陳述式要處理，欄位值可能好幾 MB 甚至更大（TOAST 壓縮
-- ＋寫入＋更新索引都算在同一個陳述式的執行時間內）。資料量夠大時，這一個 INSERT
-- 的執行時間會超過 Supabase 專案裡 PostgREST 使用的角色（service_role）的
-- statement_timeout，直接被資料庫取消，回傳「canceling statement due to
-- statement timeout」——這時候 runBackup() 其實已經整個跑完、資料也都撈齊了，
-- 只是「寫紀錄」這最後一步被砍掉，所以錯誤訊息開頭才會是「備份完成但寫入紀錄
-- 失敗」。而且這個「單一 INSERT 大小」只會隨資料量成長，不會自己變好。
--
-- 修法：新增 admin_insert_backup() 這個 function 來寫入 backups，靠 Postgres
-- 「function 層級的 SET」把『只有這個 function 執行期間』的 statement_timeout
-- 另外拉長成 10 分鐘，不影響其他一般查詢的逾時設定、也不用去改整個 service_role
-- 角色的全域設定。app/api/admin/backup/create/route.ts 與
-- app/api/cron/daily-backup/route.ts 的寫入都要改成呼叫這個 function（見對應的
-- .ts 檔修改）。
--
-- 【問題2】「還原」目前只能從 backups 這張表裡挑一筆現有紀錄來還原——如果是換了
-- 一個全新的 Supabase 專案、或這個環境的 backups 表本身還是空的（例如系統剛
-- 建置、還沒跑過備份），「備份與還原」畫面上就完全沒有東西可以選，就算手上還留著
-- 先前用「下載」按鈕從舊系統存下來的備份 JSON 檔，也沒有地方能用上，等於「新
-- 系統沒資料、又沒辦法拿舊備份救回來」。這裡新增「上傳檔案還原」：直接把下載
-- 下來的那份 JSON 檔上傳回來即可還原，不需要 backups 表裡先有對得上的紀錄。
--
-- 檔案本身走 Storage bucket 上傳，不是塞進 API 請求本文：Vercel Serverless
-- Function 的請求本文大小上限是 4.5MB，全校資料的備份檔很容易超過這個大小，直接
-- 塞進 API request body 送出去會整包被平台擋掉（413 錯誤），所以改成瀏覽器先把
-- 檔案直接傳到 Supabase Storage（不經過我們自己的 API，沒有 4.5MB 這個限制），
-- 還原 API 再用 service role 從 Storage 把檔案讀出來還原，還原後就把上傳的檔案
-- 從 Storage 刪掉（不管成功失敗都刪，避免佔用空間、也避免留著一份完整校務資料在
-- Storage 裡）。
-- ============================================================

-- ---------- 問題1：寫入備份紀錄改用「延長 statement_timeout」的 function ----------
create or replace function admin_insert_backup(
  p_kind text,
  p_created_by uuid,
  p_tables jsonb,
  p_table_counts jsonb
)
returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  return query
    insert into backups (kind, created_by, tables, table_counts)
    values (p_kind, p_created_by, p_tables, p_table_counts)
    returning backups.id, backups.created_at;
end;
$$;

-- 這個 function 本身不重新檢查呼叫者角色——「能不能備份/能不能還原」一律由
-- app/api/admin/backup/create、app/api/admin/backup/restore、
-- app/api/cron/daily-backup 這幾支 API route 先驗證過使用者角色（或 CRON_SECRET）
-- 才會執行到這裡，跟現有「手動備份」「還原」API 的把關方式一致。但還是把 EXECUTE
-- 權限收回、只留給 service_role，避免一般登入使用者的前端直接繞過 API 呼叫這個
-- function 亂寫 backups 這張表。
revoke all on function admin_insert_backup(text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function admin_insert_backup(text, uuid, jsonb, jsonb) to service_role;

-- backups.kind 原本只允許「自動」「手動」兩種，新增「上傳」，用來記錄「用上傳
-- 檔案還原」這個動作：把上傳的內容也存一份進 backups 表，一方面留稽核紀錄
-- （誰、什麼時候，用一份上傳的檔案做了還原），一方面上傳還原完成後，這份資料
-- 馬上就變成新系統裡「有」的第一筆備份紀錄，之後可以直接在清單上看到、下載、
-- 甚至再用它「還原」一次，不用每次都重新上傳檔案。
alter table backups drop constraint backups_kind_check;
alter table backups add constraint backups_kind_check check (kind in ('自動', '手動', '上傳'));

-- ---------- 問題2：上傳備份檔案用的 Storage bucket ----------
-- 私密 bucket（public = false）：備份內容等同全校學生資料，比照 backups 這張表
-- 本身「只有管理員角色能查閱、只有系統管理員S能執行還原」的權限模型，這裡也只
-- 開放 system_admin_s 上傳/讀取/刪除，其他角色（含 admin_a/admin_b）都不能存取
-- 這個 bucket——跟現有「只有系統管理員S可以執行還原」的規則對齊，因為上傳檔案
-- 本來就是「還原」的另一種入口，不應該比原本的還原功能更寬鬆。
insert into storage.buckets (id, name, public)
values ('backup-uploads', 'backup-uploads', false)
on conflict (id) do nothing;

create policy system_admin_s_write_backup_uploads on storage.objects
  for insert
  with check (bucket_id = 'backup-uploads' and current_role_name() = 'system_admin_s');

create policy system_admin_s_read_backup_uploads on storage.objects
  for select
  using (bucket_id = 'backup-uploads' and current_role_name() = 'system_admin_s');

create policy system_admin_s_delete_backup_uploads on storage.objects
  for delete
  using (bucket_id = 'backup-uploads' and current_role_name() = 'system_admin_s');
