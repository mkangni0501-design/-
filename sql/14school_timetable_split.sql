-- ============================================================
-- 學校課表 / 任課教師設定 拆分後需要的資料庫異動
-- 請在 Supabase SQL Editor 執行一次（schema.sql、policies.sql 都執行過之後再執行本檔）
-- ============================================================

-- 「任課教師設定」頁不再要求填星期/節次，只設定「誰教哪班哪科」，
-- 這種資料列會把 weekday / period_no 存成 null（代表「還沒指定實際時段」）。
-- 「學校課表」頁才會填入實際的星期/節次。
-- 原本 weekday / period_no 是 not null，需要放寬成可以是 null；
-- 放寬後原本的 unique (class_id, academic_year, term, weekday, period_no) 不受影響，
-- 因為 PostgreSQL 的 unique 限制對 null 值一律視為互不相同，
-- 所以同一班可以有多筆 weekday 為 null、不同科目的「任課教師設定」資料列，不會互相衝突。
alter table class_schedule alter column weekday drop not null;
alter table class_schedule alter column period_no drop not null;
