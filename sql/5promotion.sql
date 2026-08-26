-- ============================================================
-- 升級作業 / 轉班（跟入學/休學/退學/畢業/肄業/復學放在同一個學籍管理模組底下）
-- 需在 schema.sql、policies.sql、registration.sql 執行後再執行本檔
-- ============================================================

-- ---------- 年級升級對照表：管理員設定「這個部別+年級，升級後去哪個部別+年級」 ----------
create table if not exists grade_progression (
  department text not null,
  grade_level text not null,
  next_department text not null,
  next_grade_level text not null,
  primary key (department, grade_level)
);

alter table grade_progression enable row level security;
create policy read_grade_progression on grade_progression for select using (true);
create policy admin_write_grade_progression on grade_progression for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ---------- enrollments 加一個「目前是否為現行班級」的標記 ----------
-- 轉班時：舊的那筆設 is_current = false，新班級新增一筆 is_current = true，
-- 這樣「這個學生某段時間在哪個班」的完整歷史都留得住，不會被覆蓋掉。
alter table enrollments add column if not exists is_current boolean not null default true;
alter table enrollments add column if not exists created_at timestamptz not null default now();

-- 原本 (class_id, term, seat_no) 的唯一鍵，在轉班情境下可能造成同學期兩筆紀錄佔用同一個座號時衝突，
-- 這是預期內的（座號本來就該唯一），轉班時新班級要指定一個新座號。
