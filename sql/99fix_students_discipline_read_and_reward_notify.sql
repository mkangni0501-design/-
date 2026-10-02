-- ============================================================
-- 99. 修正「訓導打開獎懲登記頁，任何班級都顯示找不到名字」＋ 獎懲核准後通知
-- ------------------------------------------------------------
-- 【3c 根因】staff_read_students 政策（sql/22）全校讀取只開放給
-- is_system_admin() 或 has_department('academic')，沒有 has_department('discipline')。
-- 訓導部門的帳號（非 admin_a/admin_b/system_admin_s 這幾個角色，是單純掛在
-- 'discipline' 部門的教師帳號）在「獎懲登記」頁因為 hasDepartment('discipline')
-- 使得前端把他當成「全權限」（isFull=true），可以選任何班級——但選了班級之後，
-- 查學生姓名這一步用的是 students 表，RLS 卻沒有開放 discipline 部門全校讀取，
-- 結果就是「不管選哪個班級，學生姓名都查不到」。只有當這個人同時也是某班導師
-- 或任課教師時（也就是「切回教師身分」的情境），才會因為 staff_read_students
-- 本來就有的「導師本班／任課教師」那兩個 exists 條件而查得到——這跟使用者的
-- 觀察（「只有回到教師身分才能看到自己班學生姓名」）完全吻合。
-- 這跟 sql/94 當時修 staff_read_enrollments 缺 'discipline' 是同一種疏漏，
-- 這裡補上 students 這張表。
-- ============================================================

drop policy if exists staff_read_students on students;
create policy staff_read_students on students
  for select
  using (
    is_system_admin() or has_department('academic') or has_department('discipline')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = students.student_no and c.homeroom_teacher_id = current_teacher_id()
    )
    or exists (
      select 1 from class_schedule cs join enrollments e2 on e2.class_id = cs.class_id
      where e2.student_no = students.student_no and cs.teacher_id = current_teacher_id()
    )
  );

notify pgrst, 'reload schema';
