-- ============================================================
-- 102. 效能：班級成績總表／班級排名／全校排行榜 變慢
-- ------------------------------------------------------------
-- 根因（都在資料庫端，結果數字完全不變，只是算法改成集合式）：
-- (1) scoped_student_totals() 對名單裡每位學生各呼叫一次 plpgsql 的
--     attendance_score()（每次 3 條查詢）；class_attendance_adjustment_batch()
--     又對每位學生呼叫兩次。年級排名一次算整個年級（數百人），所以很慢。
--     → 新增集合式 attendance_scores_for_enrollments()，一次查完整份名單。
-- (2) grade_rankings_for_class() 對「每位學生」各算 3 次 exam_type_locked()
--     （每次最多 3 條子查詢）；鎖定狀態其實每個班只需算一次。
-- (3) 排名函式 where 裡的權限判斷（is_system_admin()、has_department()）
--     每一列都重算一次 → 包成 (select ...) 只算一次。
-- (4) student_is_hidden() → student_current_status() 依 student_no 查
--     student_status_changes，這張表沒有索引，而且這個函式被 7 張表的
--     restrictive RLS 政策逐列呼叫 → 補索引。
-- 純函式改寫＋新增索引，不改任何資料、權限範圍與計算結果。
-- 需在 sql/101 之後執行（可重複執行）。
-- ============================================================

create index if not exists idx_student_status_changes_latest
  on student_status_changes (student_no, effective_date desc, created_at desc);

create or replace function attendance_scores_for_enrollments(p_enrollment_ids uuid[])
returns table (enrollment_id uuid, score numeric)
language sql stable
security definer
set search_path = public
as $$
  -- 邏輯與 attendance_score()（sql/50）逐項相同：學期起訖日任一為空 → null；
  -- 區間內完全沒有非「出席」紀錄 → 100；否則為扣分點數加總。
  select
    e.id as enrollment_id,
    case
      when at.term_start_date is null or at.term_end_date is null then null
      when coalesce(x.cnt, 0) = 0 then 100::numeric
      else coalesce(x.deduction, 0)
    end as score
  from enrollments e
  join classes c on c.id = e.class_id
  left join academic_terms at
    on at.academic_year = c.academic_year and at.term = e.term
  left join lateral (
    select count(*) as cnt, coalesce(sum(cpd.points), 0) as deduction
    from attendance a
    left join conduct_point_defaults cpd on cpd.item = a.status::text
    where a.student_no = e.student_no
      and a.record_date between at.term_start_date and at.term_end_date
      and a.status <> '出席'
  ) x on true
  where e.id = any(p_enrollment_ids);
$$;

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
security definer
set search_path = public
as $$
  with settings as (
    select coalesce(
      (select exclude_attendance_from_partial_scores from attendance_score_display_settings where id = true),
      false
    ) as exclude_attendance
  ),
  target as (
    select e.id as enrollment_id, e.class_id, e.term, c.academic_year, c.grade_level
    from enrollments e
    join classes c on c.id = e.class_id
    where e.id = any(p_enrollment_ids)
  ),
  att as (
    -- 【sql/102】原本每位學生各呼叫一次 plpgsql 的 attendance_score()（每次 3 條查詢），
    -- 改成一次集合式查詢算完整份名單，結果完全相同。
    select a.enrollment_id, a.score
    from attendance_scores_for_enrollments(p_enrollment_ids) a
  ),
  -- 含出缺席的完整科目集合：一律拿來算 total_score（成績總表的總分/排名，
  -- 永遠含出缺席，不受開關影響）。
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
  -- 「顯示用」子集合：只餵期中/期末/平時三部分。開關關閉時 ss_display＝ss（跟
  -- total_score 用同一份資料，行為不變）；開關開啟時濾掉出缺席這個科目。
  ss_display as (
    select ss.* from ss, settings
    where not (settings.exclude_attendance and ss.subject in ('全勤', '出缺席'))
  ),
  ss_weighted as (
    select
      ss.enrollment_id, ss.subject,
      (coalesce(ss.midterm, 0) * gr.midterm_weight
        + coalesce(ss.final, 0) * gr.final_weight
        + coalesce(ss.daily, 0) * gr.daily_weight) as subject_weighted_score
    from ss
    join target t on t.enrollment_id = ss.enrollment_id
    join grading_rules gr on gr.academic_year = t.academic_year and gr.term = t.term
  ),
  base as (
    select
      ssw.enrollment_id,
      sum(ssw.subject_weighted_score * cu.weight) as base_total
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
  display_totals as (
    select
      ssd.enrollment_id,
      sum(ssd.midterm) filter (where ssd.midterm is not null) as midterm_total,
      sum(ssd.final) filter (where ssd.final is not null) as final_total,
      sum(ssd.daily) filter (where ssd.daily is not null) as daily_total,
      round(sum(ssd.midterm * cu.weight) filter (where ssd.midterm is not null), 2) as midterm_average,
      round(sum(ssd.final * cu.weight) filter (where ssd.final is not null), 2) as final_average,
      round(sum(ssd.daily * cu.weight) filter (where ssd.daily is not null), 2) as daily_average
    from ss_display ssd
    join target t on t.enrollment_id = ssd.enrollment_id
    join curriculum cu
      on cu.academic_year = t.academic_year
      and cu.term = t.term
      and cu.grade_level = t.grade_level
      and cu.subject = ssd.subject
      and cu.weight > 0
    group by ssd.enrollment_id
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
    dt.midterm_total, dt.final_total, dt.daily_total,
    dt.midterm_average, dt.final_average, dt.daily_average
  from base b
  join adj a on a.enrollment_id = b.enrollment_id
  left join display_totals dt on dt.enrollment_id = b.enrollment_id;
$$;

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
    (select is_system_admin())
    or (select has_department('academic'))
    or exists (select 1 from classes c2 where c2.id = p_class_id and c2.homeroom_teacher_id = (select current_teacher_id()))
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
  ),
  -- 【sql/102】鎖定狀態每個「班」只算一次（原本每位學生各算 3 次）
  class_locks as (
    select d.class_id,
      exam_type_locked(d.class_id, d.academic_year, d.term, '期中考') as mid_locked,
      exam_type_locked(d.class_id, d.academic_year, d.term, '期末考') as fin_locked,
      exam_type_locked(d.class_id, d.academic_year, d.term, '平時分') as day_locked
    from (select distinct class_id, academic_year, term from scoped_enrollments) d
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
  join class_locks cl on cl.class_id = ranked.class_id
  where (
    (select is_system_admin())
    or (select has_department('academic'))
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = (select current_teacher_id()))
    or is_linked_parent(ranked.student_no)
  );
$$;

create or replace function class_attendance_adjustment_batch(p_class_id uuid, p_term text)
returns table (enrollment_id uuid, attendance_score numeric, raw_adjustment numeric)
language sql stable
security invoker
as $$
  select s.enrollment_id, s.score, s.score
  from attendance_scores_for_enrollments(
    array(select e.id from enrollments e where e.class_id = p_class_id and e.term = p_term)
  ) s;
$$;

notify pgrst, 'reload schema';
