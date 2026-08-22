-- ============================================================
-- 45. 修正：「總分」應該是各科直接加總，「平均」才需要計算各科比重
-- ------------------------------------------------------------
-- 你的說明：「總成績計算方式:總分直接是各科加總,平均才要計算它的各科比重。」
--
-- 對照 sql/41score_entry_fixes.sql 當初的寫法，這裡剛好是反過來的：
--   {type}_total   = sum(該科分數 * curriculum.weight)   ← 有乘比重，這是錯的
--   {type}_average = avg(該科分數)                       ← 沒乘比重，這是錯的
--
-- 這裡把 student_examtype_totals 的公式對調：
--   {type}_total   改成「各科分數直接加總」（不乘比重）
--   {type}_average 改成「依各科比重加權平均」（原本 _total 的算法搬過來）
--
-- 這張 view 同時餵給兩個地方：
--   1. 【班級成績總表】頁（ClassSummaryTab.tsx）的期中/期末/平時「總分」「平均」
--      兩欄——這是這次真正要修正的地方，欄位名稱跟畫面標籤本來就沒有對齊。
--   2. 成績單「學業平均」列的期中/期末/平時三欄——這三欄本來就是要顯示「平均」，
--      对調後改讀 _average 欄位即可，數字結果不變（見下面 lib/reportCard.ts 的修改）。
--
-- 【還沒處理、需要你確認的部分】
-- 「學業平均」列最右邊的「總分」欄（成績單上顯示的那個綜合總分，也是全班/年級
-- 排名用的依據，資料庫欄位是 student_total_scores.total_score）目前還是「依各科
-- 比重加權」算出來的——我們拿你原本給的 AI.xlsx 樣本反推驗證過，樣本上那個總分
-- 欄位顯示 77.25，換算下來剛好等於「依各科比重加權平均」，不是「各科直接加總」
-- （直接加總的話，樣本那些分數加起來會是 800 這種量級，不是 77.25）。
-- 這裡还没有跟着一起改，先維持原樣（加權），因為：
--   (a) 這個數字目前也是全班/年級排名的依據，如果改成「各科直接加總」，量級會變成
--       800~900 左右（依科目數量而定），且不同班科目數不同的話彼此還不能直接比較，
--       拿來排名可能不是你要的效果；
--   (b) 這正好跟你原本樣本上顯示的數字（77.25）對得起來，如果照這次的說明整個換成
--       直接加總，這個位置顯示的數字會變得跟你原本給的樣本對不起來。
-- 麻煩確認一下：這個「綜合總分／排名依據」的欄位，到底要維持現在的「加權平均」，
-- 還是也要改成「各科直接加總」（如果改成直接加總，排名依據可能要另外討論用什麼
-- 欄位比較合理，因為直接加總沒辦法讓不同科目數的班級公平比較）。
-- ============================================================

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

-- class_rankings / grade_rankings / class_rankings_for_class / grade_rankings_for_class
-- 都是直接把 student_examtype_totals 的欄位原樣帶出去（沒有另外重新計算），所以這幾個
-- view／函式不用跟著改，{type}_total／{type}_average 的意義已經自動對調過來了。

NOTIFY pgrst, 'reload schema';
