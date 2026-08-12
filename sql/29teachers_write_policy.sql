-- ============================================================
-- teachers：補上查詢/寫入政策
-- ------------------------------------------------------------
-- 錯誤現象：「一鍵上傳」上傳「任課教師設定(現況)」「學校課表(現況)」「全校總課表(輸入)」時，
-- 遇到系統裡還沒有的老師姓名，程式會自動幫忙建立一筆新的 teachers 資料列，
-- 結果被擋下來：new row violates row-level security policy for table "teachers"。
--
-- 查了目前所有 migration 檔案（sql/1schema.sql 到 sql/27...），teachers 這張表
-- 從頭到尾都沒有寫過任何 RLS 政策──但錯誤訊息證實 RLS 目前確實是「開著」的
-- （不然不會出現這個錯誤訊息），推測是先前在 Supabase 後台手動開啟過 RLS、
-- 但沒有另外設定政策，導致沒有 service role 的一般連線（例如「一鍵上傳」這種
-- 從瀏覽器直接呼叫 Supabase 的操作）新增/修改都會被擋。查詢（select）之所以
-- 目前看起來還能動，多半是後台手動開過一條查詢政策，但這裡沒有紀錄可考，
-- 不能保證每個環境都一致，所以這裡明確補齊一份完整的政策，兩邊都不用再猜：
--   - 查詢：開放給所有已登入使用者（各頁面下拉選單、課表、成績等本來就要能查到老師姓名）。
--   - 新增／修改／刪除：只給管理者角色（帳號管理、任課教師設定、學校課表、
--     一鍵上傳、排課系統匯入這些會建立/修改老師資料的操作都只有管理者能用到）。
-- 用 drop policy if exists 是為了避免跟後台手動建立過的同名政策衝突，可以重複執行。
-- ============================================================

alter table teachers enable row level security;

drop policy if exists read_teachers on teachers;
create policy read_teachers on teachers for select using (true);

drop policy if exists admin_write_teachers on teachers;
create policy admin_write_teachers on teachers for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
