-- ============================================================
-- 出缺勤/獎懲「預設加扣分參考值」
-- 對應「整體佔比與加扣分規則」工作表右半部（曠課-0.1、嘉獎+1...等參考值）
-- 目前只是把這份參考資料存起來，不會自動套用到總成績計算
-- （總成績目前仍是純粹依 grading_rules + curriculum 計算，出缺勤不影響總分，見模組規格文件）。
-- 需在 schema.sql、policies.sql 執行後再執行本檔
-- ============================================================
create table if not exists conduct_point_defaults (
  item text primary key,   -- 例如 曠課、遲到、嘉獎、小功...
  points numeric(5,2) not null
);

alter table conduct_point_defaults enable row level security;
create policy read_conduct_point_defaults on conduct_point_defaults for select using (true);
create policy admin_write_conduct_point_defaults on conduct_point_defaults for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
