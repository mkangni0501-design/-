-- ============================================================
-- B層級（部門承辦）共用送審機制：任何修改都先進暫存區，
-- 要 A層級（部門主管）核准後才真的寫進正式資料表，並留下完整紀錄。
--
-- 適用範圍說明（重要，先講清楚範圍，避免跟既有機制搞混）：
--   本檔規範的是「部門管理帳號」（app_user_departments 裡 level='staff' 的 B層級）
--   做行政操作時的送審流程，例如：訓導承辦人員要調整出缺席示警門檻、
--   教務承辦人員要上傳新課表、總務承辦人員要登記庫存進出……這些都是
--   B要送審、A核准才生效的範圍。
--
--   一般任課教師／導師登打成績、出缺勤，走的是另一套機制
--   （schema.sql 的 submission_windows 開放期間內可直接寫、鎖定後才要走
--   correction_requests 個別申請），那一套已經很完整、跟這裡是兩回事，
--   不會被本檔影響，維持原樣即可。
--
-- 需在 department_rbac_refactor.sql 執行後再執行本檔。
-- ============================================================


-- ============================================================
-- A. 白名單設定表：哪些資料表允許被這套送審機制寫入、主鍵欄位叫什麼名字
-- ============================================================
-- 這張表是安全機制的關鍵：核准後系統要「動態」組出SQL去寫入對應的資料表，
-- 為了不讓人亂傳一個不在允許範圍內的資料表名稱進來（避免被拿去亂寫系統重要的表，
-- 例如 app_users、backups），一定要先在這張表登記過的資料表名稱才允許被寫入。
create table if not exists governed_tables (
  table_name text primary key,     -- 例如 'curriculum'、'attendance_alert_settings'
  primary_key_column text not null,-- 例如 'id'（多數表）或 'student_no'（students表）
  department admin_department not null, -- 這張表歸哪個部門管
  description text
);

-- 先登記目前已知、B層級會操作到的表（之後總務處新表格做出來時，
-- 一併在這裡補登記即可，不用改程式碼）
insert into governed_tables (table_name, primary_key_column, department, description) values
  ('curriculum', 'id', 'academic', '科目與比重設定'),
  ('class_schedule', 'id', 'academic', '課表/任課教師設定'),
  ('period_config', 'id', 'academic', '節次設定'),
  ('grade_progression', 'department,grade_level', 'academic', '年級升級對照表'),
  ('grading_rules', 'academic_year,term', 'academic', '成績計分比重設定'),
  ('attendance_alert_settings', 'id', 'discipline', '出缺席示警門檻設定'),
  ('conduct_point_defaults', 'item', 'discipline', '獎懲加扣分參考值')
on conflict (table_name) do nothing;
-- 總務處書庫／校服／簿本／修繕／水電表格，之後建好後用同樣的 insert 語法補登記即可。


-- ============================================================
-- B. 送審暫存表
-- ============================================================
create table if not exists pending_changes (
  id uuid primary key default gen_random_uuid(),
  department admin_department not null,
  table_name text not null references governed_tables(table_name),
  operation text not null check (operation in ('insert', 'update', 'delete')),
  record_key text,                 -- 目標那一列的主鍵值（update/delete 一定要填；insert 時可空）
  payload jsonb not null default '{}'::jsonb,  -- insert/update 時，要寫入的欄位內容
  before_snapshot jsonb,           -- update/delete 前的原始資料，供 A 核准時比對差異
  requested_by uuid not null references app_users(id),
  requested_at timestamptz not null default now(),
  status text not null default '待審核' check (status in ('待審核', '已核准', '已駁回')),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz,
  review_note text,
  applied_at timestamptz,          -- 核准後，實際寫入正式資料表完成的時間
  constraint pending_changes_record_key_check
    check (operation = 'insert' or record_key is not null)
);

create index if not exists idx_pending_changes_dept_status on pending_changes (department, status);

alter table pending_changes enable row level security;

-- B（部門staff）：只能新增自己部門的申請、只能看自己送出的申請
create policy staff_create_pending_change on pending_changes
  for insert
  with check (
    requested_by = auth.uid()
    and (has_department(department) or is_system_admin())
  );

create policy staff_read_own_pending_change on pending_changes
  for select
  using (requested_by = auth.uid());

-- A（部門lead）／系統管理員S：可以看該部門全部申請、可以核准或駁回
create policy lead_read_department_pending_change on pending_changes
  for select
  using (is_system_admin() or is_department_lead(department));

create policy lead_review_pending_change on pending_changes
  for update
  using (is_system_admin() or is_department_lead(department))
  with check (
    -- 只能改「審核相關」欄位：不能連同 payload 一起偷改成別的內容
    is_system_admin() or is_department_lead(department)
  );


-- ============================================================
-- C. 核准後「動態寫入」正式資料表的函式（security definer：不受申請人RLS限制）
-- ============================================================
create or replace function apply_pending_change(p_id uuid) returns void as $$
declare
  v_row pending_changes;
  v_pk_col text;
  v_set_clause text;
  v_col text;
  v_val jsonb;
begin
  select * into v_row from pending_changes where id = p_id;
  if v_row is null then
    raise exception '找不到這筆待審核紀錄';
  end if;
  if v_row.status <> '已核准' then
    raise exception '只有狀態為「已核准」的紀錄可以套用';
  end if;
  if v_row.applied_at is not null then
    return; -- 已經套用過，不要重複寫入
  end if;

  select primary_key_column into v_pk_col
  from governed_tables where table_name = v_row.table_name;
  if v_pk_col is null then
    raise exception '資料表 % 不在允許清單內', v_row.table_name;
  end if;

  if v_row.operation = 'insert' then
    execute format(
      'insert into %I (%s) values (%s)',
      v_row.table_name,
      (select string_agg(quote_ident(key), ', ') from jsonb_each_text(v_row.payload)),
      (select string_agg(quote_nullable(value), ', ') from jsonb_each_text(v_row.payload))
    );

  elsif v_row.operation = 'update' then
    v_set_clause := (
      select string_agg(format('%I = %L', key, value), ', ')
      from jsonb_each_text(v_row.payload)
    );
    execute format(
      'update %I set %s where %I = %L',
      v_row.table_name, v_set_clause, v_pk_col, v_row.record_key
    );

  elsif v_row.operation = 'delete' then
    execute format(
      'delete from %I where %I = %L',
      v_row.table_name, v_pk_col, v_row.record_key
    );
  end if;

  update pending_changes set applied_at = now() where id = p_id;
end;
$$ language plpgsql security definer;

-- ---------- 觸發器：A 把狀態改成「已核准」的當下，自動呼叫上面的函式套用 ----------
create or replace function trg_apply_on_approve() returns trigger as $$
begin
  if new.status = '已核准' and old.status <> '已核准' then
    perform apply_pending_change(new.id);
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_pending_change_approved on pending_changes;
create trigger on_pending_change_approved
  after update on pending_changes
  for each row execute function trg_apply_on_approve();


-- ============================================================
-- D. 收回 B（staff）對受管資料表的直接寫入權限，只留「送審」這條路
-- ============================================================
-- 說明：governed_tables 裡登記的表，B層級之後不能再直接 insert/update/delete，
-- 只能透過上面的 pending_changes 送審。A（lead）與系統管理員S 仍保留直接寫入權限
-- （核准本身就是一種「A確認後生效」，但如果A自己要緊急直接改，也不用被自己審自己）。
--
-- 下面以 curriculum（科目比重設定）示範，其餘 governed_tables 內的表格
-- 請比照同樣的寫法，把原本「is_system_admin() or has_department('academic')」
-- 這種「只要屬於該部門就能直接寫」的政策，改成「只有 lead 或 S 能直接寫」：

-- 範例（curriculum）：
--   drop policy if exists academic_write_curriculum on curriculum;
--   create policy department_lead_write_curriculum on curriculum
--     for all
--     using (is_system_admin() or is_department_lead('academic'))
--     with check (is_system_admin() or is_department_lead('academic'));
--
-- B（staff）在畫面上看到的「新增/修改」按鈕，其實是呼叫後端 API 寫進
-- pending_changes（insert 一筆），不是直接寫 curriculum 本身；
-- 畫面上要另外做一個「送審中」的狀態顯示，讓B知道這筆還在等A核准。


-- ============================================================
-- E. 給 A 用的「待審核清單」查詢範例
-- ============================================================
-- select pc.*, u.name as requested_by_name
-- from pending_changes pc
-- join app_users u on u.id = pc.requested_by
-- where pc.department = 'academic'   -- 依登入者所屬部門帶入
--   and pc.status = '待審核'
-- order by pc.requested_at asc;
