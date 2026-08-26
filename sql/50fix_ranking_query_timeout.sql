-- ============================================================
-- 50. 效能修正：總分/排名查詢逾時（canceling statement due to statement timeout）
-- ------------------------------------------------------------
-- 根因：sql/48fix_attendance_score_formula.sql 把「全勤／出缺席」改成透過
-- subject_scores 這個 view 的第二段（union all 之後那段）計算，那段完全沒有針對
-- 「呼叫者只需要哪個班/哪個學生」做任何篩選——
--   from enrollments e join classes c on c.id = e.class_id join lateral (...) cu on true
-- 這段語法本身沒有 where 子句限制範圍，PostgreSQL 對「UNION ALL 裡包含 LATERAL JOIN
-- 呼叫 PL/pgSQL 函式」這種寫法，通常沒辦法把外層查詢的篩選條件（例如「只要這個班的
-- 20 個學生」）往內推進去，會變成「不管外面只要哪幾個學生，這個分支都先把全校所有
-- 學生（1300多位）的出缺席分數都算一遍」，而且 midterm/final/daily 三個欄位各自
-- 呼叫一次 attendance_score()，等於一列資料呼叫 3 次——1300多位學生 × 3 次
-- × 這支函式內部本來就有 2 條查 attendance 表的 SQL，會變成將近 8000 次查詢，
-- 這就是「班級成績結果與排名」「批次列印」「管理員S看不到排名」這幾個反映事項，
-- 很可能背後同一個根因：不是權限問題，是效能問題被查詢逾時直接中斷，中斷後
-- 程式收到的是「查詢失敗」，看起來像是「看不到」，但實際上是「查詢還沒跑完就
-- 被系統強制取消了」。
--
-- 這份檔案做兩件事：
-- (1) attendance_score() 本身：原本查 attendance 表查兩次（一次算加總、一次確認
--     是否真的有紀錄），改成合併成一次查詢，函式呼叫成本減半。
-- (2) 排名查詢（class_rankings_for_class／grade_rankings_for_class）不再依賴
--     「先查全校再篩選」的 subject_scores／student_examtype_totals／
--     student_base_scores 這幾個通用 view，改成從一開始就先篩出「這個班」或
--     「這個年級同部別」的學生名單，用這份已經篩選過的名單去算出缺席分數、
--     科目加權——從根本上不讓資料庫有機會去碰班級以外的學生資料。
-- 成績單（單一學生）那條路徑本來就只查一個 enrollment_id，理論上不會被同樣的
-- 全校掃描問題拖慢太多，這輪先集中處理「查一整班/一整個年級」這種影響範圍
-- 大很多的查詢，成績單那邊如果之後也發現慢，可以用同樣的手法再處理一次。
-- ============================================================

-- ---------- 1. attendance_score()：兩次查詢合併成一次 ----------
create or replace function attendance_score(p_enrollment_id uuid)
returns numeric
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v_student_no text;
  v_academic_year int;
  v_term text;
  v_start date;
  v_end date;
  v_deduction numeric;
  v_record_count int;
begin
  select e.student_no, c.academic_year, e.term
    into v_student_no, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if v_student_no is null then
    return null;
  end if;

  select term_start_date, term_end_date into v_start, v_end
  from academic_terms
  where academic_year = v_academic_year and term = v_term;

  if v_start is null or v_end is null then
    return null;
  end if;

  select count(*), coalesce(sum(cpd.points), 0)
    into v_record_count, v_deduction
  from attendance a
  left join conduct_point_defaults cpd on cpd.item = a.status::text
  where a.student_no = v_student_no
    and a.record_date between v_start and v_end
    and a.status <> '出席';

  -- 完全沒有任何一筆曠課/遲到/病假/事假/公假紀錄（真正全勤）才給100分；
  -- 只要有紀錄，即使剛好加總=0，也照原始加總結果顯示（=0），不會被誤判成全勤。
  return case when v_record_count = 0 then 100 else v_deduction end;
end;
$$;

-- ---------- 2. 排名查詢改成「先篩範圍、再算分數」，不依賴全校範圍的通用 view ----------
-- 下面這支輔助函式：給一份 enrollment_id 清單，算出這些學生（只有這些學生）的
-- 期中/期末/平時 直接加總、依比重加權平均，以及全學期總分——邏輯跟
-- subject_scores／student_examtype_totals／student_base_scores／student_total_scores
-- 完全一樣，只是從第一步開始就限定在傳進來的這份名單裡，不會去碰名單以外的資料。
create or replace function scoped_student_totals(p_enrollment_ids uuid[])
returns table (
  enrollment_id uuid,
  total_score numeric,
  midterm_total numeric,
  final_total numeric,
  daily_total numeric,
  midterm_average numeric,
  final_average numeric,
  daily_average numeric
)
language sql stable
security invoker
as $$
  with target as (
    select e.id as enrollment_id, e.class_id, e.term, c.academic_year, c.grade_level
    from enrollments e
    join classes c on c.id = e.class_id
    where e.id = any(p_enrollment_ids)
  ),
  att as (
    -- 出缺席分數只算一次（不是像原本 subject_scores 那樣 midterm/final/daily
    -- 各自呼叫一次 attendance_score()），而且只算 target 名單裡的這些學生。
    select t.enrollment_id, attendance_score(t.enrollment_id) as score
    from target t
  ),
  ss as (
    select enrollment_id, subject,
      max(score) filter (where exam_type = '期中考') as midterm,
      max(score) filter (where exam_type = '期末考') as final,
      max(score) filter (where exam_type = '平時分') as daily
    from scores
    where enrollment_id = any(p_enrollment_ids)
      and subject not in ('全勤', '出缺席')
    group by enrollment_id, subject
    union all
    select t.enrollment_id, cu.subject, att.score, att.score, att.score
    from target t
    join att on att.enrollment_id = t.enrollment_id
    join lateral (
      select cu.subject, cu.weight
      from curriculum cu
      where cu.academic_year = t.academic_year
        and cu.term = t.term
        and cu.grade_level = t.grade_level
        and cu.subject in ('全勤', '出缺席')
        and cu.weight > 0
      order by (cu.subject = '出缺席') desc
      limit 1
    ) cu on true
  ),
  ss_weighted as (
    select
      ss.enrollment_id, ss.subject,
      (coalesce(ss.midterm, 0) * gr.midterm_weight
        + coalesce(ss.final, 0) * gr.final_weight
        + coalesce(ss.daily, 0) * gr.daily_weight) as subject_weighted_score,
      ss.midterm, ss.final, ss.daily
    from ss
    join target t on t.enrollment_id = ss.enrollment_id
    join grading_rules gr on gr.academic_year = t.academic_year and gr.term = t.term
  ),
  base as (
    select
      ssw.enrollment_id,
      sum(ssw.subject_weighted_score * cu.weight) as base_total,
      sum(ssw.midterm) filter (where ssw.midterm is not null) as midterm_total,
      sum(ssw.final) filter (where ssw.final is not null) as final_total,
      sum(ssw.daily) filter (where ssw.daily is not null) as daily_total,
      round(sum(ssw.midterm * cu.weight) filter (where ssw.midterm is not null), 2) as midterm_average,
      round(sum(ssw.final * cu.weight) filter (where ssw.final is not null), 2) as final_average,
      round(sum(ssw.daily * cu.weight) filter (where ssw.daily is not null), 2) as daily_average
    from ss_weighted ssw
    join target t on t.enrollment_id = ssw.enrollment_id
    join curriculum cu
      on cu.academic_year = t.academic_year
      and cu.term = t.term
      and cu.grade_level = t.grade_level
      and cu.subject = ssw.subject
      and cu.weight > 0
    group by ssw.enrollment_id
  ),
  adj as (
    select t.enrollment_id, coalesce(sum(sa.points), 0) as adjustment_total
    from target t
    left join score_adjustments sa
      on sa.academic_year = t.academic_year
      and sa.term = t.term
      and sa.is_active = true
    group by t.enrollment_id
  )
  select
    b.enrollment_id,
    round(b.base_total + a.adjustment_total, 2) as total_score,
    b.midterm_total, b.final_total, b.daily_total,
    b.midterm_average, b.final_average, b.daily_average
  from base b
  join adj a on a.enrollment_id = b.enrollment_id;
$$;

comment on function scoped_student_totals(uuid[]) is
  '跟 student_total_scores／student_examtype_totals 這兩個通用 view 算出來的數字
   完全一樣，差別是這支函式從第一步就只處理傳進來的這份 enrollment_id 名單，
   不會像那兩個 view 一樣在「只查一個班」的情況下仍然先計算全校所有學生
   （效能問題，見本檔案開頭說明）。查全校排名/報表這種本來就需要全校資料的情境，
   繼續用原本的 view 即可，這支函式是給「班級」「年級」這種範圍已知很小的查詢用的。';

-- ---------- 3. class_rankings_for_class／grade_rankings_for_class：改用上面這支函式 ----------
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
  with scoped_enrollments as (
    select e.id, e.class_id, e.term, c.academic_year, st.name, e.seat_no, e.student_no
    from enrollments e
    join classes c on c.id = e.class_id
    join students st on st.student_no = e.student_no
    where e.class_id = p_class_id and e.term = p_term
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
security invoker
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

-- ---------- 4. class_attendance_adjustment_batch()：也一併確認是 scoped 的（本來就是，這裡不用改） ----------
-- 這支函式（【班級成績總表】頁出缺席欄位用的）原本就是 `where e.class_id = p_class_id`，
-- 從第一步就有篩選範圍，不是這次效能問題的來源，這裡列出來只是確認過、不用動。

notify pgrst, 'reload schema';
