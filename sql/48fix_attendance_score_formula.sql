-- ============================================================
-- 48. 出缺席分數公式修正：改成跟其他科目一樣，用比重(3%)加權後分別放入
--     期中/期末/平時，不再是「總分算完之後另外加減一個固定值」
-- ------------------------------------------------------------
-- 對應這輪反映事項 1、2：
--   1. 出缺席分數：拿到全勤（這學期完全沒有曠課/遲到/病假/事假/公假紀錄）才是
--      100分；只要有任何一筆紀錄，分數＝【整體佔比與加扣分規則】裡對應項目的
--      點數 × 次數，直接加總（可以是很大的負數，例如 -43，不會停在0，也不會
--      先假設有100分底再扣）。
--   2. 學業平均期中/期末/平時沒有顯示、總分計算公式錯誤：正確公式應該是「先把
--      出缺席分數當成一個比重3%的科目，跟其他科目一樣分別計入期中/期末/平時
--      三欄」，再用【整體佔比與加扣分規則】的期中35%+期末35%+平時30%合併成
--      學期總分——不是把出缺席另外獨立算完、最後再整個加減一次。
--
-- 根因回顧：sql/46wire_attendance_and_discipline_adjustments.sql 當初是把「全勤／
-- 出缺席」整個排除在正常科目計算之外（怕跟老師手動輸入的分數重複計算兩次），改成
-- 「先算出一個總分，最後再加減一個固定調整值」的做法（attendance_adjustment()）。
-- 這個做法有兩個問題：(a) 調整值的公式本身是「全勤 → 比重*100（例如+3分）；有
-- 缺勤 → 直接扣原始扣分點數（例如-1.3分），沒有再乘上比重」，兩種情況的計算方式
-- 不一致，且都只在「總分」這個單一數字上加減一次，沒有反映在期中/期末/平時
-- 個別欄位——這正是這次反映「學業平均期中/期末/平時沒有顯示」「總分公式算錯」的
-- 根因；(b) lib/reportCard.ts、class_attendance_adjustment_batch()（上一輪新增）
-- 沿用同一個誤解，把它當成「100分為基準再加減」，也是錯的（「100是拿到全勤的人
-- 才有」，不是每個人都從100開始扣）。
--
-- 這裡改成：出缺席「本身」就是一個科目分數（跟國文、數學一樣），期中/期末/平時
-- 三欄放同一個值（因為出缺勤紀錄不分期中考/期末考時段，是整學期累計），再让它
-- 正常流過「科目分數 → 乘上科目比重(3%) → 依期中35%/期末35%/平時30%合併」這一整套
-- 既有的計算邏輯（sql/3calculations.sql 的 subject_weighted_scores／
-- student_base_scores／student_examtype_totals），不需要再另外寫一套「調整值」邏輯，
-- 也不會有「老師手動輸入的分數」跟「自動計算的分數」同時被計入兩次的問題（因為
-- 這裡從根本把「全勤／出缺席」這個科目的原始分數來源，從「scores 表裡老師手動輸入
-- 的值」直接換成「這裡算出來的值」，老師即使還是在成績登錄頁輸入了分數，那個值
-- 從這一步開始就不會被用到）。
-- ============================================================

-- ---------- 1. 出缺席分數：拿到全勤才是100，否則＝扣分點數直接加總（不設下限）----------
create or replace function attendance_score(p_enrollment_id uuid)
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
  v_deduction numeric := 0;
begin
  select e.student_no, c.academic_year, e.term
    into v_student_no, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if v_student_no is null then
    return null;
  end if;

  select term_start_date, term_end_date into v_start, v_end
  from academic_terms
  where academic_year = v_academic_year and term = v_term;

  if v_start is null or v_end is null then
    return null;
  end if;

  select coalesce(sum(cpd.points), 0) into v_deduction
  from attendance a
  join conduct_point_defaults cpd on cpd.item = a.status::text
  where a.student_no = v_student_no
    and a.record_date between v_start and v_end
    and a.status <> '出席';

  -- 完全沒有任何一筆曠課/遲到/病假/事假/公假紀錄（真正全勤）才給100分；
  -- 只要有紀錄，即使剛好加總=0（例如所有紀錄的參考點數都設成0），也照原始
  -- 加總結果顯示（=0），不會被誤判成「全勤」而給100分。
  select case when not exists (
    select 1 from attendance a
    where a.student_no = v_student_no
      and a.record_date between v_start and v_end
      and a.status <> '出席'
  ) then 100 else v_deduction end into v_deduction;

  return v_deduction;
end;
$$;

comment on function attendance_score(uuid) is
  '這個學生這個學期的「出缺席」科目分數：全勤=100分，否則=依【整體佔比與加扣分規則】
   加總的扣分點數（不設下限，可以是很大的負數）。跟其他科目一樣，之後會再乘上科目比重
   (curriculum.weight，例如3%) 才會反映到總分，這裡回傳的是分數本身，不是已經乘過比重
   的貢獻值。';

-- ---------- 2. 讓「全勤／出缺席」這個科目，改成用上面這支函式的結果，正常參與 ----------
-- subject_scores 原本純粹從 scores 表（老師手動輸入的分數）整理而來；這裡改成
-- 用 union，把「全勤／出缺席」這個科目名稱的資料來源換成 attendance_score()——
-- 每個年級每學期的課程設定(curriculum)裡，只要有一列科目叫「全勤」或「出缺席」，
-- 這個班所有學生都會有這一列，值＝attendance_score()，期中/期末/平時三欄放同一個值。
-- 老師在成績登錄頁手動輸入這個科目分數的舊資料，從這裡開始不會再被採用（畫面上
-- 已經有提示文字說明這件事，見 ClassSummaryTab.tsx／ScoresEntryTab.tsx）。
create or replace view subject_scores
with (security_invoker = true)
as
select
  enrollment_id,
  subject,
  max(score) filter (where exam_type = '期中考') as midterm,
  max(score) filter (where exam_type = '期末考') as final,
  max(score) filter (where exam_type = '平時分') as daily
from scores
where subject not in ('全勤', '出缺席')
group by enrollment_id, subject
union all
select
  e.id as enrollment_id,
  cu.subject,
  attendance_score(e.id) as midterm,
  attendance_score(e.id) as final,
  attendance_score(e.id) as daily
from enrollments e
join classes c on c.id = e.class_id
join lateral (
  -- 防呆：萬一「科目與比重設定」裡「全勤」跟「出缺席」兩個名稱都各自設定了一筆
  -- 比重>0 的資料（例如舊資料沒清乾淨、或不同學期換過名稱但沒刪掉舊的），這裡
  -- 只取一筆（優先取「出缺席」），避免同一個學生的出缺席分數被算重複兩次
  -- ──這種重複計算，會讓「學業平均」的期中/期末/平時因為多算了一次負的分數，
  -- 出現數字對不上、甚至方向錯誤的情形。
  select cu.subject, cu.weight
  from curriculum cu
  where cu.academic_year = c.academic_year
    and cu.term = e.term
    and cu.grade_level = c.grade_level
    and cu.subject in ('全勤', '出缺席')
    and cu.weight > 0
  order by (cu.subject = '出缺席') desc
  limit 1
) cu on true;

-- ---------- 3. student_examtype_totals／student_base_scores：拿掉排除「全勤/出缺席」的條件 ----------
-- sql/46 當初特別把這兩個 view 排除「全勤/出缺席」，是為了避免跟它自己新增的
-- attendance_adjustment() 調整值重複計算——現在「全勤/出缺席」已經直接透過
-- subject_scores 用正確的值正常參與計算，不需要再排除，也不再需要 attendance_adjustment()
-- 這個額外的調整值（見下面第4步），兩者只會有一套算法，不會有「這裡排除、那裡又加回來」
-- 這種容易搞混、也容易漏改的設計。
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
group by sw.enrollment_id;

-- ---------- 4. student_adjustments：拿掉 attendance_adjustment() 這個調整值 ----------
-- 出缺勤已經直接反映在 base_total 裡（第2、3步），這裡不再另外加一次，避免雙重計算。
-- 只保留 score_adjustments（管理員手動登記的其他加扣分項目，目前預設全部停用）。
create or replace view student_adjustments
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

-- attendance_adjustment() 這支函式不再被任何 view 呼叫，但先保留定義（不 drop），
-- 避免有舊的前端快取/其他地方還在呼叫它時直接報錯；之後確認沒有地方在用了，
-- 可以再另外清掉。

-- ---------- 5. class_attendance_adjustment_batch()：改用新公式 ----------
-- 上一輪（sql/47）新增這支函式時，沿用了「100分為底再扣」的錯誤理解
-- （greatest(0, 100 + attendance_adjustment(e.id))），這裡改成直接回傳
-- attendance_score() 的原始值（全勤=100，否則=扣分點數加總，可以是負數，不設下限），
-- 跟成績單「出缺席」那一列、跟總分/排名實際採用的數字三邊一致。
create or replace function class_attendance_adjustment_batch(p_class_id uuid, p_term text)
returns table (enrollment_id uuid, attendance_score numeric, raw_adjustment numeric)
language sql stable
security invoker
as $$
  select
    e.id as enrollment_id,
    attendance_score(e.id) as attendance_score,
    attendance_score(e.id) as raw_adjustment
  from enrollments e
  where e.class_id = p_class_id and e.term = p_term;
$$;

notify pgrst, 'reload schema';
