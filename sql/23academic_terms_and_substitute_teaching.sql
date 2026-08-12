-- ============================================================
-- 05. 學年學期中央管理主檔 ＋ 代課安排（草案，從零開始）
-- ------------------------------------------------------------
-- 對應 handover/README.md 五、建議下一步 第5點：
-- 「依規劃書的分期建議，接續處理學年學期中央管理主檔、代課安排等其餘缺口」。
--
-- 這兩塊目前完全沒有規劃書可對照（docs/ 資料夾兩份 .docx 這次上傳沒有附上），
-- 下面的欄位設計是依現有系統其他表格（academic_year/term 散落在 classes、
-- class_schedule、submission_windows...等表各自存一份）與 01 對照表裡已經
-- 預告的「academic_terms（學年學期主檔）」欄位名稱推斷出來的最小可行版本，
-- 正式欄位需求請對照規劃書 docx 或與提出需求的人確認後再調整。
--
-- 需在 01/02/03/04 都執行過後再執行本檔。
-- ============================================================


-- ============================================================
-- A. 學年學期中央管理主檔（academic_terms）
-- ------------------------------------------------------------
-- 目的：現況「學年度」「學期」是每張表自己存一份 int/text 欄位，沒有單一
-- 事實來源，容易出現「這學期到底叫上學期還是下學期」「現在是哪個學年度」
-- 各頁面各自硬編碼或各自判斷的問題。這張表提供「目前生效的學年學期」與
-- 「開放註冊的學年學期清單」單一事實來源，之後其他模組（排課、成績、
-- 出缺勤）要新增學年學期選項時，都從這張表讀，而不是繼續各自硬編碼。
-- ============================================================

create table if not exists academic_terms (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  term_start_date date,
  term_end_date date,
  is_current boolean not null default false,   -- 目前系統預設帶入的學年學期（同時只能有一筆為 true）
  status text not null default '規劃中' check (status in ('規劃中', '進行中', '已結束')),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (academic_year, term)
);

-- 同時只能有一筆 is_current = true：用部分唯一索引達成
create unique index if not exists academic_terms_only_one_current
  on academic_terms (is_current) where is_current = true;

alter table academic_terms enable row level security;

-- 所有已登入校務人員都能讀（各模組的學年學期下拉選單都要用到）
create policy read_academic_terms on academic_terms
  for select
  using (current_role_name() is not null or has_department('dev') or has_department('academic')
         or has_department('discipline') or has_department('general'));

-- 只有開發人員（對應 01 對照表：academic_terms 歸「開發人員 dev」）能新增/修改/刪除
create policy dev_write_academic_terms on academic_terms
  for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

-- 輔助函式：目前生效的學年學期（其他模組要抓「現在是哪個學年學期」時呼叫這個，
-- 而不是各自寫死或各自猜測）
create or replace function current_academic_term()
returns table (academic_year int, term text) as $$
  select academic_year, term from academic_terms where is_current = true limit 1;
$$ language sql stable;

-- 切換「目前生效學年學期」時，用這個函式確保「只有一筆 is_current」的規則
-- 不會因為忘記先清掉舊的一筆而違反唯一索引
create or replace function set_current_academic_term(p_academic_year int, p_term text)
returns void as $$
begin
  if not (is_system_admin() or has_department('dev')) then
    raise exception '只有開發人員可以切換目前生效學年學期';
  end if;
  update academic_terms set is_current = false where is_current = true;
  update academic_terms set is_current = true, status = '進行中'
    where academic_year = p_academic_year and term = p_term;
  if not found then
    raise exception '找不到學年度 % % ，請先新增這個學年學期', p_academic_year, p_term;
  end if;
end;
$$ language plpgsql security definer;


-- ============================================================
-- B. 代課安排（substitute_assignments）
-- ------------------------------------------------------------
-- 目的：某位任課教師請假時，登記由誰代課上哪一節課，並且能查「這個時段
-- 還有哪些老師沒課、可以代」（沿用 teacher_schedule_conflicts 同樣的概念，
-- 從 class_schedule 反查空堂教師）。歸屬教務部門（跟課表/排課同一組人管）。
-- ============================================================

create table if not exists substitute_assignments (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  class_id uuid not null references classes(id),
  weekday int not null check (weekday between 1 and 7),
  period_no int not null,
  subject text not null,
  original_teacher_id uuid not null references teachers(id),
  substitute_teacher_id uuid not null references teachers(id),
  substitute_date date not null,          -- 實際代課的那一天（跟固定課表的 weekday 分開記，
                                           -- 因為代課通常是「某週某一天」的臨時異動，不是整學期都換人）
  reason text,
  status text not null default '已排定' check (status in ('已排定', '已完成', '已取消')),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (class_id, substitute_date, period_no)  -- 同一班同一天同一節，只能有一筆代課安排
);

create index if not exists idx_substitute_assignments_sub_teacher
  on substitute_assignments (substitute_teacher_id, substitute_date);
create index if not exists idx_substitute_assignments_orig_teacher
  on substitute_assignments (original_teacher_id, substitute_date);

alter table substitute_assignments enable row level security;

-- 讀取：教務部門看全部；一般教師只能看到跟自己有關（原任課或代課）的紀錄
create policy read_substitute_assignments on substitute_assignments
  for select
  using (
    is_system_admin() or has_department('academic')
    or original_teacher_id = current_teacher_id()
    or substitute_teacher_id = current_teacher_id()
  );

-- 寫入：比照 02 送審機制的精神，教務「承辦(staff)」新增/修改代課安排要送審，
-- 「主管(lead)」可直接寫。這裡先給「主管可直接寫」的政策；staff 的送審流程
-- 只要把 substitute_assignments 加進 governed_tables 白名單即可比照 pending_changes
-- 機制運作（見下方 C 節），不需要另外寫程式。
create policy department_lead_write_substitute_assignments on substitute_assignments
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));

-- 查詢某天某節次，哪些老師「原本沒課」可以代課
-- 用法：SELECT * FROM available_substitute_teachers(2026, '上學期', 1, 3, '2026-09-01');
create or replace function available_substitute_teachers(
  p_academic_year int, p_term text, p_weekday int, p_period_no int, p_date date
) returns table (teacher_id uuid, teacher_name text) as $$
  select t.id, t.name
  from teachers t
  where not exists (
    select 1 from class_schedule cs
    where cs.teacher_id = t.id
      and cs.academic_year = p_academic_year
      and cs.term = p_term
      and cs.weekday = p_weekday
      and cs.period_no = p_period_no
  )
  and not exists (
    -- 排除當天已經被排去代別堂課的老師
    select 1 from substitute_assignments sa
    where sa.substitute_teacher_id = t.id
      and sa.substitute_date = p_date
      and sa.period_no = p_period_no
      and sa.status = '已排定'
  )
  order by t.name;
$$ language sql stable;


-- ============================================================
-- C. governed_tables 白名單：補登記本檔新增的表，之後 B 送審機制可以直接沿用
-- ============================================================
insert into governed_tables (table_name, primary_key_column, department, description) values
  ('substitute_assignments', 'id', 'academic', '代課安排登記')
on conflict (table_name) do nothing;

-- academic_terms 刻意不放進 governed_tables：它只給開發人員(dev)寫，
-- dev 部門本來就不受 pending_changes 送審機制限制（02 檔 A 節的白名單機制
-- 是給「部門承辦(staff)」用的，開發人員的操作維持原本直接寫入）。
