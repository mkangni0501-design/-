-- ============================================================
-- 排名/成績單鎖定顆粒度修正
--
-- 修正前的問題：class_rankings / grade_rankings 這兩個視圖(view)，原本是
-- 「只要平時分被鎖定，就整列資料一起顯示」，沒有分別檢查期中考、期末考
-- 是否也各自鎖定。
--
-- 依您說明調整為：
--   期中考排行　→ 該班「期中考」這一格鎖定後，就能看到期中排行
--   期末考排行　→ 該班「期末考」這一格鎖定後，就能看到期末排行
--   平時分排行　→ 該班「平時分」這一格鎖定後，就能看到平時分排行（含導師評語）
--   總成績排行　→ 期中考／期末考／平時分「三個都鎖定」後，才能看到總表(加權總分)與總排名
--
-- 做法：原本是「整列」看得到看不到，改成「每一欄各自看得到看不到」
--（用 case when 依各自的鎖定狀態決定要不要顯示該欄位的值，其餘沒鎖的欄位顯示 null）。
-- 「誰能查到這個學生」的權限(導師/管理員/家長)維持不變，這裡只調整「鎖定到什麼程度、
-- 看得到哪些欄位」。
--
-- 需在 sql/ 資料夾原本 17 份檔案（尤其 exam_type_rankings.sql）都執行過後再執行本檔。
-- ============================================================

-- ---------- 輔助函式：某班某學年學期的某類資料是否已鎖定 ----------
create or replace function exam_type_locked(
  p_class_id uuid, p_academic_year int, p_term text, p_data_type text
) returns boolean as $$
  select exists (
    select 1 from submission_windows sw
    where sw.data_type = p_data_type
      and sw.scope = '班級'
      and sw.scope_ref = p_class_id::text
      and sw.academic_year = p_academic_year
      and sw.term = p_term
      and sw.is_locked = true
  );
$$ language sql stable;

-- ---------- 班排名 ----------
-- 【安全防護】先強制刪除可能卡住的舊班排名視圖
DROP VIEW IF EXISTS class_rankings CASCADE;

create or replace view class_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  -- 總表：三個都鎖定才顯示
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.class_rank end as class_rank,

  -- 期中排行：期中考鎖定後就顯示
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_class_rank end as midterm_class_rank,

  -- 期末排行：期末考鎖定後就顯示
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_class_rank end as final_class_rank,

  -- 平時分排行：平時分鎖定後就顯示
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_class_rank end as daily_class_rank

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    et.midterm_total,
    rank() over (partition by e.class_id, e.term order by et.midterm_total desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_total desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_total desc) as daily_class_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

-- ---------- 全校/跨班同年級排名 ----------
-- 【安全防護】先強制刪除可能卡住的舊年級排名視圖
DROP VIEW IF EXISTS grade_rankings CASCADE;

create or replace view grade_rankings
with (security_invoker = true)
as
select
  ranked.enrollment_id,
  ranked.class_id,
  ranked.term,
  ranked.academic_year,
  ranked.department,
  ranked.grade_level,
  ranked.name,
  ranked.seat_no,
  ranked.student_no,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.total_score end as total_score,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
        and exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.grade_rank end as grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_total end as midterm_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考')
       then ranked.midterm_grade_rank end as midterm_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_total end as final_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考')
       then ranked.final_grade_rank end as final_grade_rank,

  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_total end as daily_total,
  case when exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分')
       then ranked.daily_grade_rank end as daily_grade_rank

from (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, c.department, c.grade_level,
    st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by t.total_score desc) as grade_rank,
    et.midterm_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_total desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_total desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_total desc) as daily_grade_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);
-- ============================================================
-- 提醒：report-card（成績單PDF）的 API 目前是抓 student_total_scores（原始未鎖定判斷的
-- 總分表）+ class_rankings/grade_rankings 的 total_score/class_rank，
-- 改成上面的版本後，如果三項還沒有全部鎖定，total_score／class_rank／grade_rank
-- 這幾欄查詢結果會是 null。成績單產生API那邊建議加一段判斷：
-- 如果 total_score 是 null，代表還沒有全部鎖定，應該擋下來、不給產出正式成績單
-- （這部分程式碼調整寫在下面 batch-report-card route 的草稿裡一併示範）。
-- ============================================================
