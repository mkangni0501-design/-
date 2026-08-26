-- ============================================================
-- 學籍狀態變更（休學／退學／畢業／肄業）後，在成績登錄、出缺勤登錄、學生名冊等
-- 一般查詢畫面把該學生資料隱藏，只有管理員（admin_a／admin_b／system_admin_s）
-- 看得到。
--
-- 做法：用 restrictive policy 疊加在 enrollments／scores／attendance 三張表
-- 既有的 select/insert/update/delete 政策上面。restrictive 政策一定是跟其他
-- 政策「AND」起來，不會因為多加了一條而讓原本看得到的人變得看不到、也不需要去
-- 動、去理解前面 2policies.sql／15scores_write_permission_fix.sql／
-- 19department_rbac_refactor.sql／22department_policy_rewrite_complete.sql
-- 這些檔案裡已經寫好的（permissive）政策內容——這條只會再加一層「隱藏名單」濾掉。
--
-- 範圍只涵蓋 enrollments／scores／attendance 這三張表（對應「成績登錄」「出缺勤
-- 登錄」「學生名冊」三個畫面實際查詢/寫入的資料表）。students 本體不動，避免
-- 影響「學籍設定及查詢」「學生狀態變更」等本來就該讓管理員/承辦人查得到全部
-- 學生（含已離校）的既有管理畫面。
--
-- 需在 1schema.sql ~ 36teacher_letter_settings.sql 都執行過後再執行本檔。
-- ============================================================

-- ---------- 判斷某學生「目前最新」的學籍狀態 ----------
-- 取 student_status_changes 裡 effective_date 最新的一筆（同日期則取最後建立的那筆）；
-- 完全沒有任何狀態變更紀錄，視為「入學中、沒特殊狀態」，回傳 null。
create or replace function student_current_status(p_student_no text)
returns enrollment_status_type as $$
  select status
  from student_status_changes
  where student_no = p_student_no
  order by effective_date desc, created_at desc
  limit 1;
$$ language sql stable;

-- 這幾種狀態代表「目前不是現行在校生」，一般畫面要隱藏；
-- 「入學」「復學」不算隱藏（復學後應該要重新看得到）。
create or replace function student_is_hidden(p_student_no text)
returns boolean as $$
  select coalesce(
    student_current_status(p_student_no) in ('休學', '退學', '畢業', '肄業'),
    false
  );
$$ language sql stable;

-- ---------- enrollments（學生名冊頁等直接查這張表） ----------
drop policy if exists hide_status_changed_students_enrollments on enrollments;
create policy hide_status_changed_students_enrollments on enrollments
  as restrictive
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

-- ---------- scores（成績登錄頁；student_no 要透過 enrollment_id 反查） ----------
drop policy if exists hide_status_changed_students_scores on scores;
create policy hide_status_changed_students_scores on scores
  as restrictive
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden((select e.student_no from enrollments e where e.id = scores.enrollment_id))
  )
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden((select e.student_no from enrollments e where e.id = scores.enrollment_id))
  );

-- ---------- attendance（出缺勤登錄頁） ----------
drop policy if exists hide_status_changed_students_attendance on attendance;
create policy hide_status_changed_students_attendance on attendance
  as restrictive
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

-- ---------- 已知限制／建議下一步 ----------
-- 1. 這是 RLS 層級的隱藏：所有透過瀏覽器（anon key + 使用者登入 session，也就是
--    lib/supabaseClient.ts 這個 client）送出的查詢都會生效，包含現在 ScoresEntryTab.tsx、
--    attendance/weekly、attendance/mobile、attendance/subject-view、
--    StudentsRosterTab.tsx 這些畫面，不需要另外修改這些檔案的程式碼。
--    只有用 lib/supabaseAdmin.ts（service role，繞過 RLS）的後端 API（例如成績單
--    批次產生、備份/還原）不受影響——這是特意保留的，因為那些本來就是管理員才能
--    觸發的操作，需要能處理到已離校學生的歷史資料（例如幫已畢業學生補印成績單）。
-- 2. 管理員如果用畫面上「切換身分 ▾ → 教師視角」預覽，因為 current_role_name()
--    是直接查資料庫裡的帳號角色（不受畫面上 sessionStorage 的 viewMode 影響），
--    這條政策仍然會讓管理員看得到隱藏名單裡的學生。如果之後需要「教師視角預覽」
--    也完全比照一般教師看不到，需要另外討論怎麼把 viewMode 也傳進 RLS 判斷。
-- 3. 目前「學生狀態變更」頁（StudentsStatusChangeTab.tsx）只會寫入
--    student_status_changes，不會連動把 enrollments.is_current 改成 false，
--    所以座號不會自動釋放——這是另一個獨立的問題，不在本次「隱藏資料」的範圍內，
--    建議另外處理。
