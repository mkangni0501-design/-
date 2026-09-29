-- ============================================================
-- 96. 補強 attendance 依學號查詢的索引，搭配前端改成逐學生查詢
-- ------------------------------------------------------------
-- 配合 lib/attendanceQueries.ts 的 fetchAttendanceForStudents()（改成逐學生、
-- 用 student_no 相等條件查詢，不再對一大串學號下 IN），這裡額外補一個
-- (student_no, record_date) 索引，讓「這個學生 + 這段日期範圍」這種查詢型態
-- 一定有一個「不含 period_no」也能穩定命中的索引可以用（原本 unique 索引是
-- (student_no, record_date, period_no)，三欄都有時最好用，但查詢規劃器面對
-- 只有前兩欄條件、外加要用在 RLS 條件判斷時，統計資訊不理想的情況下不一定
-- 每次都選它）。這個索引比較小、涵蓋率跟查詢條件完全對齊，等於是再上一道
-- 保險，不影響既有的 unique 索引。
-- ============================================================

create index if not exists idx_attendance_student_date on attendance (student_no, record_date);
