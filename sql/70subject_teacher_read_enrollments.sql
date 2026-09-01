-- ============================================================
-- 70. 修正任課教師看不到「非自己導師班」學生名單的問題
-- ------------------------------------------------------------
-- 反映事項：「請用李白雲教師帳號測試任課教師登錄學生出缺表，...她進去三年級
-- 其他班級都看不到任何學生，只能看到自己班的」。
--
-- 根因：enrollments（學籍/在班紀錄）表的 staff_read_enrollments 讀取政策
-- （sql/22department_policy_rewrite_complete.sql）只開放給：
--   系統管理員 / 教務處成員 / 該班「導師」（homeroom_teacher_id = 自己）
-- 完全沒有開放給「該班任課教師」——但 attendance（出缺勤紀錄）表本身的寫入政策
-- can_write_attendance()（sql/9attendance_window_open_requests.sql）其實已經
-- 正確允許任課教師寫入自己任教節次的出缺勤紀錄。
-- 這造成任課教師登錄出缺勤時，attendance 資料表寫得進去，但前端要先查
-- enrollments 才能列出「這個班有哪些學生、座號幾號」——這一步在資料庫端就被
-- RLS 擋下來，回傳空陣列，畫面上看起來像「這個班沒有學生」，只有自己導師班
-- （靠 homeroom_teacher_id 那個條件放行）看得到。
--
-- 修正：staff_read_enrollments 補上「該班任課教師」這個條件，跟
-- can_write_attendance() 用同一套判斷方式（enrollments.class_id 對得到
-- class_schedule.class_id 且 teacher_id = 自己），任課教師才能讀到自己任教
-- 班級的完整學生名單。
-- ============================================================

drop policy if exists staff_read_enrollments on enrollments;
create policy staff_read_enrollments on enrollments
  for select
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from classes c
      where c.id = enrollments.class_id and c.homeroom_teacher_id = current_teacher_id()
    )
    or exists (
      -- 任課教師：對自己有課表（class_schedule）的班級，可以讀到完整學生名單
      -- （不限特定節次——名單本身跟節次無關，寫入出缺勤紀錄時才會依節次限制，
      -- 見 can_write_attendance()）。
      select 1 from class_schedule cs
      where cs.class_id = enrollments.class_id
        and cs.term = enrollments.term
        and cs.teacher_id = current_teacher_id()
    )
  );

notify pgrst, 'reload schema';
