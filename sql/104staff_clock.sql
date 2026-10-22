-- ============================================================
-- 104：教職員打卡系統（指紋／人臉打卡機匯出資料 → 自己查自己、教務處＋管理員S/A 查全部與設定）
--
-- 設計重點：
--   1) 打卡機匯出檔的「方向」欄位永遠是 C/In（機器不分上班/下班），所以資料庫只存「每一筆打卡時間」，
--      上班/下班/遲到/早退/漏打卡 一律由程式依「班別設定」當天即時推算（見 lib/staffClock.ts），
--      之後改班別時間、遲到寬限分鐘，歷史資料會跟著重新判斷，不用重匯。
--   2) 每天由本機自動同步程式（tools/clock-sync）把 CSV 新資料送進 /api/clock/import，
--      以 (打卡機代碼, 打卡時間, 機器編號) 去重，重複上傳不會產生重複資料。
--   3) 「自己查自己」：教師帳號 → teachers.app_user_id → clock_employee_map.teacher_id → 打卡機代碼。
--      RLS 只放行「對應到自己的打卡機代碼」的資料；教務處（academic 部門）、系統管理員S、管理員A
--      可以看全部、可以改設定/補卡/更正。
--
-- 執行順序：需要先執行過 19／26（has_department、current_role_name）→ 本檔。
-- 本檔可重複執行（idempotent）。
-- ============================================================

-- ---------- 權限輔助函式 ----------
-- 教職員打卡管理權限：系統管理員S、系統管理員A，或身兼「教務」部門職務者。
create or replace function can_manage_staff_clock() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(current_role_name()::text in ('system_admin_s', 'admin_a'), false)
    or has_department('academic'::admin_department);
$$;

-- ---------- 班別設定 ----------
-- work_days 用 ISO 星期：1=週一 … 6=週六、7=週日。
-- 同一個人可以掛多個班別（例如「平日晚班」＋「週六早班」），某一天只會採用 work_days 含當天的那一個。
-- window_before_min / window_after_min：只有「上班時間往前 X 分鐘～下班時間往後 Y 分鐘」之內的打卡，
-- 才算這個班別的上/下班打卡，視窗以外的打卡只會列為「其他打卡」，不影響遲到早退判斷。
create table if not exists clock_shifts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_time time not null,
  end_time time not null,
  late_grace_min int not null default 10 check (late_grace_min >= 0),
  early_grace_min int not null default 0 check (early_grace_min >= 0),
  work_days int[] not null default '{1,2,3,4,5}',
  window_before_min int not null default 180 check (window_before_min >= 0),
  window_after_min int not null default 240 check (window_after_min >= 0),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- 全校放假日（當天不判缺勤） ----------
create table if not exists clock_holidays (
  holiday_date date primary key,
  name text not null default '放假',
  created_at timestamptz not null default now()
);

-- ---------- 打卡機人員對照 ----------
-- device_code＝打卡機匯出檔的「รหัสที่เครื่อง」（機器上的人員編號）。
-- 匯入時，沒看過的代碼會自動新增一列（teacher_id 先空著），再由教務處指定對應的教師帳號與班別。
create table if not exists clock_employee_map (
  device_code int primary key,
  device_name text not null,                 -- 打卡機上的名字（目前是拼音）
  display_name text,                         -- 自訂顯示名稱（例如中文姓名；沒填就顯示教師姓名或機器名）
  teacher_id uuid references teachers(id) on delete set null,
  shift_ids uuid[] not null default '{}',
  active boolean not null default true,      -- 離職/不用統計的人設為 false（資料保留，總覽不列入）
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_clock_employee_map_teacher on clock_employee_map(teacher_id);

-- ---------- 打卡原始紀錄 ----------
create table if not exists clock_records (
  id uuid primary key default gen_random_uuid(),
  device_code int not null,
  device_name text,
  punched_at timestamptz not null,
  punch_date date not null,                  -- 泰國當地日期（UTC+7），匯入時由程式算好
  direction text,                            -- 機器原始「เข้า/ออก」欄（目前都是 C/In，僅留存）
  machine_no int not null default 0,         -- 機器編號；補卡（手動新增）固定為 0
  method text,                               -- FP＝指紋、FACE＝人臉、MANUAL＝補卡
  source text not null default 'sync' check (source in ('sync', 'upload', 'manual')),
  voided boolean not null default false,     -- 作廢（誤打卡）：不刪除，只標記，保留稽核軌跡
  voided_reason text,
  voided_by uuid references app_users(id) on delete set null,
  voided_at timestamptz,
  note text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (device_code, punched_at, machine_no)
);
create index if not exists idx_clock_records_code_date on clock_records(device_code, punch_date);
create index if not exists idx_clock_records_date on clock_records(punch_date);

-- ---------- 單日更正（請假／公出／視為正常／休假） ----------
create table if not exists clock_day_overrides (
  id uuid primary key default gen_random_uuid(),
  device_code int not null,
  punch_date date not null,
  status text not null check (status in ('正常', '請假', '公出', '休假')),
  note text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (device_code, punch_date)
);
create index if not exists idx_clock_day_overrides_date on clock_day_overrides(punch_date);

-- ---------- 匯入紀錄（本機同步／手動上傳） ----------
create table if not exists clock_import_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null,
  file_name text,
  rows_received int not null default 0,
  rows_inserted int not null default 0,
  rows_duplicate int not null default 0,
  rows_invalid int not null default 0,
  new_codes int[] not null default '{}',
  first_punch timestamptz,
  last_punch timestamptz,
  created_by uuid references app_users(id) on delete set null,
  error text
);
create index if not exists idx_clock_import_log_created on clock_import_log(created_at desc);

-- ---------- 取得「自己」的打卡機代碼（security definer：避免 RLS 互相遞迴） ----------
create or replace function my_clock_codes() returns setof int
language sql
stable
security definer
set search_path = public
as $$
  select m.device_code
  from clock_employee_map m
  join teachers t on t.id = m.teacher_id
  where t.app_user_id = auth.uid();
$$;

-- 所有教職員都能查「資料最新到什麼時候」，方便發現同步程式是不是停了（只回傳一個時間，不洩漏他人資料）
create or replace function clock_last_data_at() returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select max(punched_at) from clock_records where not voided;
$$;

-- 偵測「疑似放假日」：資料涵蓋期間內、週一～週六、整天幾乎沒有人打卡（預設 ≤2 人）、且還沒設成放假日的日期。
-- 只給管理權限者用（不是管理者呼叫時回傳空結果），讓教務處一鍵把這些日子補進放假日，避免被誤判成全員缺勤。
create or replace function clock_quiet_days(p_from date, p_to date, p_max_people int default 2)
returns table(day date, people int)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select greatest(p_from, min(punch_date)) as lo, least(p_to, max(punch_date)) as hi from clock_records where not voided
  ),
  counts as (
    select punch_date, count(distinct device_code)::int as people
    from clock_records, bounds
    where not voided and punch_date between bounds.lo and bounds.hi
    group by punch_date
  )
  select d::date as day, coalesce(c.people, 0)::int as people
  from bounds, generate_series(bounds.lo, bounds.hi, interval '1 day') d
  left join counts c on c.punch_date = d::date
  where can_manage_staff_clock()
    and extract(isodow from d) <> 7
    and coalesce(c.people, 0) <= p_max_people
    and d::date not in (select holiday_date from clock_holidays)
  order by 1;
$$;

-- ---------- RLS ----------
alter table clock_shifts enable row level security;
alter table clock_holidays enable row level security;
alter table clock_employee_map enable row level security;
alter table clock_records enable row level security;
alter table clock_day_overrides enable row level security;
alter table clock_import_log enable row level security;

-- 班別／放假日：所有已登入教職員可讀（自己的頁面要用班別推算遲到早退），只有管理權限者可寫
drop policy if exists clock_shifts_read on clock_shifts;
create policy clock_shifts_read on clock_shifts for select to authenticated using (true);
drop policy if exists clock_shifts_write on clock_shifts;
create policy clock_shifts_write on clock_shifts for all to authenticated
  using ((select can_manage_staff_clock())) with check ((select can_manage_staff_clock()));

drop policy if exists clock_holidays_read on clock_holidays;
create policy clock_holidays_read on clock_holidays for select to authenticated using (true);
drop policy if exists clock_holidays_write on clock_holidays;
create policy clock_holidays_write on clock_holidays for all to authenticated
  using ((select can_manage_staff_clock())) with check ((select can_manage_staff_clock()));

-- 人員對照：管理權限者看全部；一般教職員只看得到對應到自己的那一列
drop policy if exists clock_employee_map_read on clock_employee_map;
create policy clock_employee_map_read on clock_employee_map for select to authenticated
  using ((select can_manage_staff_clock()) or device_code in (select my_clock_codes()));
drop policy if exists clock_employee_map_write on clock_employee_map;
create policy clock_employee_map_write on clock_employee_map for all to authenticated
  using ((select can_manage_staff_clock())) with check ((select can_manage_staff_clock()));

-- 打卡紀錄：管理權限者看/改全部；一般教職員只能「看」自己的
drop policy if exists clock_records_read on clock_records;
create policy clock_records_read on clock_records for select to authenticated
  using ((select can_manage_staff_clock()) or device_code in (select my_clock_codes()));
drop policy if exists clock_records_write on clock_records;
create policy clock_records_write on clock_records for all to authenticated
  using ((select can_manage_staff_clock())) with check ((select can_manage_staff_clock()));

drop policy if exists clock_day_overrides_read on clock_day_overrides;
create policy clock_day_overrides_read on clock_day_overrides for select to authenticated
  using ((select can_manage_staff_clock()) or device_code in (select my_clock_codes()));
drop policy if exists clock_day_overrides_write on clock_day_overrides;
create policy clock_day_overrides_write on clock_day_overrides for all to authenticated
  using ((select can_manage_staff_clock())) with check ((select can_manage_staff_clock()));

-- 匯入紀錄：只有管理權限者可讀（API 用 service role 寫入，不受 RLS 限制）
drop policy if exists clock_import_log_read on clock_import_log;
create policy clock_import_log_read on clock_import_log for select to authenticated
  using ((select can_manage_staff_clock()));

-- ---------- 預設班別（依 2026/05–09 匯出資料的實際打卡規律估的「起始值」，請依學校規定修改） ----------
--   週一～週五：多數人 16:50 左右上班、20:30 左右下班
--   週六：多數人 07:25 左右上班、12:30 左右下班
--   下班時間實際中位數落在 20:26–20:28，所以早退寬限預設給 10 分鐘，避免「早 2 分鐘」就被判早退
insert into clock_shifts (name, start_time, end_time, late_grace_min, early_grace_min, work_days, sort_order)
select '平日晚班', '17:00', '20:30', 10, 10, '{1,2,3,4,5}', 1
where not exists (select 1 from clock_shifts where name = '平日晚班');

insert into clock_shifts (name, start_time, end_time, late_grace_min, early_grace_min, work_days, sort_order)
select '週六早班', '07:30', '12:00', 10, 10, '{6}', 2
where not exists (select 1 from clock_shifts where name = '週六早班');
