-- ============================================================
-- 46. 出缺勤／懲獎 依「整體佔比與加扣分規則」自動加扣分
-- ------------------------------------------------------------
-- 對應這輪的說明：
--   2. 總表（期中*比例＋期末*比例＋平時*比例）還要增加出缺席的3%(全勤)或倒扣
--      ＝76.255*0.35+76.255*0.35+76.255*0.30-1.3(1*0.1+5*0.02+0.05*22)
--   3d. 科目最下方放入出缺席紀錄，如全勤則出缺席總分為100分；有曠課、遲到、事假
--       則以【整體佔比與加扣分規則】為扣分基準紀錄於上學期/下學期總分。
--   3e. 懲獎記錄則加扣於操行成績。
--
-- conduct_point_defaults 這張表（曠課-0.1、遲到-0.02、事假-0.05、嘉獎+1...）從
-- sql/7conduct_defaults.sql 建立以來，就如同該檔案自己的註解寫的：「目前只是把
-- 這份參考資料存起來，不會自動套用到總成績計算」——這裡是第一次真的把它接上去。
--
-- 這裡新增一支函式 attendance_adjustment(enrollment_id)，兩個地方共用（同一套公式，
-- 不會 SQL 一套、TypeScript 另一套，兩邊算出不同數字）：
--   (a) student_adjustments view：讓「總表」的總分自動反映出缺勤加扣分，全校/班級
--       排名都會用到。
--   (b) lib/reportCard.ts：成績單「出缺席」那一列要顯示的數字，直接呼叫同一支函式
--       （用 RPC），不會另外重算一次、也不會兩邊對不起來。
--
-- 邏輯（依你舉的例子驗證過）：
--   - 這個學期完全沒有曠課/遲到/病假/事假/公假紀錄（真正的全勤）→ 用該年級課程
--     設定裡「全勤」或「出缺席」這個科目的比重換算成加分（比重*100，例如3%→+3分）。
--   - 只要有任何一筆曠課/遲到/病假/事假/公假紀錄 → 改成用 conduct_point_defaults
--     的點數 × 次數加總（病假/公假目前參考值是0，不影響），不再給全勤加分——
--     兩者互斥，不會「先扣分又加分」疊加。
-- ============================================================

-- 【重要】避免重複計分：高三等年級的課程設定裡，「全勤」目前仍然是一個可以讓老師
-- 手動輸入分數的正常科目（跟其他科目一樣出現在成績登錄頁的科目下拉選單）。現在
-- attendance_adjustment() 已經會自動依真實出缺勤紀錄算加減分，如果同時還讓「全勤」
-- 這個科目繼續走原本「比重加權」的算法，會變成同一件事被算兩次（一次是自動加減分，
-- 一次是老師手動輸入分數乘上比重）。這裡把 student_examtype_totals／student_base_scores
-- 用到的科目範圍都排除掉名稱是「全勤」或「出缺席」的科目，改成完全由
-- attendance_adjustment() 負責這部分的分數——即使老師還是在成績登錄頁看得到「全勤」
-- 這個科目、也還是輸入了分數，那筆分數不會被排名/總分採用（不會報錯，只是不計入）。
--
-- 建議：既然這部分已經自動化，可以考慮把課程設定裡「全勤」這個科目的比重改成 0
-- （比重=0的科目本來就不會出現在成績登錄頁的科目下拉選單，見 sql/41 的說明），
-- 避免老師誤以為還需要手動輸入。要不要這樣做由你決定，這裡沒有自動幫你改課程設定。
create or replace view student_examtype_totals
with (security_invoker = true)
as
select
  ss.enrollment_id,
  sum(ss.midterm) filter (where ss.midterm is not null) as midterm_total,
  sum(ss.final) filter (where ss.final is not null) as final_total,
  sum(ss.daily) filter (where ss.daily is not null) as daily_total,
  round(sum(ss.midterm * cu.weight) filter (where ss.midterm is not null), 2) as midterm_average,
  round(sum(ss.final * cu.weight) filter (where ss.final is not null), 2) as final_average,
  round(sum(ss.daily * cu.weight) filter (where ss.daily is not null), 2) as daily_average
from subject_scores ss
join enrollments e on e.id = ss.enrollment_id
join classes c on c.id = e.class_id
join curriculum cu
  on cu.academic_year = c.academic_year
  and cu.term = e.term
  and cu.grade_level = c.grade_level
  and cu.subject = ss.subject
where cu.weight > 0
  and cu.subject not in ('全勤', '出缺席')
group by ss.enrollment_id;

create or replace view student_base_scores
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
  and cu.grade_level = c.grade_level
  and cu.subject = sw.subject
where cu.subject not in ('全勤', '出缺席')
group by sw.enrollment_id;

create or replace function attendance_adjustment(p_enrollment_id uuid)
returns numeric
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v_student_no text;
  v_academic_year int;
  v_term text;
  v_grade_level text;
  v_start date;
  v_end date;
  v_deduction numeric := 0;
  v_attendance_weight numeric;
begin
  select e.student_no, c.academic_year, e.term, c.grade_level
    into v_student_no, v_academic_year, v_term, v_grade_level
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if v_student_no is null then
    return 0;
  end if;

  select term_start_date, term_end_date into v_start, v_end
  from academic_terms
  where academic_year = v_academic_year and term = v_term;

  if v_start is null or v_end is null then
    return 0;
  end if;

  select coalesce(sum(cpd.points), 0) into v_deduction
  from attendance a
  join conduct_point_defaults cpd on cpd.item = a.status::text
  where a.student_no = v_student_no
    and a.record_date between v_start and v_end
    and a.status <> '出席';

  if v_deduction = 0 then
    select cu.weight * 100 into v_attendance_weight
    from curriculum cu
    where cu.academic_year = v_academic_year
      and cu.term = v_term
      and cu.grade_level = v_grade_level
      and cu.subject in ('全勤', '出缺席')
    limit 1;
    return coalesce(v_attendance_weight, 0);
  end if;

  return v_deduction;
end;
$$;

-- 只換掉 adjustment_total 這個欄位的算法（欄位名稱/數量都沒變，create or replace view
-- 不會有欄位順序衝突的問題），student_total_scores／class_rankings／grade_rankings
-- 這些疊在上面的 view 完全不用跟著改，會自動吃到新的加扣分結果。
create or replace view student_adjustments
with (security_invoker = true)
as
select
  e.id as enrollment_id,
  coalesce(sum(sa.points), 0) + attendance_adjustment(e.id) as adjustment_total
from enrollments e
join classes c on c.id = e.class_id
left join score_adjustments sa
  on sa.academic_year = c.academic_year
  and sa.term = e.term
  and sa.is_active = true
group by e.id;

-- 懲獎記錄加扣於操行成績（3e）：新增函式，跟出缺勤那支同樣的設計，
-- lib/reportCard.ts／components/admin-tabs/ConductScoresTab.tsx 都會呼叫這支，
-- 確保「操行成績＝禮貌/衣著/服務/紀律的平均，再加減懲獎點數」這件事只有一套算法。
-- 注意：這裡直接加總 conduct_events.points（每一筆事件記錄當下自己存的點數），
-- 不是重新去查 conduct_point_defaults 現在的參考值——這樣以後如果調整參考值，
-- 不會連帶把已經發生的舊紀錄的點數也跟著改掉，比較符合「記錄當下的規則」這個原則。
create or replace function discipline_adjustment(p_enrollment_id uuid)
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
  v_adjustment numeric := 0;
begin
  select e.student_no, c.academic_year, e.term
    into v_student_no, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if v_student_no is null then
    return 0;
  end if;

  select term_start_date, term_end_date into v_start, v_end
  from academic_terms
  where academic_year = v_academic_year and term = v_term;

  if v_start is null or v_end is null then
    return 0;
  end if;

  select coalesce(sum(ce.points), 0) into v_adjustment
  from conduct_events ce
  where ce.student_no = v_student_no
    and ce.event_date between v_start and v_end;

  return v_adjustment;
end;
$$;

-- ---------- 5. report_card_style：管理員可自訂成績單顏色/字級/邊框/文字標籤 ----------
-- 只存「長得怎樣」的設定（顏色、字級、邊框粗細、文字標籤），不存任何資料綁定邏輯——
-- 資料從哪個欄位來，還是寫死在 lib/ReportCardDocument.tsx 的程式碼裡，管理員上傳的
-- 設定檔改不到這部分。整個學校共用一份現在生效中的設定（is_active=true 那筆）。
create table if not exists report_card_style (
  id uuid primary key default gen_random_uuid(),
  name text not null default '預設樣式',
  config jsonb not null,
  is_active boolean not null default false,
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

alter table report_card_style enable row level security;

create policy read_report_card_style on report_card_style for select using (true);
create policy admin_write_report_card_style on report_card_style for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

NOTIFY pgrst, 'reload schema';
