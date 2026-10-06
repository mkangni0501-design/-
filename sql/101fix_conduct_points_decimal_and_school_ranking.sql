-- ============================================================
-- 101. 修正兩個反映事項
-- ------------------------------------------------------------
-- (A) 獎懲登記「申請失敗 invalid input syntax for type integer: "0.1"」
--   根因：conduct_point_defaults.points 是 numeric(5,2)，管理員可以在
--   【整體佔比與加扣分規則】頁把嘉獎/警告等調成小數（例如 0.1）；前端送出申請時
--   points = 單次點數 × 次數 = 0.1，但
--     - conduct_event_requests.points（sql/95）是 int
--     - conduct_events.points（sql/1）是 int
--   Postgres 不會把 0.1 自動轉成整數，所以直接報錯。
--   修法：兩個欄位都改成 numeric(6,2)，跟 conduct_point_defaults 對齊。
--   discipline_adjustment()（sql/46）本來就是 sum(points) 回傳 numeric，不受影響。
--   decide_conduct_event_request()（sql/98）把 numeric 寫進 conduct_events.points，
--   改型別後不會再被截成整數。
--
-- (B) 全校排行榜「canceling statement due to statement timeout」
--   根因在前端：SchoolRankingsTab 查的是 class_rankings／grade_rankings 這兩個
--   「全校範圍」的 view，會一次算 1300+ 位學生；sql/50 已經針對這個問題做過
--   class_rankings_for_class()／grade_rankings_for_class()（單班／單年級範圍），
--   全校排行榜頁卻沒有改用。這次只改前端（逐班呼叫這兩支函式），這裡不需要改函式，
--   只補上一個加速查詢用的索引。
-- ============================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conduct_event_requests'
      and column_name = 'points' and data_type = 'integer'
  ) then
    alter table public.conduct_event_requests
      alter column points type numeric(6,2) using points::numeric;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conduct_events'
      and column_name = 'points' and data_type = 'integer'
  ) then
    alter table public.conduct_events
      alter column points type numeric(6,2) using points::numeric;
  end if;
end $$;

-- 排名函式內 discipline_adjustment() 每位學生都會用 student_no + event_date 查一次
create index if not exists idx_conduct_events_student_date
  on public.conduct_events (student_no, event_date);

notify pgrst, 'reload schema';
