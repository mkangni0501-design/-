-- ============================================================
-- 成績計算引擎（第二階段）
-- 對應「模組規格文件」模組7、模組8
-- 需在 schema.sql 執行後再執行本檔
-- ============================================================

-- ---------- 1. 把同一學生同一科目的期中/期末/平時分數整理成一列 ----------
-- 注意：以下所有 view 都加上 security_invoker = true（需 Postgres 15+，Supabase 已支援）。
-- 沒有這個設定，view 預設會以「建立者」的權限執行，等於繞過 scores/attendance 等資料表上的 RLS 政策，
-- 造成任課教師/導師透過這些 view 反而能看到不該看到的其他班級資料。

create view subject_scores
with (security_invoker = true)
as
select
  enrollment_id,
  subject,
  max(score) filter (where exam_type = '期中考') as midterm,
  max(score) filter (where exam_type = '期末考') as final,
  max(score) filter (where exam_type = '平時分') as daily
from scores
group by enrollment_id, subject;

-- ---------- 2. 依「學年學期整體佔比」(grading_rules) 算出每科加權小計 ----------
-- 注意：這裡的 join 是用學生所屬班級的 academic_year/term，
-- 不依賴任何「共用選擇器」，這正是修正舊系統科目比重選錯年級問題的關鍵。
create view subject_weighted_scores
with (security_invoker = true)
as
select
  ss.enrollment_id,
  ss.subject,
  ss.midterm,
  ss.final,
  ss.daily,
  (coalesce(ss.midterm, 0) * gr.midterm_weight
   + coalesce(ss.final, 0) * gr.final_weight
   + coalesce(ss.daily, 0) * gr.daily_weight) as subject_weighted_score
from subject_scores ss
join enrollments e on e.id = ss.enrollment_id
join classes c on c.id = e.class_id
join grading_rules gr
  on gr.academic_year = c.academic_year
  and gr.term = e.term;

-- ---------- 3. 依「該學生實際年級」的科目比重(curriculum)加總成基礎總分 ----------
create view student_base_scores
with (security_invoker = true)
as
select
  sw.enrollment_id,
  sum(sw.subject_weighted_score * cu.weight) as base_total
from subject_weighted_scores sw
join enrollments e on e.id = sw.enrollment_id
join classes c on c.id = e.class_id
join curriculum cu
  on cu.academic_year = c.academic_year
  and cu.term = e.term
  and cu.grade_level = c.grade_level   -- 關鍵：用學生自己班級的年級，不是共用選擇器
  and cu.subject = sw.subject
group by sw.enrollment_id;

-- ---------- 4. 套用目前啟用中的加扣分規則（score_adjustments，目前預設全部停用） ----------
create view student_adjustments
with (security_invoker = true)
as
select
  e.id as enrollment_id,
  coalesce(sum(sa.points), 0) as adjustment_total
from enrollments e
join classes c on c.id = e.class_id
left join score_adjustments sa
  on sa.academic_year = c.academic_year
  and sa.term = e.term
  and sa.is_active = true
group by e.id;

-- ---------- 5. 最終總分 ----------
create view student_total_scores
with (security_invoker = true)
as
select
  b.enrollment_id,
  round(b.base_total, 2) as base_total,
  a.adjustment_total,
  round(b.base_total + a.adjustment_total, 2) as total_score
from student_base_scores b
join student_adjustments a on a.enrollment_id = b.enrollment_id;

-- ---------- 6. 班排名 / 全校排名 ----------
-- 注意：排名必須先在「完整班級範圍」內算好，才能過濾可見範圍——
-- 不然如果先過濾掉任課教師看不到的學生，剩下的人排名會算錯。
create view class_rankings
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
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
) ranked
where (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from classes c2
      where c2.id = ranked.class_id
        and c2.homeroom_teacher_id = current_teacher_id()
    )
  )
  -- 關鍵限制：導師必須先送出平時分並按下鎖定，該班的總分/排名才會顯示出來，
  -- 避免導師看到排名結果後，回頭調整平時分「喬」名次。
  and exists (
    select 1 from submission_windows sw
    where sw.data_type = '平時分'
      and sw.scope = '班級'
      and sw.scope_ref = ranked.class_id::text
      and sw.academic_year = ranked.academic_year
      and sw.term = ranked.term
      and sw.is_locked = true
  );

-- ---------- 7. 同年級跨班排名（例如全校「1年級」所有班級的學生放在一起比排名） ----------
create view grade_rankings
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
    ) as grade_rank
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
) ranked
where (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from classes c2
      where c2.id = ranked.class_id
        and c2.homeroom_teacher_id = current_teacher_id()
    )
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
