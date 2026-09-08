-- ============================================================
-- 83. 修正「學生名冊」點開學生後，任何教師都看得到完整個人資料
-- ------------------------------------------------------------
-- 反映事項：教師使用【學生名冊】點開學生後應該只能看到監護人電話，看不到其他
-- 資料；只有該生的班級導師才能看到自己班學生的完整個人資料。
--
-- 現況：components/admin-tabs/StudentsRosterTab.tsx 只要點開任一列，不分身分
-- 一律直接查 students 表整列（性別／泰文姓名／出生日期／身分證或護照號碼／
-- 國籍／宗教／血型／地址／電話／原就讀學校...），只要帳號能打開「學生名冊」
-- 這個頁面（任何教師登入即可，見 lib/adminModules.ts 的 '/admin/students/roster'）
-- 就看得到全部欄位，沒有依「是不是這個學生的導師」分流。
--
-- students／guardians 兩張表本身的 RLS（staff_read_students／
-- homeroom_and_admin_guardians）刻意留給「教務部門、這個學生的導師、教這個學生
-- 的任課教師」較大的讀取範圍，是因為那個範圍本來就有很多其他頁面（成績登錄、
-- 學籍設定…）需要用到學生基本資料，不能直接收緊，收緊會連帶弄壞那些頁面。
-- 這裡改成「學生名冊」這個頁面本身，改用專門的 RPC 只回傳監護人電話（不是整張
-- guardians 表、更不是 students 表其他欄位），開放給任何已登入教職員呼叫——
-- 跟原本「學生名冊」本來就開放任何教師瀏覽任一班級座號/姓名的設計一致，只是
-- 點開後從「顯示全部個資」限縮成「只給監護人電話」；真正完整資料仍然只透過
-- students／guardians 表原本的 RLS 規則（導師本班／教務部門／系統管理員）才讀得到。
-- ============================================================

-- ⚠️ 這裡不能只檢查 auth.uid() is not null：家長/學生登入（portal_accounts）
-- 走的也是同一個 Supabase auth，一樣會有 auth.uid()。只查「有沒有登入」的話，
-- 家長帳號就能拿別人小孩的學號呼叫這個函式、繞過「家長只能看自己小孩資料」的
-- 限制。教職員帳號一定會在 app_users 有一筆對應資料、portal_accounts 不會，
-- 用這個當作「是不是教職員」的判斷依據。
create or replace function guardian_phones_for_roster(p_student_no text)
returns table(relation text, name text, phone text) as $$
  select g.relation, g.name, g.phone
  from guardians g
  where g.student_no = p_student_no
    and exists (select 1 from app_users where id = auth.uid());
$$ language sql stable security definer;

revoke all on function guardian_phones_for_roster(text) from public, anon;
grant execute on function guardian_phones_for_roster(text) to authenticated;

notify pgrst, 'reload schema';
