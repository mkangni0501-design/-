-- ============================================================
-- 49. 排名/總分權限修正：管理員S看不到總分跟排名
-- ------------------------------------------------------------
-- 根因：sql/47ranking_average_discipline_access_partial_report_card.sql 裡，
-- class_rankings／grade_rankings／class_rankings_for_class()／
-- grade_rankings_for_class() 這四個排名依據，我自己重寫時圖方便，用了
--   current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
-- 這種「自己重新比對角色字串」的寫法，而不是系統其他地方（scores／curriculum／
-- students／enrollments…幾乎所有資料表的 RLS 政策）統一使用的
--   is_system_admin() or has_department('academic') or ...
-- 這一套「已經驗證過、大家都在用」的判斷函式。這兩種寫法理論上該給同一群人存取，
-- 但一旦帳號資料/角色字串有任何一點不一致（例如系統管理員S的帳號是舊資料、
-- app_users.role 欄位的值跟其他地方預期的字串有些微差異），只有這裡自己重寫的
-- 那一份判斷式會抓不到，其他地方仍然正常——這正好對應「管理員S看不到總分跟排名，
-- 但班導師可以」（班導師走的是 homeroom_teacher_id 那個條件，不受影響）這個現象。
--
-- 修正：這四個排名函式/view 改成呼叫跟其他資料表統一的 is_system_admin() 判斷式，
-- 不再自己另外比對角色字串，跟系統其他地方保持同一套邏輯、同一個真相來源。
-- ============================================================

drop view if exists class_rankings cascade;
create or replace view class_rankings
with (security_invoker = true)
as
with distinct_classes as (
  select distinct e.class_id, c.academic_year, e.term
  from enrollments e join classes c on c.id = e.class_id
),
class_locks as (
  select
    class_id, academic_year, term,
    exam_type_locked(class_id, academic_year, term, '期中考') as mid_locked,
    exam_type_locked(class_id, academic_year, term, '期末考') as fin_locked,
    exam_type_locked(class_id, academic_year, term, '平時分') as day_locked
  from distinct_classes
),
ranked as (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    et.midterm_total,
    rank() over (partition by e.class_id, e.term order by et.midterm_average desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_average desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_average desc) as daily_class_rank,
    et.midterm_average,
    et.final_average,
    et.daily_average
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
)
select
  ranked.enrollment_id, ranked.class_id, ranked.term, ranked.academic_year,
  ranked.name, ranked.seat_no, ranked.student_no,
  case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.total_score end as total_score,
  case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.class_rank end as class_rank,
  case when cl.mid_locked then ranked.midterm_total end as midterm_total,
  case when cl.mid_locked then ranked.midterm_class_rank end as midterm_class_rank,
  case when cl.fin_locked then ranked.final_total end as final_total,
  case when cl.fin_locked then ranked.final_class_rank end as final_class_rank,
  case when cl.day_locked then ranked.daily_total end as daily_total,
  case when cl.day_locked then ranked.daily_class_rank end as daily_class_rank,
  case when cl.mid_locked then ranked.midterm_average end as midterm_average,
  case when cl.fin_locked then ranked.final_average end as final_average,
  case when cl.day_locked then ranked.daily_average end as daily_average
from ranked
join class_locks cl on cl.class_id = ranked.class_id and cl.academic_year = ranked.academic_year and cl.term = ranked.term
where (
  is_system_admin()
  or has_department('academic')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

drop view if exists grade_rankings cascade;
create or replace view grade_rankings
with (security_invoker = true)
as
with distinct_classes as (
  select distinct e.class_id, c.academic_year, e.term
  from enrollments e join classes c on c.id = e.class_id
),
class_locks as (
  select
    class_id, academic_year, term,
    exam_type_locked(class_id, academic_year, term, '期中考') as mid_locked,
    exam_type_locked(class_id, academic_year, term, '期末考') as fin_locked,
    exam_type_locked(class_id, academic_year, term, '平時分') as day_locked
  from distinct_classes
),
ranked as (
  select
    t.enrollment_id, e.class_id, e.term, c.academic_year, c.department, c.grade_level,
    st.name, e.seat_no, e.student_no,
    t.total_score,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by t.total_score desc) as grade_rank,
    et.midterm_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_average desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_average desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_average desc) as daily_grade_rank,
    et.midterm_average,
    et.final_average,
    et.daily_average
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
  left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
)
select
  ranked.enrollment_id, ranked.class_id, ranked.term, ranked.academic_year,
  ranked.department, ranked.grade_level, ranked.name, ranked.seat_no, ranked.student_no,
  case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.total_score end as total_score,
  case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.grade_rank end as grade_rank,
  case when cl.mid_locked then ranked.midterm_total end as midterm_total,
  case when cl.mid_locked then ranked.midterm_grade_rank end as midterm_grade_rank,
  case when cl.fin_locked then ranked.final_total end as final_total,
  case when cl.fin_locked then ranked.final_grade_rank end as final_grade_rank,
  case when cl.day_locked then ranked.daily_total end as daily_total,
  case when cl.day_locked then ranked.daily_grade_rank end as daily_grade_rank,
  case when cl.mid_locked then ranked.midterm_average end as midterm_average,
  case when cl.fin_locked then ranked.final_average end as final_average,
  case when cl.day_locked then ranked.daily_average end as daily_average
from ranked
join class_locks cl on cl.class_id = ranked.class_id and cl.academic_year = ranked.academic_year and cl.term = ranked.term
where (
  is_system_admin()
  or has_department('academic')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

create or replace function class_rankings_for_class(p_class_id uuid, p_term text)
returns table (
  enrollment_id uuid, class_id uuid, term text, academic_year int, name text, seat_no int, student_no text,
  total_score numeric, class_rank bigint,
  midterm_total numeric, midterm_class_rank bigint,
  final_total numeric, final_class_rank bigint,
  daily_total numeric, daily_class_rank bigint,
  midterm_average numeric, final_average numeric, daily_average numeric
)
language sql stable
security invoker
as $$
  with ranked as (
    select
      t.enrollment_id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no,
      t.total_score,
      rank() over (order by t.total_score desc) as class_rank,
      et.midterm_total,
      rank() over (order by et.midterm_average desc) as midterm_class_rank,
      et.final_total,
      rank() over (order by et.final_average desc) as final_class_rank,
      et.daily_total,
      rank() over (order by et.daily_average desc) as daily_class_rank,
      et.midterm_average, et.final_average, et.daily_average
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id and e.class_id = p_class_id and e.term = p_term
    join classes c on c.id = e.class_id
    join students st on st.student_no = e.student_no
    left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
  ),
  cl as (
    select
      exam_type_locked(p_class_id, c.academic_year, p_term, '期中考') as mid_locked,
      exam_type_locked(p_class_id, c.academic_year, p_term, '期末考') as fin_locked,
      exam_type_locked(p_class_id, c.academic_year, p_term, '平時分') as day_locked
    from classes c
    where c.id = p_class_id
  )
  select
    ranked.enrollment_id, ranked.class_id, ranked.term, ranked.academic_year,
    ranked.name, ranked.seat_no, ranked.student_no,
    case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.total_score end,
    case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.class_rank end,
    case when cl.mid_locked then ranked.midterm_total end,
    case when cl.mid_locked then ranked.midterm_class_rank end,
    case when cl.fin_locked then ranked.final_total end,
    case when cl.fin_locked then ranked.final_class_rank end,
    case when cl.day_locked then ranked.daily_total end,
    case when cl.day_locked then ranked.daily_class_rank end,
    case when cl.mid_locked then ranked.midterm_average end,
    case when cl.fin_locked then ranked.final_average end,
    case when cl.day_locked then ranked.daily_average end
  from ranked, cl
  where (
    is_system_admin()
    or has_department('academic')
    or exists (select 1 from classes c2 where c2.id = p_class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  );
$$;

create or replace function grade_rankings_for_class(p_class_id uuid, p_term text)
returns table (
  enrollment_id uuid, class_id uuid, term text, academic_year int,
  department text, grade_level text, name text, seat_no int, student_no text,
  total_score numeric, grade_rank bigint,
  midterm_total numeric, midterm_grade_rank bigint,
  final_total numeric, final_grade_rank bigint,
  daily_total numeric, daily_grade_rank bigint,
  midterm_average numeric, final_average numeric, daily_average numeric
)
language sql stable
security invoker
as $$
  with target as (
    select c.academic_year, c.department, c.grade_level
    from classes c where c.id = p_class_id
  ),
  ranked as (
    select
      t.enrollment_id, e.class_id, e.term, c.academic_year, c.department, c.grade_level,
      st.name, e.seat_no, e.student_no,
      t.total_score,
      rank() over (order by t.total_score desc) as grade_rank,
      et.midterm_total,
      rank() over (order by et.midterm_average desc) as midterm_grade_rank,
      et.final_total,
      rank() over (order by et.final_average desc) as final_grade_rank,
      et.daily_total,
      rank() over (order by et.daily_average desc) as daily_grade_rank,
      et.midterm_average, et.final_average, et.daily_average
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id and e.term = p_term
    join classes c on c.id = e.class_id
    join target tg on c.academic_year = tg.academic_year and c.department = tg.department and c.grade_level = tg.grade_level
    join students st on st.student_no = e.student_no
    left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
  )
  select
    ranked.enrollment_id, ranked.class_id, ranked.term, ranked.academic_year,
    ranked.department, ranked.grade_level, ranked.name, ranked.seat_no, ranked.student_no,
    case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.total_score end,
    case when cl.mid_locked and cl.fin_locked and cl.day_locked then ranked.grade_rank end,
    case when cl.mid_locked then ranked.midterm_total end,
    case when cl.mid_locked then ranked.midterm_grade_rank end,
    case when cl.fin_locked then ranked.final_total end,
    case when cl.fin_locked then ranked.final_grade_rank end,
    case when cl.day_locked then ranked.daily_total end,
    case when cl.day_locked then ranked.daily_grade_rank end,
    case when cl.mid_locked then ranked.midterm_average end,
    case when cl.fin_locked then ranked.final_average end,
    case when cl.day_locked then ranked.daily_average end
  from ranked
  cross join lateral (
    select
      exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期中考') as mid_locked,
      exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '期末考') as fin_locked,
      exam_type_locked(ranked.class_id, ranked.academic_year, ranked.term, '平時分') as day_locked
  ) cl
  where (
    is_system_admin()
    or has_department('academic')
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  );
$$;

notify pgrst, 'reload schema';

-- ============================================================
-- 診斷用查詢（不是給程式執行，是給你手動在 SQL Editor 貼上跑一次確認用）：
-- 如果套用這份檔案之後系統管理員S還是看不到總分/排名，麻煩用管理員S的帳號
-- 登入後，請系統管理員S本人或有資料庫存取權的人執行下面這一段，把結果告訴我：
--
--   select id, role, name from app_users where role = 'system_admin_s';
--
-- 如果這個查詢「完全沒有結果」，代表系統管理員S那個帳號在資料庫裡的 role 欄位
-- 存的值，跟系統其他地方預期的 'system_admin_s' 這個字串不一樣（可能是舊資料、
-- 或是帳號管理頁面存檔時有誤），需要把它改成正確的字串值，這是資料本身要修正，
-- 不是程式或政策要再改。
-- ============================================================
