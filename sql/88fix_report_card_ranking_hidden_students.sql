-- ============================================================
-- 88. 修正「已休學的學生，成績單上還是看得到、班排名還算進去」
-- ------------------------------------------------------------
-- 反映事項：高二忠 馬成孝已休學，「目前應隱藏名單」也正確顯示他是休學狀態
-- （代表狀態變更本身有確實記錄到），但成績單上還是看得到他、還排班上第一；
-- 出缺席登記表、學生名冊也都還看得到。
--
-- 【根因，這次真正找到了】成績單的班排名／全校排名／班級人數，走的是
-- report_card_class_rank()／report_card_grade_rank() 這兩個函式，還有
-- lib/reportCard.ts 裡直接數 enrollments 筆數算班級人數——這三個地方都是用
-- supabaseAdmin（service role）呼叫，而且前兩個函式本身還被標成
-- `security definer`。不管是 service role 還是 security definer 函式，
-- 都會直接繞過 RLS（不受 enrollments／scores 表上「隱藏名單」那些
-- restrictive 政策限制），而這三個地方的 SQL 本身也完全沒有另外加上
-- 「排除休學/轉學/退學/畢業/肄業學生」的篩選條件——這才是為什麼前面幾輪
-- 修的 RLS 政策，對「成績單」這條路徑完全沒有作用：成績單從一開始就沒有
-- 經過那些政策把關。
--
-- 出缺席登記表、學生名冊這兩個沒有這個問題（一般都是用一般登入身分查詢、
-- 會走 RLS），如果這兩個目前也還看得到已休學的學生，最可能是
-- sql/37hide_status_changed_students.sql／sql/62.../sql/87... 這幾個檔案
-- 還沒有在資料庫實際執行過，麻煩協助確認一下。
--
-- 【修法】幫這兩個排名函式、以及新增一個算班級人數專用的函式，都加上
-- 「排除 student_is_hidden() 的學生」這個條件，這樣不管呼叫方是用什麼身分
-- 呼叫，休學/轉學/退學/畢業/肄業的學生都不會被算進班排名/全校排名/班級人數
-- 的分母，也不會自己出現在結果裡。
-- ============================================================

create or replace function report_card_class_rank(p_enrollment_id uuid)
returns bigint
language sql stable
security definer
set search_path = public
as $$
  with target as (
    select e.class_id, e.term
    from enrollments e
    where e.id = p_enrollment_id
  ),
  scoped as (
    select t.enrollment_id, rank() over (order by t.total_score desc) as class_rank
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id
    join target tg on e.class_id = tg.class_id and e.term = tg.term
    where not student_is_hidden(e.student_no)
  )
  select class_rank from scoped where enrollment_id = p_enrollment_id;
$$;

create or replace function report_card_grade_rank(p_enrollment_id uuid)
returns bigint
language sql stable
security definer
set search_path = public
as $$
  with target as (
    select c.academic_year, e.term, c.department, c.grade_level
    from enrollments e join classes c on c.id = e.class_id
    where e.id = p_enrollment_id
  ),
  scoped as (
    select t.enrollment_id, rank() over (order by t.total_score desc) as grade_rank
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id
    join classes c on c.id = e.class_id
    join target tg on c.academic_year = tg.academic_year and e.term = tg.term
      and c.department = tg.department and c.grade_level = tg.grade_level
    where not student_is_hidden(e.student_no)
  )
  select grade_rank from scoped where enrollment_id = p_enrollment_id;
$$;

-- 【新增】班級人數專用函式，取代 lib/reportCard.ts 原本直接數 enrollments
-- 筆數（用 supabaseAdmin，會把休學/轉學/退學/畢業/肄業的學生也數進去）。
create or replace function report_card_class_size(p_enrollment_id uuid)
returns bigint
language sql stable
security definer
set search_path = public
as $$
  select count(*)
  from enrollments e
  join enrollments target on target.class_id = e.class_id and target.term = e.term
  where target.id = p_enrollment_id
    and not student_is_hidden(e.student_no);
$$;

-- ------------------------------------------------------------
-- 另外查到同一種問題也出現在【班級成績總表】頁用的
-- class_rankings_for_class()／grade_rankings_for_class()（sql/63，一樣是
-- security definer，scoped_enrollments 這個 CTE 完全沒有排除休學/轉學/退學/
-- 畢業/肄業的學生）——這裡把這兩個函式完整複製過來，只在 scoped_enrollments
-- 那個 CTE 的 where 子句加一個條件，其他邏輯（含鎖定判斷、可見範圍判斷）
-- 一字不動，避免順手改動到不相關的地方。
-- ------------------------------------------------------------

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
security definer
set search_path = public
as $$
  with scoped_enrollments as (
    select e.id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no
    from enrollments e
    join classes c on c.id = e.class_id
    join students st on st.student_no = e.student_no
    where e.class_id = p_class_id and e.term = p_term
      and not student_is_hidden(e.student_no)
  ),
  totals as (
    select * from scoped_student_totals(array(select id from scoped_enrollments))
  ),
  ranked as (
    select
      se.id as enrollment_id, se.class_id, se.term, se.academic_year, se.name, se.seat_no, se.student_no,
      t.total_score,
      rank() over (order by t.total_score desc) as class_rank,
      t.midterm_total,
      rank() over (order by t.midterm_average desc) as midterm_class_rank,
      t.final_total,
      rank() over (order by t.final_average desc) as final_class_rank,
      t.daily_total,
      rank() over (order by t.daily_average desc) as daily_class_rank,
      t.midterm_average, t.final_average, t.daily_average
    from scoped_enrollments se
    left join totals t on t.enrollment_id = se.id
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
security definer
set search_path = public
as $$
  with target_scope as (
    select c.academic_year, c.department, c.grade_level
    from classes c where c.id = p_class_id
  ),
  scoped_enrollments as (
    select e.id, e.class_id, e.term, c.academic_year, c.department, c.grade_level, st.name, e.seat_no, e.student_no
    from enrollments e
    join classes c on c.id = e.class_id
    join target_scope tg on c.academic_year = tg.academic_year and c.department = tg.department and c.grade_level = tg.grade_level
    join students st on st.student_no = e.student_no
    where e.term = p_term
      and not student_is_hidden(e.student_no)
  ),
  totals as (
    select * from scoped_student_totals(array(select id from scoped_enrollments))
  ),
  ranked as (
    select
      se.id as enrollment_id, se.class_id, se.term, se.academic_year, se.department, se.grade_level,
      se.name, se.seat_no, se.student_no,
      t.total_score,
      rank() over (order by t.total_score desc) as grade_rank,
      t.midterm_total,
      rank() over (order by t.midterm_average desc) as midterm_grade_rank,
      t.final_total,
      rank() over (order by t.final_average desc) as final_grade_rank,
      t.daily_total,
      rank() over (order by t.daily_average desc) as daily_grade_rank,
      t.midterm_average, t.final_average, t.daily_average
    from scoped_enrollments se
    left join totals t on t.enrollment_id = se.id
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
