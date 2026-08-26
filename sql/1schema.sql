-- ============================================================
-- 學校成績系統 資料庫 Schema（Supabase / Postgres）
-- 對應「模組規格文件」第三章
-- ============================================================

-- ---------- 角色 ----------
create type user_role as enum ('system_admin_s', 'admin_a', 'admin_b', 'homeroom_teacher', 'subject_teacher');

-- ---------- 使用者（對應 Supabase auth.users） ----------
create table app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role user_role not null,
  created_at timestamptz not null default now()
);

-- 限制 system_admin_s 全系統只能有 1 筆有效帳號
create unique index only_one_system_admin_s
  on app_users ((role))
  where role = 'system_admin_s';

-- ---------- 基礎資料 ----------
create table students (
  student_no text primary key,
  name text not null,
  gender text
);

create table teachers (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid references app_users(id),
  name text not null
);

create table classes (
  id uuid primary key default gen_random_uuid(),
  class_name text not null,           -- 例如「仁班」
  academic_year int not null,
  department text not null,           -- 部別，例如「國小」「國中」
  grade_level text not null,          -- 例如「1年」
  homeroom_teacher_id uuid references teachers(id),
  unique (academic_year, department, grade_level, class_name)
);

create table enrollments (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no),
  class_id uuid not null references classes(id),
  term text not null check (term in ('上學期', '下學期')),
  seat_no int not null,
  unique (class_id, term, seat_no)
);

-- ---------- 課程與配課（每學期需重新設定/上傳） ----------
create table curriculum (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  grade_level text not null,
  subject text not null,
  weight numeric(4,3) not null,       -- 該科目佔總分比重
  periods int,
  unique (academic_year, term, grade_level, subject)
);

create table class_schedule (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  weekday int not null check (weekday between 1 and 6), -- 1=一 ... 6=六
  period_no int not null,
  subject text not null,
  teacher_id uuid not null references teachers(id),
  unique (class_id, academic_year, term, weekday, period_no)
);

-- 每天堂數設定（平日2-3節、週六5節等，依部別/個別班級可覆寫）
create table period_config (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('全校', '部別', '班級')),
  scope_ref text,                     -- 部別名稱或 class_id，scope='全校' 時為 null
  weekday int not null check (weekday between 1 and 6),
  period_count int not null
);

-- ---------- 登錄資料 ----------
create type exam_type as enum ('期中考', '期末考', '平時分');

create table scores (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references enrollments(id),
  exam_type exam_type not null,
  subject text not null,
  score numeric(5,2) check (score between 0 and 100),
  recorded_by uuid references teachers(id),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, exam_type, subject)
);

create type attendance_status as enum ('出席', '曠課', '遲到', '病假', '事假', '公假');

create table attendance (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no),
  record_date date not null,
  period_no int not null,
  status attendance_status not null default '出席',
  recorded_by uuid references teachers(id),
  updated_at timestamptz not null default now(),
  unique (student_no, record_date, period_no)
);

create table conduct_events (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no),
  event_date date not null,
  event_type text not null check (event_type in ('嘉獎','小功','大功','警告','小過','大過')),
  points int not null,
  recorded_by uuid references teachers(id)
);

-- 導師評語（只有導師與管理員能看，任課教師不可見）
create table student_remarks (
  enrollment_id uuid primary key references enrollments(id),
  comment text,
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

-- ---------- 計分規則（可擴充設計） ----------
create table grading_rules (
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  midterm_weight numeric(4,3) not null default 0.35,
  final_weight numeric(4,3) not null default 0.35,
  daily_weight numeric(4,3) not null default 0.30,
  primary key (academic_year, term)
);

create table score_adjustments (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  name text not null,                 -- 例如「全勤加分」
  points numeric(5,2) not null,
  is_active boolean not null default false
);

-- ---------- 稽核與流程控管 ----------
create table attendance_audit_log (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references attendance(id),
  changed_by uuid references teachers(id),
  changed_at timestamptz not null default now(),
  old_value text,
  new_value text
);

create table score_audit_log (
  id uuid primary key default gen_random_uuid(),
  score_id uuid not null references scores(id),
  changed_by uuid references teachers(id),
  changed_at timestamptz not null default now(),
  old_value text,
  new_value text
);

create table submission_windows (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  data_type text not null check (data_type in ('出缺勤','期中考','期末考','平時分')),
  scope text not null check (scope in ('全校','部別','班級')),
  scope_ref text,
  opens_at timestamptz,
  closes_at timestamptz,
  is_locked boolean not null default false,
  set_by uuid references app_users(id),
  unique (academic_year, term, data_type, scope, scope_ref)
);

create table correction_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references teachers(id),
  data_type text not null check (data_type in ('出缺勤','期中考','期末考','平時分')),
  record_id uuid not null,            -- 對應 attendance.id 或 scores.id
  reason text,
  status text not null default '待審核' check (status in ('待審核','核准','駁回')),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row-Level Security 開關（實際政策依部署環境於 Supabase 後台設定）
-- ============================================================
alter table scores enable row level security;
alter table attendance enable row level security;
alter table attendance_audit_log enable row level security;
alter table score_audit_log enable row level security;
alter table correction_requests enable row level security;
alter table student_remarks enable row level security;
-- 注意：attendance_audit_log / score_audit_log 僅允許 system_admin_s / admin_a / admin_b 角色查詢，
-- 導師與任課教師的政策不應包含 select 權限。實際 policy 語法需依 Supabase 專案建立後另外撰寫。
