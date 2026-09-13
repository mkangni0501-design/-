-- ============================================================
-- 92. 考試分班：管理員A、系統管理員S 也能直接代替導師安排考場名單
-- ------------------------------------------------------------
-- sql/90exam_seating.sql 原本的政策已經允許 is_system_admin()（system_admin_s）
-- 或 has_department('academic')（教務部門）讀寫 exam_seat_students / exam_class_roster_status，
-- 這裡另外明確加上 admin_a 角色本身（不論是否有另外指派教務部門），符合「管理員A、S及教務處
-- 都有權限直接代替導師安排」的需求。用 drop + create 明確重建這兩條政策，可以重複執行。
-- ============================================================

drop policy if exists academic_write_exam_seat_students on exam_seat_students;
create policy academic_write_exam_seat_students on exam_seat_students
  for all
  using (is_system_admin() or current_role_name() = 'admin_a' or has_department('academic'))
  with check (is_system_admin() or current_role_name() = 'admin_a' or has_department('academic'));

drop policy if exists academic_manage_exam_class_roster_status on exam_class_roster_status;
create policy academic_manage_exam_class_roster_status on exam_class_roster_status
  for all
  using (is_system_admin() or current_role_name() = 'admin_a' or has_department('academic'))
  with check (is_system_admin() or current_role_name() = 'admin_a' or has_department('academic'));
