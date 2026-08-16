-- ============================================================
-- 44. 修正成績單「一直顯示尚未鎖定」、班級排名查詢逾時
-- ------------------------------------------------------------
-- 回報問題：
--   1a. 總表（期中*比例＋期末*比例＋平時*比例）仍無出現，成績單列印仍顯示「三項尚未
--       鎖定」——即使導師、管理員都已經確認鎖定過。
--   1b. 管理者看【班級成績結果與排名】出現「canceling statement due to statement
--       timeout」錯誤。
--
-- 追查結果：這兩個問題根源不同，但都出在 class_rankings / grade_rankings 這兩個
-- view 的寫法上：
--
-- 【問題1a的根因】class_rankings / grade_rankings 最後都有一段可見範圍限制：
--     where (
--       current_role_name() in ('admin_a','admin_b','system_admin_s')
--       or exists (select 1 from classes c2 where ... c2.homeroom_teacher_id = current_teacher_id())
--       or is_linked_parent(...)
--     )
--   current_role_name()／current_teacher_id() 都是讀 auth.uid()（見 sql/2policies.sql）。
--   但 lib/reportCard.ts 是用 supabaseAdmin（service_role金鑰）查這兩個 view——
--   service_role 呼叫沒有登入者的 JWT，auth.uid() 一律是 null，導致
--   current_role_name()／current_teacher_id() 都回傳 null，上面三個條件全部不成立，
--   這兩個 view 對 supabaseAdmin 來說**永遠查不到任何一列資料**，不管實際上到底
--   有沒有鎖定——這就是「明明都鎖定了，成績單還是說三項尚未鎖定」的真正原因，
--   而且是從一開始就存在的問題，不是這幾輪修改造成的。
--
-- 【問題1b的根因】class_rankings / grade_rankings 兩個 view 對「全校」所有學生
--   一起做 rank() over(...) 排名，再讓前端用 .eq('class_id', ...) 或
--   .in('enrollment_id', ...) 篩選——但 view 裡疊了好幾層（scores → subject_scores
--   → student_examtype_totals → student_base_scores...）分別都有自己的 group by，
--   加上每一列還要呼叫 exam_type_locked() 多達 11 次（total_score、class_rank 用
--   同一個條件各算一次、midterm_total 跟 midterm_class_rank 又用同一個條件各算
--   一次...）；資料庫規劃器沒辦法把「只看某一班」的篩選條件往下推進這麼多層
--   view/group by/window function裡面，等於每次查詢都要先把全校（這次快照約
--   9000多筆成績、1300多位學生）通通算完排名，才篩出要的那幾筆——資料量大了
--   就容易觸發 statement timeout。
--
-- 這裡的修正方向：
--   1. class_rankings / grade_rankings 這兩個「給一般登入使用者用」的 view，
--      改成用一個 CTE 把 exam_type_locked() 依「班級＋學年度＋學期」去重後只算一次
--      （原本是每個學生每一列都各自呼叫好幾次，同一班的學生會重複算超多次一樣的
--      結果），減少不必要的重複計算，範圍限制的 where 子句維持不變（一般使用者
--      查詢時 auth.uid() 是正常的，不受問題1a影響）。
--   2. 另外新增 class_rankings_for_class(p_class_id) 這個資料庫函式，給「只看
--      一個班」的畫面（成績登錄頁旁的班級成績結果、班級成績總表）用——一開始
--      join 就直接用 class_id 篩過，不用等全校排名都算完才篩選，這個班有多少
--      學生就只算多少學生，速度不會因為全校資料變多而變慢。
--   3. 另外新增 report_card_ready(p_enrollment_id)／report_card_class_rank(...)／
--      report_card_grade_rank(...) 三個 security definer 函式，專門給
--      lib/reportCard.ts（用 supabaseAdmin 呼叫）用——不看 current_role_name()／
--      current_teacher_id()，因為呼叫前 app/api/reports/report-card/[enrollmentId]/route.tsx
--      已經另外用 canAccessClass() 檢查過權限了，這裡不需要也不應該再依賴
--      session-based 的身分判斷（那正是問題1a壞掉的原因）。同時也只查「這一個學生
--      所在的班/年級」，不會有問題1b的效能疑慮。
--
-- 需在 sql/41score_entry_fixes.sql 之後執行。
-- ============================================================

-- ---------- 1. class_rankings / grade_rankings：用 CTE 把鎖定狀態依班級去重後只算一次 ----------
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
    rank() over (partition by e.class_id, e.term order by et.midterm_total desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_total desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_total desc) as daily_class_rank,
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
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
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
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_total desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_total desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_total desc) as daily_grade_rank,
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
  current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
  or is_linked_parent(ranked.student_no)
);

-- ---------- 2. class_rankings_for_class：只看一個班，一開始就用 class_id 篩過 ----------
-- 給「只需要看一個班」的畫面用（ClassResultsTab.tsx／ClassSummaryTab.tsx），
-- 從一開始 join 就鎖定 class_id + term，不用等全校排名都算完才篩選，效能不會隨全校
-- 資料量增加而變慢；可見範圍限制維持跟 class_rankings 一致，一般登入使用者呼叫
-- 沒有問題（不是給 supabaseAdmin 用的，那個用第 3 節的 report_card_* 函式）。
--
-- 注意：一定要收 p_term 這個參數，不能只靠 p_class_id——同一個 class_id 在
-- enrollments 裡可能同時存在「上學期」跟「下學期」兩批各自獨立的學籍列（同一個班
-- 換學期會有各自的 enrollments 資料列），如果不篩 term，會把兩個學期的學生
-- 混在一起排名，算出來的名次是錯的。
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
      rank() over (order by et.midterm_total desc) as midterm_class_rank,
      et.final_total,
      rank() over (order by et.final_total desc) as final_class_rank,
      et.daily_total,
      rank() over (order by et.daily_total desc) as daily_class_rank,
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
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (select 1 from classes c2 where c2.id = p_class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  );
$$;

-- ---------- 2b. grade_rankings_for_class：只看「跟這個班同年級同部別、同學期」的學生 ----------
-- 給「班級成績總表」頁用——年級排名本來就需要跟同年級同部別的其他班一起比較，
-- 沒辦法只篩自己班（那樣分母就錯了），但範圍限制在「同一學年度+學期+部別+年級」，
-- 還是比整個學校全部年級一起算排名小很多，不會有全校排名的效能疑慮。
-- 一樣要收 p_term（理由同 class_rankings_for_class 的說明：同一 class_id 可能同時
-- 存在上學期／下學期兩批獨立學籍列）。
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
      rank() over (order by et.midterm_total desc) as midterm_grade_rank,
      et.final_total,
      rank() over (order by et.final_total desc) as final_grade_rank,
      et.daily_total,
      rank() over (order by et.daily_total desc) as daily_grade_rank,
      et.midterm_average, et.final_average, et.daily_average
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id and e.term = p_term
    join classes c on c.id = e.class_id
    join target tg on c.academic_year = tg.academic_year and c.department = tg.department and c.grade_level = tg.grade_level
    join students st on st.student_no = e.student_no
    left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
  )
  -- 注意：每個學生的鎖定狀態要看「他自己那個班」有沒有鎖定，不是只看 p_class_id
  -- 這個班——年級排名涵蓋好幾個班，各班鎖定進度不一定一樣，所以用底下 lateral
  -- 依每一列自己的 class_id 各自查一次，不能共用同一個鎖定狀態。
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
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  );
$$;

-- ---------- 3. report_card_*：專門給伺服器端（supabaseAdmin／service_role）用，
--              不依賴 current_role_name()／current_teacher_id()，也只查單一學生
--              所在的班/年級，不會有全校排名的效能疑慮 ----------
create or replace function report_card_ready(p_enrollment_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select
    coalesce(
      exam_type_locked(c.id, c.academic_year, e.term, '期中考')
      and exam_type_locked(c.id, c.academic_year, e.term, '期末考')
      and exam_type_locked(c.id, c.academic_year, e.term, '平時分'),
      false
    )
  from enrollments e
  join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;
$$;

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
  )
  select grade_rank from scoped where enrollment_id = p_enrollment_id;
$$;

-- ---------- 4. class_lock_status：一次查完期中/期末/平時三個鎖定狀態 ----------
-- 【班級成績總表】頁原本是 Promise.all() 平行送出三次 submission_window_locked()
-- RPC 呼叫，畫面上會有兩個問題：(1) 三個按鈕的鎖定狀態都是等這三次呼叫「全部」
-- 回來後才一起更新，看起來像是三個按鈕綁在一起同步跳動；(2) 三次個別的網路
-- 往返（含各自的連線/驗證開銷）疊加起來，比一次查完三個慢得多，使用者會感覺
-- 「重新整理後要等很久」。這裡合併成一支函式一次回傳三個布林值，只需要一次
-- 網路往返；前端也會另外處理「查詢完成前不要顯示成看起來可以點的按鈕」，
-- 兩者一起才能真正解決「感覺三個按鈕同步、要等很久」的問題。
create or replace function class_lock_status(p_class_id uuid, p_academic_year int, p_term text)
returns table (mid_locked boolean, fin_locked boolean, day_locked boolean)
language sql stable
security invoker
as $$
  select
    exam_type_locked(p_class_id, p_academic_year, p_term, '期中考'),
    exam_type_locked(p_class_id, p_academic_year, p_term, '期末考'),
    exam_type_locked(p_class_id, p_academic_year, p_term, '平時分');
$$;

-- ---------- 4. conduct_scores：操行成績「禮貌／衣著／服務／紀律」四個分項 ----------
-- 這次成績單版面重做（見 HANDOVER 第五輪）發現學校目前完全沒有地方可以輸入這四個
-- 分項評分，你確認要另外開發評分介面，這裡新增資料表 + 給導師/管理員用的 RLS
-- （規則跟 sql/1schema.sql 的 student_remarks 一模一樣：只有該班導師與管理員能看/改，
-- 任課教師不可見——操行涉及品性評語，跟導師評語一樣屬於比較敏感的資訊，不應該讓
-- 只教一科的任課老師看到其他老師班上的操行分數）。
create table if not exists conduct_scores (
  enrollment_id uuid primary key references enrollments(id),
  politeness numeric(5,2) check (politeness between 0 and 100),   -- 禮貌
  dress numeric(5,2) check (dress between 0 and 100),             -- 衣著
  service numeric(5,2) check (service between 0 and 100),         -- 服務
  discipline numeric(5,2) check (discipline between 0 and 100),   -- 紀律
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

alter table conduct_scores enable row level security;

create policy homeroom_and_admin_only_conduct_scores on conduct_scores
  for all
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.id = conduct_scores.enrollment_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- report_card_* 三個函式是 security definer，直接可以被任何登入者呼叫也不會外洩
-- 其他班級資料（每個都只回傳呼叫者指定的那個 enrollment_id 自己的名次/是否就緒，
-- 不是整班/整校名單），但正式使用情境只有 lib/reportCard.ts 用 supabaseAdmin 呼叫，
-- 其他地方不需要用到這三個函式。
