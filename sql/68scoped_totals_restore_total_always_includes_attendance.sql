-- ============================================================
-- 68. 再次修正 scoped_student_totals()：總分要一直含出缺席，只有期中/期末/平時
--     三部分才依開關排除
-- ------------------------------------------------------------
-- 這輪反映事項更正了 sql/67 的理解：
--   「現在勾選【出缺席成績不含蓋在期中、期末、平時個別三部分分數】後,成績總表
--    那邊一樣也沒有計算到出缺席,應該是勾選以後只有期中、期末、平時三分頁不
--    計算不顯示,請修正。」
--
-- 也就是說【班級成績總表】頁面本身要分兩塊看：
--   ●期中／期末／平時三個「分頁」（三部分的分數/排名）——開關開啟時排除出缺席。
--   ●這個班級的「總分」／排名（成績總表）——不管開關有沒有開，一律照原本的算法
--     繼續把出缺席3%算進去，不受這個開關影響。
--
-- 換句話說，這裡的行為要退回 sql/66 一開始的設計（total_score 永遠含出缺席，
-- 只有 midterm/final/daily 依開關排除），sql/67 那次「連 total_score 也排除」
-- 是誤解，這裡改正。正式成績單（student_total_scores）本來就沒受這個開關
-- 影響過，這次也一樣不動。
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
    select t.enrollment_id, attendance_score(t.enrollment_id) as score
    from target t
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

comment on function scoped_student_totals(uuid[]) is
  '班排名/年級排名/家長入口共用的計算來源（sql/63）。total_score（成績總表的總分/
   排名）永遠含出缺席真實成績，不受開關影響；midterm/final/daily 的 total 與
   average（期中/期末/平時三部分）才依 attendance_score_display_settings.
   exclude_attendance_from_partial_scores 這個開關排除出缺席（見 sql/68，取代
   sql/67 讓 total_score 也一起排除的錯誤行為，退回 sql/66 一開始的設計）。
   正式成績單（student_total_scores）是完全獨立的另一條計算路徑，不受這個
   開關影響，永遠是含出缺席的真實成績。';

notify pgrst, 'reload schema';
