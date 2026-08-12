-- ============================================================
-- 36. 聘書／在職證明 列印用的學校固定資料設定
-- ------------------------------------------------------------
-- 原始「0808.xlsm」裡校名、校長、董事長、電話、地址這些固定文字是直接寫死在
-- Excel儲存格裡（例如「印在職證明」的 H1 校長姓名、「印當年聘書」的 J4 董事長姓名）。
-- 改成網頁產生 PDF/Word 之後，這些值需要一個地方讓管理者維護，不能再寫死在程式碼裡
-- ——單一列設定表，比照 attendance_alert_settings 的做法。
-- ============================================================

create table if not exists teacher_letter_settings (
  id int primary key default 1,
  school_name_zh text not null default '泰國清萊雲南會館附屬華雲學校',
  principal_name text not null default '董嬌玫',
  chairman_name text not null default '顏協清',
  phone text not null default '053734209',
  address text not null default '618 M6 Mae Sai Chiang Rai Thai 57130',
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint teacher_letter_settings_singleton check (id = 1)
);

insert into teacher_letter_settings (id) values (1) on conflict (id) do nothing;

alter table teacher_letter_settings enable row level security;

drop policy if exists dev_all_teacher_letter_settings on teacher_letter_settings;
create policy dev_all_teacher_letter_settings on teacher_letter_settings for all
  using (is_system_admin() or has_department('dev'))
  with check (is_system_admin() or has_department('dev'));
