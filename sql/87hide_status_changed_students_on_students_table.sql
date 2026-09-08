-- ============================================================
-- 87. 修正「已完成休學、轉學、退學的學生，導師及任課教師點名、成績等
--     相關畫面還看得到」
-- ------------------------------------------------------------
-- 反映事項：學籍資料已經完成休學、轉學、退學的學生，目前導師及任課教師點名、
-- 成績等相關都還能看到他們，請隱藏。
--
-- 【查證結果】sql/37hide_status_changed_students.sql（後來 sql/62 更新過
-- student_is_hidden() 把「轉學」也算進去）已經對 enrollments／scores／
-- attendance 這三張表都加上了「隱藏名單」的 restrictive 政策，一般教師（非
-- 管理員）查這三張表時，狀態變成休學/轉學/退學/畢業/肄業的學生本來就應該
-- 整列查不到。逐一檢查點名、出缺勤、成績登錄相關頁面的查詢邏輯，也都是先查
-- enrollments（會被上述政策擋住）才回頭查學生姓名，設計上是對的。
--
-- 沒有查到單一、確定的漏洞點，但發現一個確定存在、範圍更廣的缺口：students
-- 這張表本身，從來沒有加過這個「隱藏名單」的 restrictive 政策——只有
-- enrollments／scores／attendance 三張表有。而 app 裡有好幾個頁面
-- （app/(app)/attendance/report、admin/students/portal-accounts、
-- admin/students/documents、admin/clubs、reports/attendance-unlock-requests…）
-- 會直接查 students 表。只要任何一個地方查 students 時沒有先透過已受保護的
-- enrollments 篩選過名單（或篩選方式將來改寫時不小心漏掉這一步），這張表本身
-- 完全沒有防線、狀態異動的學生一樣查得到——這很可能就是反映事項的根因，而且
-- 就算不是唯一根因，這也是無論如何都應該補上的一層防護，不用等到抓出「到底是
-- 哪個頁面」才能修。
--
-- 【修法】比照 enrollments／scores／attendance 三張表，直接在 students 本身
-- 也加上同一種 restrictive 政策：非管理員查詢時，狀態是休學/轉學/退學/畢業/
-- 肄業的學生整列查不到。家長/學生登入（portal）目前對這三張表也是同樣被這個
-- 政策擋住（current_role_name() 對 portal 帳號是 null，不會落入管理員例外），
-- 這裡維持一致，不額外開後門。
-- ============================================================

drop policy if exists hide_status_changed_students_students on students;
create policy hide_status_changed_students_students on students
  as restrictive
  using (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

notify pgrst, 'reload schema';
