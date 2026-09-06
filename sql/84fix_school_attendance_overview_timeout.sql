-- ============================================================
-- 84. 修正【全校出缺席狀況總覽】讀取出缺勤統計逾時
--     （canceling statement due to statement timeout）
-- ------------------------------------------------------------
-- 【根因】這頁讀的是 student_absence_counts 這個 view（sql/8，
-- security_invoker=true，沿用 attendance 表原本的 RLS），本質上是對全校
-- attendance 表整張表 group by student_no 做彙總——資料量大的學校，這張表
-- 動輒數十萬列，是全站唯一一個「非做全表掃描不可」的查詢。
--
-- sql/81fix_attendance_read_blocked_by_lock.sql 新增的 attendance_read 政策、
-- 以及更早 sql/37hide_status_changed_students.sql 的
-- hide_status_changed_students_attendance 政策，判斷式裡都用了
-- is_system_admin()／has_department(...)／current_role_name() 這幾個函式——
-- 這幾個函式都不依賴 attendance 那一列的任何欄位（不管掃到哪一列，答案都一樣），
-- 但因為直接寫成 `is_system_admin() or ...` 這種形式、又是包在另一個函式
-- （can_read_attendance）或政策運算式裡面，Postgres 沒辦法自動看出「這其實跟
-- 這一列無關，整條查詢只要算一次就好」，於是變成「全表掃描的每一列都重算一次」
-- ——資料量小的時候看不出來，全校規模的 attendance 表一次全表掃描下來，
-- 光是這幾十萬次重複的權限判斷，就足以讓整條查詢超過 Supabase 的
-- statement_timeout 直接被中止，這正是管理者S看到的錯誤訊息。
--
-- 【修法】Postgres／Supabase 官方建議的寫法：把這種「跟這一列資料無關、每次
-- 結果都一樣」的函式呼叫，改成 `(select 函式())` 包一層子查詢——這樣 Postgres
-- 會看出這個子查詢沒有關聯到外層任何一欄，只要算「一次」存起來（InitPlan），
-- 不會再對每一列都重算一次。純粹是效能寫法調整，判斷邏輯／權限範圍完全不變。
-- ============================================================

create or replace function can_read_attendance(p_student_no text, p_period_no int)
returns boolean as $$
  select
    (select is_system_admin()) or (select has_department('discipline')) or (select has_department('dev'))
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = p_student_no
        and c.homeroom_teacher_id = (select current_teacher_id())
    )
    or exists (
      select 1 from enrollments e
      join class_schedule cs on cs.class_id = e.class_id
      where e.student_no = p_student_no
        and cs.teacher_id = (select current_teacher_id())
        and cs.period_no = p_period_no
    );
$$ language sql stable security definer;

drop policy if exists hide_status_changed_students_attendance on attendance;
create policy hide_status_changed_students_attendance on attendance
  as restrictive
  using (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

-- student_is_hidden() 本身也一樣改成 (select ...) 包一層，它內部呼叫的
-- student_current_status() 同樣跟「這一列 attendance」無關，只跟學生本身有關；
-- 這裡改成用學生的目前狀態直接查一次，effect 不變，只是讓外層能少算幾次。
-- （student_is_hidden 本身仍然吃 student_no 當參數、無法整個變成常數，這裡不動它
-- 的簽名，只確保呼叫端已經用 restrictive 政策的 admin 短路盡量避免真的呼叫到它。）

notify pgrst, 'reload schema';
