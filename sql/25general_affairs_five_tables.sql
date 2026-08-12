-- ============================================================
-- 第三期 SQL：總務處 5 張表格
-- ① 書庫登記表　② 校服庫存販賣表　③ 簿本庫存販賣表　④ 修繕登記　⑤ 水電網路等費用
--
-- 設計說明（採規劃書建議的「共用庫存樣板」）：
--   ①②③ 性質都是「一批品項＋進出紀錄」，共用同一組「品項主檔＋進出紀錄」樣板，
--   用 category 欄位區分書庫/校服/簿本，不用各建一張長得幾乎一樣的表。
--   ④ 修繕登記是「案件追蹤」（待處理→處理中→已完成），跟庫存性質不同，另外建表。
--   ⑤ 水電網路費用是「每月一筆帳單金額」，最單純，另外建一張小表即可。
--
-- 執行順序：schema.sql → ... → 06 → 本檔(07)
-- ============================================================

create type general_item_category as enum ('書庫', '校服', '簿本');
create type ledger_direction as enum ('入庫', '售出', '借出', '歸還', '調整', '報損');

-- ============================================================
-- 一、書庫／校服／簿本 共用：品項主檔
-- ============================================================
create table if not exists general_inventory_items (
  id uuid primary key default gen_random_uuid(),
  category general_item_category not null,
  name text not null,               -- 書名／校服品名／簿本品名
  spec text,                        -- 規格（例如：作者、ISBN、尺寸、年級適用）
  unit text not null default '件',  -- 計量單位（本、件、套…）
  unit_price numeric(10,2),         -- 售價（書庫借閱可留空）
  quantity_on_hand int not null default 0, -- 目前庫存（由下面 transactions 觸發器自動維護，不要手動改這欄）
  note text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 二、進出紀錄（進貨/售出/借出/歸還/庫存調整/報損），庫存量由此推算
-- ============================================================
create table if not exists general_inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references general_inventory_items(id) on delete cascade,
  direction ledger_direction not null,
  quantity int not null check (quantity > 0),
  unit_price_at_time numeric(10,2), -- 售出時的實際單價（供計算營收用，書庫借還可留空）
  counterparty text,                 -- 買家/借閱人姓名或學號（非必填）
  note text,
  recorded_by uuid references app_users(id),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_general_inventory_tx_item on general_inventory_transactions(item_id);

-- 進出紀錄異動時，自動重新計算該品項目前庫存（入庫/歸還 +，售出/借出/報損 -，調整可正可負由 quantity 正負號記，這裡固定用正數搭配方向判斷）
create or replace function recompute_inventory_stock() returns trigger as $$
declare
  v_item_id uuid;
begin
  v_item_id := coalesce(new.item_id, old.item_id);
  update general_inventory_items
  set quantity_on_hand = (
    select coalesce(sum(
      case direction
        when '入庫' then quantity
        when '歸還' then quantity
        when '售出' then -quantity
        when '借出' then -quantity
        when '報損' then -quantity
        when '調整' then quantity  -- 「調整」統一視為正向修正，要減少庫存請用「報損」
      end
    ), 0)
    from general_inventory_transactions
    where item_id = v_item_id
  )
  where id = v_item_id;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_recompute_inventory_stock on general_inventory_transactions;
create trigger trg_recompute_inventory_stock
  after insert or update or delete on general_inventory_transactions
  for each row execute function recompute_inventory_stock();

-- ============================================================
-- 三、修繕登記（案件追蹤）
-- ============================================================
create table if not exists maintenance_tickets (
  id uuid primary key default gen_random_uuid(),
  location text not null,           -- 地點（例如：三年一班、圖書館二樓）
  issue text not null,              -- 問題描述
  status text not null default '待處理' check (status in ('待處理', '處理中', '已完成', '取消')),
  reported_by uuid references app_users(id),
  assigned_to text,                 -- 承辦廠商/人員姓名（非必填，先用文字欄位，不強制對應到帳號）
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  note text
);

-- ============================================================
-- 四、水電網路等費用
-- ============================================================
create table if not exists utility_bills (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('水費', '電費', '網路費', '其他')),
  billing_month date not null,      -- 用該月份第一天代表「哪個月份的帳單」
  amount numeric(10,2) not null,
  paid boolean not null default false,
  paid_date date,
  note text,
  recorded_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (category, billing_month)
);

-- ============================================================
-- 五、RLS：全校教職員可讀（庫存/費用不算敏感資料，方便大家查詢），
--        只有身兼「總務」部門(lead)或系統管理員S能直接寫，staff走送審機制
-- ============================================================
alter table general_inventory_items enable row level security;
alter table general_inventory_transactions enable row level security;
alter table maintenance_tickets enable row level security;
alter table utility_bills enable row level security;

create policy read_general_inventory_items on general_inventory_items for select using (auth.uid() is not null);
create policy read_general_inventory_transactions on general_inventory_transactions for select using (auth.uid() is not null);
create policy read_maintenance_tickets on maintenance_tickets for select using (auth.uid() is not null);
create policy read_utility_bills on utility_bills for select using (auth.uid() is not null);

create policy department_lead_write_general_inventory_items on general_inventory_items
  for all using (is_system_admin() or is_department_lead('general'))
  with check (is_system_admin() or is_department_lead('general'));

create policy department_lead_write_general_inventory_transactions on general_inventory_transactions
  for all using (is_system_admin() or is_department_lead('general'))
  with check (is_system_admin() or is_department_lead('general'));

-- 修繕登記比較特別：任何教職員都可以「新增」報修（不用是總務也能通報壞掉的東西），
-- 但只有總務主管/系統管理員S能修改狀態/指派/結案。
create policy any_staff_report_maintenance_ticket on maintenance_tickets
  for insert
  with check (auth.uid() is not null);

create policy department_lead_manage_maintenance_ticket on maintenance_tickets
  for update using (is_system_admin() or is_department_lead('general'))
  with check (is_system_admin() or is_department_lead('general'));

create policy department_lead_delete_maintenance_ticket on maintenance_tickets
  for delete using (is_system_admin() or is_department_lead('general'));

create policy department_lead_write_utility_bills on utility_bills
  for all using (is_system_admin() or is_department_lead('general'))
  with check (is_system_admin() or is_department_lead('general'));

-- 掛進送審白名單（總務承辦人員 staff 走 pending_changes；修繕登記的「新增報修」不受此限，
-- 因為上面已經開放全體教職員直接新增，送審機制只用在「總務staff的其餘操作」，
-- apply_pending_change() 只會在 staff 沒有直接寫入權限時才會被前端導去送審，維修新增不受影響）
insert into governed_tables (table_name, primary_key_column, department, description) values
  ('general_inventory_items', 'id', 'general', '書庫/校服/簿本 品項主檔'),
  ('general_inventory_transactions', 'id', 'general', '書庫/校服/簿本 進出紀錄'),
  ('maintenance_tickets', 'id', 'general', '修繕登記'),
  ('utility_bills', 'id', 'general', '水電網路等費用')
on conflict (table_name) do nothing;
