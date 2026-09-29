-- ============================================================
-- 94. 修正【全校出缺席狀況總覽】讀取出缺勤統計又出現「讀取錯誤」
--     （sql/84 修過同一個逾時問題，這次是漏網的另一條政策）
-- ------------------------------------------------------------
-- 【根因】sql/84fix_school_attendance_overview_timeout.sql 已經把
-- attendance_read 政策用到的 can_read_attendance()、以及 attendance 表上的
-- hide_status_changed_students_attendance 限制型政策，改寫成
-- `(select 函式())` 的寫法，讓 Postgres 能把「跟這一列無關」的權限判斷只算一次，
-- 不用整張表每一列都重算。
--
-- 但 sql/47ranking_average_discipline_access_partial_report_card.sql 早在那之前，
-- 另外又加了一條「單獨給訓導部門」的許可型（permissive）政策：
--   create policy discipline_dept_read_attendance on attendance
--     for select using (has_department('discipline'::admin_department));
-- 這條政策完全沒有被 sql/84 一併改寫（沒有包 `(select ...)`）。attendance 表同一個
-- SELECT 動作上有兩條許可型政策（attendance_read／discipline_dept_read_attendance），
-- Postgres 會把兩條都各自掃過一次、用 OR 合併——只要其中一條沒有優化，訓導部門
-- 帳號查「全校出缺席狀況總覽」（student_absence_counts 這個 view，本質是對全校
-- attendance 表整張表 group by）還是會因為這條漏改的政策，每一列都重新呼叫一次
-- has_department()，逾時、被 Supabase 中止、前端顯示「讀取出缺勤統計失敗」——
-- 跟 sql/84 要修的是同一個逾時問題，只是換一條政策出現，不是新問題。
--
-- 另外這條政策本身也是多餘的：can_read_attendance()（sql/84 版本）第一個 OR 分支
-- 就已經是 `(select has_department('discipline'))`，訓導部門原本就會通過
-- attendance_read 政策，不需要 discipline_dept_read_attendance 這條額外政策
-- 提供的權限——它從頭到尾沒有多開放任何資料，純粹是重複、又拖垮效能，直接刪除
-- 最乾淨。
--
-- attendance_notifications 上同樣模式的 discipline_dept_read_attendance_notifications
-- 政策不是多餘的（訓導部門要看導師的處理紀錄，沒有其他政策涵蓋這個情境），這張表
-- 資料量遠小於 attendance、不是逾時主因，這裡保留，只是一併補上 `(select ...)`
-- 寫法，避免以後表變大又重蹈覆轍。
-- ============================================================

drop policy if exists discipline_dept_read_attendance on attendance;

drop policy if exists discipline_dept_read_attendance_notifications on attendance_notifications;
create policy discipline_dept_read_attendance_notifications on attendance_notifications
  for select
  using ((select has_department('discipline'::admin_department)));

-- 【順便修正】同一頁另一個查詢（enrollments，用來列出全校學生名冊、姓名、班級）
-- 的 staff_read_enrollments 政策（sql/70）只開放給 is_system_admin()／
-- has_department('academic')／導師本人／任課教師，沒有 has_department('discipline')。
-- 訓導部門帳號（非 admin_a/admin_b）查這頁時，上面的逾時問題修好後，enrollments
-- 這一步會被 RLS 過濾成幾乎空的名單（不是報錯，是安靜地查不到），全校總覽變成
-- 「查得到出缺勤節數統計、卻配不到對應的學生姓名/班級」，一樣是這頁看起來「壞掉」
-- 的原因之一。訓導部門本來就是這頁的主要使用者，補上這個條件。
drop policy if exists staff_read_enrollments on enrollments;
create policy staff_read_enrollments on enrollments
  for select
  using (
    (select is_system_admin()) or (select has_department('academic')) or (select has_department('discipline'))
    or exists (
      select 1 from classes c
      where c.id = enrollments.class_id and c.homeroom_teacher_id = (select current_teacher_id())
    )
    or exists (
      select 1 from class_schedule cs
      where cs.class_id = enrollments.class_id
        and cs.term = enrollments.term
        and cs.teacher_id = (select current_teacher_id())
    )
  );

notify pgrst, 'reload schema';
