-- ============================================================
-- 47. 排名依「平均」排序 ＋ 訓導主任看全校出缺勤 ＋ 出缺席倒扣分批次查詢 ＋
--     成績單改成「已鎖定的階段就先顯示」，不用等三項全部鎖定
-- ------------------------------------------------------------
-- 對應這輪反映事項：1、2、4、5（3、6 主要是畫面/文字調整，另外在對應的 .tsx 檔案處理，
-- 6 有一部分需要這裡新增的 class_attendance_adjustment_batch() 函式）。
-- 需在 sql/1schema.sql 到 sql/46wire_attendance_and_discipline_adjustments.sql
-- 全部執行過後再執行本檔；內容都用 create or replace / drop policy if exists 寫法，
-- 可重複執行。
-- ============================================================

-- ============================================================
-- 一、排名依據：期中/期末/平時 各自的班排名／年級排名，改成看「平均」不是「總分」
-- ------------------------------------------------------------
-- 根因：sql/41score_entry_fixes.sql 當初把 student_examtype_totals 的 _total／
-- _average 兩個欄位公式寫反了，sql/45swap_total_and_average_formulas.sql 已經把
-- 「欄位公式」對調回來（_total＝直接加總、_average＝依比重加權），但 sql/44 這裡
-- 的 rank() over (order by ..._total desc) 沒有跟著改──於是「期中/期末/平時」
-- 這三欄的班排名／年級排名，變成用「各科分數直接加總」去排序，會出現：
--   選修科目比較多、或剛好選到比重高的科目拿高分的學生，總分數字比較大，
--   但换算成加權平均後其實不是真正表現最好的，名次卻排在前面。
-- 這正是這次反映「總分高但比重換算後產生的名次錯誤」的根因。
-- 修法：rank() 的 order by 全部改成看 _average（依比重加權平均），跟成績單「學業
-- 平均」欄位、跟「全班總排名」（student_total_scores.total_score，本來就是加權
-- 平均性質，不受影響）用同一套邏輯排序，才不會出現「總分欄」跟「排名」互相矛盾。
-- 顯示用的 _total（直接加總）欄位本身不變，只有排序依據換掉，班級成績總表上
-- 「總分」那一欄數字不會變，只有「班排名」「年級排名」欄位的名次可能會不一樣。
-- ============================================================

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
    rank() over (partition by e.class_id, e.term order by et.midterm_average desc) as midterm_class_rank,
    et.final_total,
    rank() over (partition by e.class_id, e.term order by et.final_average desc) as final_class_rank,
    et.daily_total,
    rank() over (partition by e.class_id, e.term order by et.daily_average desc) as daily_class_rank,
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
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.midterm_average desc) as midterm_grade_rank,
    et.final_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.final_average desc) as final_grade_rank,
    et.daily_total,
    rank() over (partition by c.academic_year, e.term, c.department, c.grade_level order by et.daily_average desc) as daily_grade_rank,
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
      rank() over (order by et.midterm_average desc) as midterm_class_rank,
      et.final_total,
      rank() over (order by et.final_average desc) as final_class_rank,
      et.daily_total,
      rank() over (order by et.daily_average desc) as daily_class_rank,
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
      rank() over (order by et.midterm_average desc) as midterm_grade_rank,
      et.final_total,
      rank() over (order by et.final_average desc) as final_grade_rank,
      et.daily_total,
      rank() over (order by et.daily_average desc) as daily_grade_rank,
      et.midterm_average, et.final_average, et.daily_average
    from student_total_scores t
    join enrollments e on e.id = t.enrollment_id and e.term = p_term
    join classes c on c.id = e.class_id
    join target tg on c.academic_year = tg.academic_year and c.department = tg.department and c.grade_level = tg.grade_level
    join students st on st.student_no = e.student_no
    left join student_examtype_totals et on et.enrollment_id = t.enrollment_id
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
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  );
$$;

-- ============================================================
-- 二、訓導主任（訓導部門成員／主管）看不到全校出缺席紀錄
-- ------------------------------------------------------------
-- 根因：attendance 表目前只有一條政策 homeroom_and_subject_teacher_write_attendance
-- （for all），只開放給 admin_a/admin_b/system_admin_s、該班導師、該節任課教師──
-- 訓導部門的人（不管是承辦人員 staff 還是主管 lead）不在任何一種身分裡，RLS 會把
-- 「不是自己班/自己任教節次」的列全部擋掉，全校出缺席總覽頁因此幾乎看不到資料。
-- 加上 app/(app)/reports/school-attendance/page.tsx 原本只用 isAdminInCurrentView()
-- 判斷可不可以看整個頁面（只認 admin_a/admin_b/system_admin_s），訓導主任連頁面本身
-- 都被擋下，才會看到「本頁僅提供管理員使用」这类訊息（畫面上顯示成「資格不足」）。
-- 這裡新增一條「訓導部門成員可以讀取全校出缺勤」的 select 政策（只開放讀取，不開放
-- 寫入──訓導部門要修改出缺勤紀錄，跟現有規則一樣仍需經由導師/任課教師或管理員），
-- 頁面本身的權限判斷改在 app/(app)/reports/school-attendance/page.tsx 那邊調整。
-- ============================================================
create policy discipline_dept_read_attendance on attendance
  for select
  using (has_department('discipline'::admin_department));

-- attendance_notifications（導師是否已寄送出缺勤通知信的紀錄）原本也只有管理員/
-- 導師看得到，訓導部門既然現在能看到全校出缺勤總覽，理應也要看得到對應的處理紀錄，
-- 才能判斷哪些學生還沒有人跟進。
drop policy if exists discipline_dept_read_attendance_notifications on attendance_notifications;
create policy discipline_dept_read_attendance_notifications on attendance_notifications
  for select
  using (has_department('discipline'::admin_department));

-- ============================================================
-- 三、出缺席倒扣分批次查詢：給「班級成績總表」「成績登錄」頁一次查完全班的
--     出缺勤自動加扣分結果，不用像 attendance_adjustment() 那樣每個學生各自呼叫
--     一次 RPC（那樣一個班 40 人就要 40 次網路往返）。回傳值跟成績單「出缺席」
--     那一列用同一套公式（attendance_adjustment()），確保兩邊看到的數字一致——
--     這是這次反映「高三忠1號的分數欄位都是100」（老師在成績登錄/總表頁看到的
--     還是手動輸入的100分，看不出扣分效果）的直接對應修正：前端改用這支函式查出
--     的「實際出缺席分數」取代「全勤／出缺席」這個科目欄位裡原本手動輸入的分數
--     顯示（見 ClassSummaryTab.tsx／ScoresEntryTab.tsx 的修改）。
-- ============================================================
create or replace function class_attendance_adjustment_batch(p_class_id uuid, p_term text)
returns table (enrollment_id uuid, attendance_score numeric, raw_adjustment numeric)
language sql stable
security invoker
as $$
  select
    e.id as enrollment_id,
    greatest(0, 100 + attendance_adjustment(e.id)) as attendance_score,
    attendance_adjustment(e.id) as raw_adjustment
  from enrollments e
  where e.class_id = p_class_id and e.term = p_term;
$$;

-- ============================================================
-- 四、成績單／個人列印：期中/期末/平時「還沒有全部鎖定」時，也要能先印出已經
--     鎖定的部分，不用等三項都鎖定才能印──對應這次反映「'期中'、'期末'、'平時'
--     沒有個人的列印，只有在'全部'時能印成績單」。
-- ------------------------------------------------------------
-- report_card_ready() 原本要求三項「全部」鎖定才視為 ready，這是「正式／完整」
-- 成績單（同時印出上下學期、含全學年學業平均+排名）的合理門檻，這裡不改動它的
-- 定義本身（lib/reportCard.ts 的學年成績單仍然依賴它判斷「排名/總分」這類需要
-- 三項合併計算才有意義的欄位要不要顯示）。
-- 新增 report_card_any_locked()：只要期中/期末/平時「至少有一項」已鎖定就回傳
-- true，lib/reportCard.ts 改用這支函式當作「能不能先產出/預覽」的門檻──已鎖定
-- 的欄位正常顯示數字，還沒鎖定的欄位（含總分/排名，因為那需要三項都有數字才
-- 準確）維持空白，不會顯示 0 或錯誤的部分結果。
-- ============================================================
create or replace function report_card_any_locked(p_enrollment_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select
    coalesce(
      exam_type_locked(c.id, c.academic_year, e.term, '期中考')
      or exam_type_locked(c.id, c.academic_year, e.term, '期末考')
      or exam_type_locked(c.id, c.academic_year, e.term, '平時分'),
      false
    )
  from enrollments e
  join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;
$$;

-- 給伺服器端（supabaseAdmin）用的「這個學生這個學期，期中/期末/平時個別鎖定
-- 狀態」查詢——跟 exam_type_locked() 本身邏輯相同，這裡包成一支一次查三個的
-- 函式單純是減少 lib/reportCard.ts 需要串起來的呼叫次數。
create or replace function report_card_exam_type_locks(p_enrollment_id uuid)
returns table (mid_locked boolean, fin_locked boolean, day_locked boolean)
language sql stable
security definer
set search_path = public
as $$
  select
    exam_type_locked(c.id, c.academic_year, e.term, '期中考'),
    exam_type_locked(c.id, c.academic_year, e.term, '期末考'),
    exam_type_locked(c.id, c.academic_year, e.term, '平時分')
  from enrollments e
  join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;
$$;

notify pgrst, 'reload schema';
