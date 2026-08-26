-- ============================================================
-- 班級成績總表 / 家長查詢入口：分別統計「期中各科總分與排名」「期末各科總分與排名」
-- 「平時分各科總分與排名」，跟原本「總表」(期中*比例+期末*比例+平時*比例後的加權總分) 分開。
--
-- 期中/期末/平時的「各科總分」是單純把該次考試各科的原始分數加總（不套用 grading_rules
-- 的期中/期末/平時比例、也不套用 curriculum 的科目權重）；只有「總表」欄位才套用這兩層比例，
-- 這部分沿用 calculations.sql 既有的 student_total_scores 計算方式，不受本檔影響。
--
-- 重要：class_rankings / grade_rankings 這兩個 view，schema 建立順序上
-- calculations.sql 先建立一次，portal.sql 又用 create or replace view 疊加了
-- 「student_no 欄位」與「家長也能查詢」的權限，本檔要在 portal.sql 之後再疊加一次，
-- 欄位需要接續 portal.sql 版本的順序（否則 create or replace view 會因為欄位順序
-- 對不起來而報錯）。
--
-- 執行順序：schema.sql → policies.sql → calculations.sql → registration.sql →
-- portal.sql → student_edit.sql →（前一批的 attendance_window_open_requests.sql）→
-- 本檔（本檔一定要排在 portal.sql 之後執行）。
-- ============================================================

-- ---------- 1. 每位學生「各科原始分數」依期中/期末/平時分開加總 ----------
create view student_examtype_totals
with (security_invoker = true)
as
select
  enrollment_id,
  sum(midterm) as midterm_total,
  sum(final) as final_total,
  sum(daily) as daily_total
from subject_scores
group by enrollment_id;

-- ---------- 2. 班排名：接續 portal.sql 版本的欄位順序，後面再補上期中/期末/平時 ----------
create or replace view class_rankings
with (security_invoker = true)
as
select * from (
  select
    t.enrollment_id,
    e.class_id,
    e.term,
    c.academic_year,
    st.name,
    e.seat_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    e.student_no,
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
    or exists (
      select 1 from classes c2
      where c2.id = ranked.class_id
        and c2.homeroom_teacher_id = current_teacher_id()
    )
    or is_linked_parent(ranked.student_no)
  )
  and exists (
    select 1 from submission_windows sw
    where sw.data_type = '平時分'
      and sw.scope = '班級'
      and sw.scope_ref = ranked.class_id::text
      and sw.academic_year = ranked.academic_year
      and sw.term = ranked.term
      and sw.is_locked = true
  );

-- ---------- 3. 全校/跨班同年級排名：同樣接續 portal.sql 版本的欄位順序 ----------
create or replace view grade_rankings
with (security_invoker = true)
as
select * from (
  select
    t.enrollment_id,
    e.class_id,
    e.term,
    c.academic_year,
    c.department,
    c.grade_level,
    st.name,
    e.seat_no,
    t.total_score,
    rank() over (
      partition by c.academic_year, e.term, c.department, c.grade_level
      order by t.total_score desc
    ) as grade_rank,
    e.student_no,
    et.midterm_total,
    rank() over (
      partition by c.academic_year, e.term, c.department, c.grade_level
      order by et.midterm_total desc
    ) as midterm_grade_rank,
    et.final_total,
    rank() over (
      partition by c.academic_year, e.term, c.department, c.grade_level
      order by et.final_total desc
    ) as final_grade_rank,
    et.daily_total,
    rank() over (
      partition by c.academic_year, e.term, c.department, c.grade_level
      order by et.daily_total desc
    ) as daily_grade_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
) ranked
where (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from classes c2
      where c2.id = ranked.class_id
        and c2.homeroom_teacher_id = current_teacher_id()
    )
    or is_linked_parent(ranked.student_no)
  )
  and exists (
    select 1 from submission_windows sw
    where sw.data_type = '平時分'
      and sw.scope = '班級'
      and sw.scope_ref = ranked.class_id::text
      and sw.academic_year = ranked.academic_year
      and sw.term = ranked.term
      and sw.is_locked = true
  );
