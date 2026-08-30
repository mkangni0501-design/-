-- ============================================================
-- 67. 修正 sql/66：開關開啟時,「班級成績總表」自己的總分/排名也要排除出缺席
-- ------------------------------------------------------------
-- 這輪反映事項 2b 更正了 sql/66 的理解：
--   「如果不顯示出缺席分數的話,就算期中、期末、平時三表都送出,分頁一樣不要計算
--    缺席的3%,之前我好像有說錯,只有總表要一直維持計算。」
--
-- 也就是說：
--   ●「分頁」＝【成績相關設定及查詢】>【班級成績總表】這個頁面本身——包含它的
--     「總分」「排名」欄位（不是只有期中/期末/平時三欄）——開關開啟時，一律不
--     把出缺席的3%算進去，不管三大表送出/鎖定與否都一樣。
--   ●「總表」＝真正的成績單（正式文件）。這份確認過完全不會受這個開關影響：
--     成績單是從 student_total_scores 這張表算出來的（sql/3、sql/44、sql/45、
--     sql/46 一路維護，跟這裡的 scoped_student_totals() 是兩條完全獨立的計算
--     路徑，這次也沒有去動它），永遠是「含出缺席的真實成績」。
--
-- scoped_student_totals() 除了餵給【班級成績總表】的排名 RPC（class_rankings_
-- for_class／grade_rankings_for_class），也是【家長／學生查詢入口】歷年成績
-- （portal_student_academic_history）的資料來源——這三者都屬於「內部查詢/
-- 排名用途」，跟正式成績單是分開的兩件事，所以這裡一併套用同一個規則：開關開啟
-- 時，這三個地方看到的總分都不含出缺席3%。
--
-- 做法比 sql/66 單純：不用再分 ss（含出缺席，餵 total_score）跟 ss_display
-- （依開關過濾，只餵期中/期末/平時三欄）兩條路，直接讓 total_score 也改成從
-- ss_display 算——開關關閉時 ss_display＝ss，行為跟以前完全一樣；開關開啟時
-- 出缺席這個科目從 total_score 到期中/期末/平時三欄, 一律排除。
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
  -- 【本輪修正】唯一一份「顯示用」子集合：開關開啟時濾掉出缺席這個科目，
  -- total_score／midterm/final/daily 全部都改吃這一份，不再讓 total_score
  -- 另外走一條「永遠含出缺席」的路。
  ss_display as (
    select ss.* from ss, settings
    where not (settings.exclude_attendance and ss.subject in ('全勤', '出缺席'))
  ),
  ss_weighted as (
    select
      ssd.enrollment_id, ssd.subject,
      (coalesce(ssd.midterm, 0) * gr.midterm_weight
        + coalesce(ssd.final, 0) * gr.final_weight
        + coalesce(ssd.daily, 0) * gr.daily_weight) as subject_weighted_score,
      ssd.midterm, ssd.final, ssd.daily
    from ss_display ssd
    join target t on t.enrollment_id = ssd.enrollment_id
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
  '班排名/年級排名/家長入口共用的計算來源（sql/63）。total_score／midterm/final/
   daily 的 total 與 average，全部依 attendance_score_display_settings.
   exclude_attendance_from_partial_scores 這個開關決定要不要排除出缺席（見 sql/67，
   取代 sql/66 讓 total_score 一直含出缺席的舊行為）。正式成績單（student_total_
   scores，見 sql/3／44／45／46）是完全獨立的另一條計算路徑，不受這個開關影響，
   永遠是含出缺席的真實成績。';

notify pgrst, 'reload schema';
