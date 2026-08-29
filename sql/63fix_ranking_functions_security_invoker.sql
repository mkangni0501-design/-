-- ============================================================
-- 63. 修正：家長/學生查詢入口看到的班排名／年級排名跟導師看到的不一樣
-- ------------------------------------------------------------
-- 根因：class_rankings_for_class()／grade_rankings_for_class()（sql/50，導師/
-- 管理端用）跟 portal_student_academic_history()（sql/56，家長/學生查詢入口用）
-- 這三支函式都宣告成 security invoker，但函式內部又都自己寫了一段明確的權限
-- 判斷（is_system_admin() or has_department('academic') or 導師本人班級 or
-- is_linked_parent(...)）——這種「自己在函式裡手動判斷權限」的寫法，正常只有
-- security definer（讓函式內部查詢用「函式擁有者」的身分繞過呼叫者的 RLS，
-- 改由函式自己的這段判斷式來把關）才有意義；宣告成 security invoker 的話，
-- 函式內部每一步查詢 enrollments／scores 這些表，實際套用的還是「呼叫者自己」
-- 的 RLS 政策，這段手寫的權限判斷形同虛設。
--
-- 這對「導師」大致上還看不出問題，因為 staff_read_enrollments／scores_select
-- 這兩條 RLS 政策本來就有開放導師讀到自己班上全班的 enrollments／scores，範圍
-- 剛好跟函式想要的「這個班」一致，算出來的班排名沒有明顯錯誤。
--
-- 但對「家長／學生本人」影響很大：parent_read_own_enrollments／
-- parent_read_own_scores 這兩條 RLS 政策只開放家長讀到「自己綁定的那個小孩」
-- 這一筆 enrollment／scores，不包含任何同班同學。portal_student_academic_history()
-- 裡面 class_scope_enrollments／grade_scope_enrollments 這兩個 CTE 雖然邏輯上想
-- 抓「全班」「同年級同部別」的名單來算排名，但因為函式是 security invoker，
-- 實際執行時套用的還是家長自己的 RLS——查 enrollments 表永遠只查得到自己小孩
-- 那一筆，等於排名是拿「只有 1 個人」的範圍去算，結果永遠是第 1 名，跟導師
-- 用同一套（但因為 RLS 開放範圍剛好是整班）算出來的真正班排名／年級排名對不起來。
--
-- 修法：這三支函式改成 security definer（並加 set search_path = public，避免
-- search_path 被劫持），讓函式內部真正能看到整班/整個年級的資料來算排名；
-- 「誰可以呼叫、可以看到誰的排名」完全由函式一開始就寫好的那段權限判斷式
-- （target_enrollments／最後的 where 子句）把關，不會因為改成 definer 就讓
-- 家長多看到不該看的東西——函式回傳的仍然只有「呼叫者原本就有權限看的那個學生」
-- 這一筆結果，班上其他同學的分數只是拿來算排名用的中間值，不會被回傳。
-- ============================================================

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
  with target as (
    select e.id as enrollment_id, e.class_id, e.term, c.academic_year, c.grade_level
    from enrollments e
    join classes c on c.id = e.class_id
    where e.id = any(p_enrollment_ids)
  ),
  att as (
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

create or replace function portal_student_academic_history(p_student_no text)
returns table (
  enrollment_id uuid,
  class_id uuid,
  term text,
  academic_year int,
  class_name text,
  grade_level text,
  total_score numeric,
  class_rank bigint,
  grade_rank bigint,
  midterm_total numeric,
  midterm_class_rank bigint,
  midterm_grade_rank bigint,
  final_total numeric,
  final_class_rank bigint,
  final_grade_rank bigint,
  daily_total numeric,
  daily_class_rank bigint,
  daily_grade_rank bigint
)
language sql stable
security definer
set search_path = public
as $$
  with target_enrollments as (
    select e.id as enrollment_id, e.class_id, e.term, c.academic_year, c.class_name, c.grade_level, c.department
    from enrollments e
    join classes c on c.id = e.class_id
    where e.student_no = p_student_no
      and (
        is_system_admin()
        or has_department('academic')
        or exists (select 1 from classes c2 where c2.id = e.class_id and c2.homeroom_teacher_id = current_teacher_id())
        or is_linked_parent(p_student_no)
      )
  ),
  class_groups as (
    select distinct class_id, term from target_enrollments
  ),
  class_scope_enrollments as (
    select e.id, e.class_id, e.term
    from enrollments e
    join class_groups cg on cg.class_id = e.class_id and cg.term = e.term
  ),
  class_totals as (
    select * from scoped_student_totals(array(select id from class_scope_enrollments))
  ),
  class_ranked as (
    select
      cse.id as enrollment_id,
      ct.total_score,
      rank() over (partition by cse.class_id, cse.term order by ct.total_score desc) as class_rank,
      ct.midterm_total,
      rank() over (partition by cse.class_id, cse.term order by ct.midterm_average desc) as midterm_class_rank,
      ct.final_total,
      rank() over (partition by cse.class_id, cse.term order by ct.final_average desc) as final_class_rank,
      ct.daily_total,
      rank() over (partition by cse.class_id, cse.term order by ct.daily_average desc) as daily_class_rank
    from class_scope_enrollments cse
    left join class_totals ct on ct.enrollment_id = cse.id
  ),
  grade_groups as (
    select distinct academic_year, department, grade_level, term from target_enrollments
  ),
  grade_scope_enrollments as (
    select e.id, c.academic_year, c.department, c.grade_level, e.term
    from enrollments e
    join classes c on c.id = e.class_id
    join grade_groups gg
      on gg.academic_year = c.academic_year
      and gg.department = c.department
      and gg.grade_level = c.grade_level
      and gg.term = e.term
  ),
  grade_totals as (
    select * from scoped_student_totals(array(select id from grade_scope_enrollments))
  ),
  grade_ranked as (
    select
      gse.id as enrollment_id,
      rank() over (partition by gse.academic_year, gse.department, gse.grade_level, gse.term order by gt.total_score desc) as grade_rank,
      rank() over (partition by gse.academic_year, gse.department, gse.grade_level, gse.term order by gt.midterm_average desc) as midterm_grade_rank,
      rank() over (partition by gse.academic_year, gse.department, gse.grade_level, gse.term order by gt.final_average desc) as final_grade_rank,
      rank() over (partition by gse.academic_year, gse.department, gse.grade_level, gse.term order by gt.daily_average desc) as daily_grade_rank
    from grade_scope_enrollments gse
    left join grade_totals gt on gt.enrollment_id = gse.id
  ),
  locks as (
    select
      te.enrollment_id,
      exam_type_locked(te.class_id, te.academic_year, te.term, '期中考') as mid_locked,
      exam_type_locked(te.class_id, te.academic_year, te.term, '期末考') as fin_locked,
      exam_type_locked(te.class_id, te.academic_year, te.term, '平時分') as day_locked
    from target_enrollments te
  )
  select
    te.enrollment_id, te.class_id, te.term, te.academic_year, te.class_name, te.grade_level,
    case when l.mid_locked and l.fin_locked and l.day_locked then cr.total_score end,
    case when l.mid_locked and l.fin_locked and l.day_locked then cr.class_rank end,
    case when l.mid_locked and l.fin_locked and l.day_locked then gr.grade_rank end,
    case when l.mid_locked then cr.midterm_total end,
    case when l.mid_locked then cr.midterm_class_rank end,
    case when l.mid_locked then gr.midterm_grade_rank end,
    case when l.fin_locked then cr.final_total end,
    case when l.fin_locked then cr.final_class_rank end,
    case when l.fin_locked then gr.final_grade_rank end,
    case when l.day_locked then cr.daily_total end,
    case when l.day_locked then cr.daily_class_rank end,
    case when l.day_locked then gr.daily_grade_rank end
  from target_enrollments te
  join locks l on l.enrollment_id = te.enrollment_id
  left join class_ranked cr on cr.enrollment_id = te.enrollment_id
  left join grade_ranked gr on gr.enrollment_id = te.enrollment_id;
$$;

comment on function portal_student_academic_history(text) is
  '給「家長/學生查詢入口」（app/(app)/portal/page.tsx）用：一次回傳某個學生
   所有學期的總分＋班排名＋年級排名。改成 security definer（見本檔案開頭說明），
   函式內部才能真正看到全班/全年級的資料來算出正確排名，不會被家長本人的 RLS
   限制成「只看得到自己小孩」而讓排名永遠算成第1名。';

notify pgrst, 'reload schema';
