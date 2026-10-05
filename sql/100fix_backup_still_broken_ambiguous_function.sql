-- ============================================================
-- 100. 修正「備份功能仍無法使用（自動及手動都不行）」
-- ------------------------------------------------------------
-- 【根因】sql/97fix_backup_creation_unknown_error.sql 幫 admin_insert_backup()
-- 多加了一個 p_storage_path 參數（有預設值 null），用的是
-- `create or replace function admin_insert_backup(p_kind, p_created_by,
--  p_tables, p_table_counts, p_storage_path default null)`。
--
-- 但 Postgres 的 `create or replace function` 只有在「參數個數與型別完全相同」
-- 時才會真的取代舊函式；sql/79backup_timeout_and_upload_restore.sql 原本定義的
-- 是 4 個參數的版本（p_kind, p_created_by, p_tables, p_table_counts，沒有第5個
-- 參數），參數個數不一樣，所以 sql/97 的 create or replace 並沒有取代掉它，而是
-- 另外多建立了一個「重載」（overload）的新函式——資料庫裡同時存在兩個同名函式：
--   admin_insert_backup(text, uuid, jsonb, jsonb)                — sql/79 舊版
--   admin_insert_backup(text, uuid, jsonb, jsonb, text default null) — sql/97 新版
-- lib/backupRestore.ts 的 insertBackupSnapshot() 在「資料量小、直接存」這條路徑
-- （也就是平常最常見、一定會走到的那條路）呼叫時只帶 4 個參數（沒有帶
-- p_storage_path），這剛好同時符合「舊版的4參數函式」跟「新版5參數函式用預設值
-- 頂上第5個參數」兩種情況——PostgreSQL 沒辦法自己判斷要呼叫哪一個，會直接報錯
-- 「function admin_insert_backup(text, uuid, jsonb, jsonb) is not unique」，
-- 不管自動備份還是手動備份，只要是資料量小、走這條最常見路徑，一律失敗——這才
-- 是「備份功能仍無法使用，自動及手動都不行」的根因，也是上一輪新增這個參數時
-- 沒有一併處理乾淨的疏漏。
--
-- 【修法】把舊的4參數版本明確 drop 掉，資料庫裡只留 sql/97 那個5參數（帶預設值）
-- 的版本，4個參數或5個參數呼叫都只會對應到唯一一個函式，不會再有歧義。
-- ============================================================

drop function if exists admin_insert_backup(text, uuid, jsonb, jsonb);

notify pgrst, 'reload schema';
