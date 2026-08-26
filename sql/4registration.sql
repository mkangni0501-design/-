-- ============================================================
-- 新生註冊 / 學籍狀態管理（第四模組擴充）
-- 需在 schema.sql、policies.sql 執行後再執行本檔
-- ============================================================

-- ---------- students 擴充：完整版註冊表單需要的欄位 ----------
-- 精簡版（既有學生匯入/轉入）可以不填這些，全部允許 null。
alter table students add column if not exists thai_name text;
alter table students add column if not exists dob date;
alter table students add column if not exists id_number text;          -- 身分證/護照號碼
alter table students add column if not exists nationality text;
alter table students add column if not exists religion text;
alter table students add column if not exists blood_type text;
alter table students add column if not exists address text;
alter table students add column if not exists phone text;
alter table students add column if not exists photo_url text;
alter table students add column if not exists previous_school text;    -- 原就讀學校
alter table students add column if not exists previous_school_grade text; -- 原就讀年級/離校成績概況

-- ---------- 監護人資料（父親/母親/監護人，一個學生可以有多筆） ----------
create table if not exists guardians (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no) on delete cascade,
  relation text not null,             -- 父親／母親／監護人
  name text,
  chinese_name text,
  occupation text,
  phone text,
  email text,                         -- 用於之後開通家長查詢帳號
  address text
);

-- ---------- 學籍狀態歷程 ----------
create type enrollment_status_type as enum ('入學', '休學', '退學', '畢業', '肄業', '復學');

create table if not exists student_status_changes (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no) on delete cascade,
  status enrollment_status_type not null,
  effective_date date not null,
  reason text,
  changed_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

-- 每筆狀態變化可以附加多份佐證資料（例如休學證明、家長申請書掃描檔）
create table if not exists status_change_attachments (
  id uuid primary key default gen_random_uuid(),
  status_change_id uuid not null references student_status_changes(id) on delete cascade,
  file_url text not null,             -- 存在 Supabase Storage 的路徑
  file_name text,
  uploaded_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table guardians enable row level security;
alter table student_status_changes enable row level security;
alter table status_change_attachments enable row level security;

-- 監護人資料：導師（該生現任班級的導師）與管理員可讀寫；任課教師不可見
create policy homeroom_and_admin_guardians on guardians
  for all
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = guardians.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 學籍狀態變化：只有管理員可以新增/修改（休學退學是校務層級的決定，不開放導師直接改）
create policy admin_only_status_changes on student_status_changes
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy admin_only_status_attachments on status_change_attachments
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
