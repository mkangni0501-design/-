-- ============================================================
-- 開發人員區：聘書分類（在職證明／自聘教師聘書／當年教師聘書）
-- ------------------------------------------------------------
-- 依 2026-08-08 需求：開發人員頁新增「聘書分類」，以「0509教師資料_VBA列印.xlsm」
-- （原本靠 Excel VBA 巨集手動列印）為樣本，把裡面 3 張資料表改成資料庫存放，
-- 並提供批次上傳／下載／編輯功能。原始檔案裡對應的工作表：
--   ①「在職證明」　②「自聘教師資料」　③「當年教師資料」
-- （「印在職證明」「印自聘教師聘書」「印當年聘書」是 VBA 用來排版列印的畫面，
--   不是資料本身，這裡不建表，改由網頁直接用①②③的資料下載/編輯。）
--
-- 設計說明：
--   ①「在職證明」欄位跟②③差異較大（有到職/離職日期3筆、國籍、出生日期等），
--     獨立一張表 teacher_service_certificates。
--   ②「自聘教師聘書」③「當年教師聘書」欄位高度重疊（姓名/職位/性別/聘期/起訖日期），
--     比照 general_affairs 的做法，共用一張表 teacher_appointment_letters，
--     用 category 欄位區分，②多出的「離職」「發聘時間」兩欄兩張表都保留、③不填即可。
--
-- 權限：比照本頁其他表格（backups／account_audit_log），只開放系統管理員或
--   歸屬「開發人員(dev)」部門的帳號可以讀寫。
-- 執行順序：schema.sql → ... → 32 → 本檔(33)
-- ============================================================

create type teacher_letter_category as enum ('自聘教師聘書', '當年教師聘書');

-- ============================================================
-- 一、在職證明
-- ============================================================
create table if not exists teacher_service_certificates (
  id uuid primary key default gen_random_uuid(),
  seq_no int,                 -- 歷年序號
  self_hired boolean not null default false,  -- 自聘（原檔 V/空白）
  resigned boolean not null default false,    -- 離職（原檔 V/空白）
  name text not null,
  birth_date date,            -- 出生日期(西元)
  nationality text,           -- 國籍
  gender text,                -- 性別
  department text,            -- 服務部門
  title text,                 -- 職稱
  start_date_1 date,          -- 任職日期1
  end_date_1 date,            -- 離職日期1
  start_date_2 date,          -- 任職日期2
  end_date_2 date,            -- 離職日期2
  start_date_3 date,          -- 任職日期3
  end_date_3 date,            -- 離職日期3
  note text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_teacher_service_certificates_name on teacher_service_certificates(name);

alter table teacher_service_certificates enable row level security;

drop policy if exists dev_all_teacher_service_certificates on teacher_service_certificates;
create policy dev_all_teacher_service_certificates on teacher_service_certificates for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));

-- ============================================================
-- 二、自聘教師聘書 ／ 當年教師聘書（共用一張表，category 區分）
-- ============================================================
create table if not exists teacher_appointment_letters (
  id uuid primary key default gen_random_uuid(),
  category teacher_letter_category not null,
  seq_no int,                 -- 序號
  name text not null,         -- 姓名
  title text,                 -- 職位
  gender text,                -- 性別
  term_no int,                -- 聘期
  start_date date,            -- 起
  end_date date,              -- 迄
  resigned boolean not null default false,   -- 離職（自聘教師聘書用）
  issued_date date,           -- 發聘時間（自聘教師聘書用）
  note text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_teacher_appointment_letters_category on teacher_appointment_letters(category);
create index if not exists idx_teacher_appointment_letters_name on teacher_appointment_letters(name);

alter table teacher_appointment_letters enable row level security;

drop policy if exists dev_all_teacher_appointment_letters on teacher_appointment_letters;
create policy dev_all_teacher_appointment_letters on teacher_appointment_letters for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));
