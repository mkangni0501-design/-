-- ============================================================
-- 每天自動備份 / 還原備份
-- 需在 schema.sql、policies.sql（以及有執行過的 registration.sql / promotion.sql 等）之後執行
-- ============================================================

create table backups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references app_users(id),   -- 自動（每天排程）備份時為 null
  kind text not null check (kind in ('自動', '手動')),
  tables jsonb not null,          -- 實際快照內容：{ "資料表名稱": [列資料, ...], ... }
  table_counts jsonb not null,    -- 摘要：{ "資料表名稱": 筆數（或 null 代表該資料表不存在/略過）, ... }
  restored_at timestamptz,        -- 如果曾被用來還原過，記錄最後一次還原時間
  restored_by uuid references app_users(id)
);

alter table backups enable row level security;

-- 備份內容等同於整個學校的學生資料，只有管理員角色（S/A/B）可以查閱清單／下載，
-- 一般教師、導師完全看不到。寫入（建立備份、標記還原時間）一律透過伺服器端 API（service role）處理。
create policy admin_read_backups on backups
  for select
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
