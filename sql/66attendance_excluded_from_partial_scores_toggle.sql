-- ============================================================
-- 66. 開發人員區新增開關：【出缺席成績不含蓋在期中、期末、平時個別三部分分數】
-- ------------------------------------------------------------
-- 需求（本輪反映事項 1）：
--   開發人員區增加一勾選功能，勾選時【成績相關設定及查詢】>【班級成績總表】的
--   期中／期末／平時三部分的成績「不會受出缺席狀態影響分數及排名」；但三大表
--   （期中考／期末考／平時分）完成並鎖定以後，總成績及成績單「依然顯示及統計
--   包含出缺席的真實成績」——也就是說，這個開關只影響「期中/期末/平時個別三欄」
--   的顯示與排名，完全不影響「總成績」這個單一數字（sql/48 已經把「出缺席」
--   做成跟其他科目一樣，比重3%、直接算進總分，這裡不改動這一段）。
--
-- 沿用跟 sql/60 的 password_policy_settings、sql/65 的 teacher_login_settings
-- 相同的「單例設定表」模式：開發人員區可勾選開關，全站讀取同一筆設定。
-- ============================================================

-- ---------- 1. 開關本身 ----------
create table if not exists attendance_score_display_settings (
  id boolean primary key default true,
  exclude_attendance_from_partial_scores boolean not null default false,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint attendance_score_display_settings_singleton check (id)
);

insert into attendance_score_display_settings (id, exclude_attendance_from_partial_scores)
values (true, false)
on conflict (id) do nothing;

alter table attendance_score_display_settings enable row level security;

-- 【班級成績總表】任何看得到成績的人（導師/任課教師/管理員）都要讀得到這個開關，
-- 才能正確判斷期中/期末/平時要不要排除出缺席；只有系統管理員或「開發人員」部門能修改，
-- 跟 password_policy_settings／teacher_login_settings 的權限設計一致。
drop policy if exists staff_read_attendance_score_display_settings on attendance_score_display_settings;
create policy staff_read_attendance_score_display_settings on attendance_score_display_settings
  for select
  using (true);

drop policy if exists dev_write_attendance_score_display_settings on attendance_score_display_settings;
create policy dev_write_attendance_score_display_settings on attendance_score_display_settings
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

-- ---------- 2. scoped_student_totals()：期中/期末/平時三欄改用「顯示用」子集合 ----------
-- 這支函式是 class_rankings_for_class()／grade_rankings_for_class()／
-- portal_student_academic_history()（見 sql/63）共用的唯一計算來源，一次改完
-- 三邊都會同步生效。
--
-- 拆成兩條路：
--   (a) total_score（＝總成績，最後 join adj 那一段）：完全比照 sql/48/63 原本的
--       算法，用「包含出缺席」的 ss／base_total 計算，不受這個開關影響——這是
--       用來滿足「三大表鎖定後，總成績及成績單依然顯示包含出缺席的真實成績」。
--   (b) midterm/final/daily 的 total 與 average（＝【班級成績總表】期中/期末/平時
--       三部分的分數及排名依據）：改成從 ss_display 這個子集合算出來——開關關閉時
--       ss_display＝ss（跟以前完全一樣，不影響任何現有行為）；開關開啟時 ss_display
--       會濾掉「全勤／出缺席」這個科目，期中/期末/平時三欄與排名就不會再被出缺席
--       分數拉高或拉低。
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
  -- 「顯示用」子集合：開關開啟時濾掉出缺席這個科目，只影響期中/期末/平時三欄
  -- 與排名，不影響 total_score（total_score 仍然從上面完整的 ss 算出）。
  ss_display as (
    select ss.* from ss, settings
    where not (settings.exclude_attendance and ss.subject in ('全勤', '出缺席'))
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
  '班排名/年級排名/家長入口共用的計算來源（sql/63）。total_score 永遠包含出缺席
   真實分數（供總成績／成績單使用，不受下面的開關影響）；midterm/final/daily 的
   total 與 average（供【班級成績總表】期中/期末/平時三部分顯示與排名使用）則會
   依 attendance_score_display_settings.exclude_attendance_from_partial_scores
   這個開關決定要不要把出缺席這個科目排除在外，見 sql/66。';

notify pgrst, 'reload schema';
