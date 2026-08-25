-- ============================================================
-- 2026-08-24 修正：家長/學生查詢入口讀取成績速度非常緩慢
-- ============================================================
-- 根因：app/(app)/portal/page.tsx 讀「歷年成績＋班排名＋年級排名」時，是對
-- sql/6portal.sql 定義的 class_rankings／grade_rankings 這兩個「全校通用」
-- view 下 `.in('enrollment_id', [這個學生的學期紀錄])` 查詢。這兩個 view 本身
-- 完全沒有先篩選範圍——view 內部的 rank() over (...) 是對「全校」所有班級/
-- 所有學生一次算完，才在最外層用 enrollment_id in (...) 篩出這個學生要的
-- 那幾筆。也就是說，即使一個學生只讀過3個學期、只需要3個學期的排名，
-- 資料庫每次還是得先把全校（範例學校規模：1300多位學生）所有班級、
-- 所有學期的排名整個算一遍，篩選在「算完之後」才發生，篩選條件完全沒辦法
-- 讓資料庫提早縮小運算範圍。sql/44fix_report_card_and_ranking_performance.sql
-- 那輪的優化是解決「同一批 exam_type_locked() 判斷被重複呼叫」的問題，
-- 沒有解決「這兩個 view 從頭到尾都是全校範圍」這個更根本的問題，所以
-- 家長查詢頁還是慢。
--
-- sql/50fix_ranking_query_timeout.sql 那輪其實已經示範過同樣手法的解法
-- （class_rankings_for_class／grade_rankings_for_class，把範圍先縮小到
-- 「一個班」再算），只是那輪只處理了「查一整班」「查一整個年級」這種
-- 教師視角的頁面，沒有處理家長/學生查詢入口這種「查一個學生的歷年紀錄」
-- 視角——這輪比照同樣手法，另外寫一支 portal_student_academic_history()，
-- 一次把「這個學生讀過的每個學期」各自所屬的「班級」「年級同部別」範圍
-- 先抓出來，範圍一樣只有幾十~一兩百人（一個班或一個年級），不會去碰
-- 全校 1300 多位學生的資料，也不用再讓前端另外發 3 個查詢、自己在
-- JS 端用 Map 兜資料。
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
security invoker
as $$
  with target_enrollments as (
    -- 這個學生自己的每一筆學期紀錄；權限檢查放在這裡（跟 class_rankings_for_class／
    -- grade_rankings_for_class 用同一套規則：管理員/教務可以看任何學生，導師可以看
    -- 自己班上的學生，家長/學生本人只能看自己綁定的學號），沒有權限的話這個 CTE
    -- 直接是空的，後面全部連帶查不到東西，等同原本 view 的 where 子句效果。
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
  -- 班排名範圍：這個學生讀過的每個「班級＋學期」組合，各自抓「全班」的
  -- enrollment（不只是這個學生自己），排名才會準；一個學生正常只會讀過
  -- 少數幾個班級/學期，範圍遠小於全校。
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
  -- 年級排名範圍：這個學生讀過的每個「學年＋部別＋年級＋學期」組合，各自抓
  -- 「同年級同部別」的 enrollment，一樣只有一兩百人的範圍，不是全校。
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
   所有學期的總分＋班排名＋年級排名，範圍從一開始就限定在這個學生讀過的
   班級/年級，不會像 class_rankings／grade_rankings 這兩個通用 view 一樣
   每次都先算過全校才篩選，解決家長查詢頁「顯示小孩成績速度非常緩慢」的問題。
   權限規則跟 class_rankings_for_class／grade_rankings_for_class 一致。';

notify pgrst, 'reload schema';
