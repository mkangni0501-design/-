-- ============================================================
-- 修正：「節次設定」與「學生出缺席登錄」堂數不同步的問題
-- 原因：period_config 資料表原本沒有唯一鍵限制，只靠前端在新增時「先查有沒有現有列、
-- 沒有才新增」這個邏輯來避免重複；但這個「先查後寫」中間有空檔，只要快速連按兩次
-- 「新增／更新」、或兩個管理員前後腳幾乎同時儲存同一個範圍，就可能同時插入兩筆
-- scope+scope_ref+weekday 都相同、但 period_count 不同的資料列。
-- 「節次設定」頁本身把每一列都個別列出來（所以管理員看到的可能是其中一列），但
-- 「學生出缺席登錄」（getEffectivePeriodCount）用 .find() 從資料庫回傳、未指定排序的
-- 結果裡挑第一筆，兩邊可能挑到不同的那一筆，導致「設定完不同步、兩邊結果不同」。
--
-- 請在 Supabase SQL Editor 執行本檔一次即可。
-- ============================================================

-- 1) 先把既有重複資料清掉，同一個 scope+scope_ref+weekday 只保留「最後更新（id 最大/最新建立）」的一筆。
--    period_config 沒有 updated_at 欄位，這裡用「保留 ctid 較大（較晚寫入）的那一筆」來去重。
delete from period_config a
using period_config b
where a.scope = b.scope
  and coalesce(a.scope_ref, '') = coalesce(b.scope_ref, '')
  and a.weekday = b.weekday
  and a.ctid < b.ctid;

-- 2) 加上唯一鍵限制，之後同一個範圍不可能再插入第二筆，從資料庫層級杜絕不同步的可能。
--    scope_ref 允許為 null（僅「全校」時），所以分兩個唯一索引：null 一組、非 null 一組。
create unique index if not exists period_config_scope_ref_weekday_uk
  on period_config (scope, scope_ref, weekday)
  where scope_ref is not null;

create unique index if not exists period_config_scope_weekday_school_uk
  on period_config (scope, weekday)
  where scope_ref is null;
