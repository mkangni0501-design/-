-- 家長／學生查詢入口改用「手機號碼」登入，不再需要信箱。
--
-- 對應反映事項「學生與家長登入不用信箱，改成存自動抓取學籍資料中的學生、家長手機
-- 號碼」：登入時直接比對 students.phone（學生本人代碼）／guardians.phone（家長
-- 代碼，該學生底下任一位監護人的電話都算數），不用另外維護一份 email；也不用
-- 管理員先手動幫每個學生建立帳號——第一次用「登入代碼＋手機號碼」核對成功時，
-- 系統會自動建立/更新 portal_accounts 這筆綁定紀錄。
--
-- email 欄位保留但改成可以是 NULL（舊資料、或極少數還沒補手機號碼、暫時還是用
-- 信箱在用的帳號，不強制搬家），登入邏輯本身已經完全不看這個欄位。
alter table portal_accounts alter column email drop not null;

-- 建帳號時不再要求一定要先有 email，insert 政策維持原樣（管理員/導師可建），
-- 但實務上新帳號現在都是由 app/api/portal/request-login 這支 API（用 service role）
-- 在登入當下自動 upsert，不會再經過這條 RLS insert 政策；沿用舊政策純粹是保留手動
-- 建立/除錯用的後路，不影響前台自動登入流程。
