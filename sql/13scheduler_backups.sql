-- ============================================================
-- 排課系統專案存檔（scheduler_backups）
-- ------------------------------------------------------------
-- 用途：【排課系統（自動排課工具）】本身的資料只存在瀏覽器記憶體/使用者自己下載
-- 的 JSON 備份檔裡，關掉分頁就不見了。這張表讓管理者可以把排課工具「備份專案」
-- 匯出的 JSON 檔上傳進主系統，之後不用翻找電腦裡的舊檔案，直接在系統裡：
--   1. 依學年度／學期查詢已存過的排課進度，下載回去繼續在排課工具裡編輯。
--   2. 用「查詢本學期課表／代課小工具」查某位老師這學期的課表，或某個時段有哪些
--      老師沒課、可以請他代課。
--
-- 跟「備份與還原」(backups表) 的差異：那張是「校務系統資料庫」的備份（學生/成績/
-- 出缺勤...），這張是「排課工具本身」的專案存檔（GRADES/教師/課表/鎖定設定），
-- 兩者資料內容完全不同、互不影響。
--
-- 執行方式：比照 SQL執行順序.txt，在 Supabase SQL Editor 執行這個檔案即可（獨立、
-- 不依賴其他表）。RLS 政策這裡先用「app_users.role 是管理員」這個常見寫法示範，
-- 如果貴校 policies.sql 已經有自訂的管理員判斷方式（例如自訂function），
-- 請改用同一套寫法保持一致，或請系統開發人員協助調整。
-- ============================================================

create table if not exists scheduler_backups (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null,
  note text,
  data jsonb not null,
  saved_at timestamptz not null default now(),
  saved_by uuid references auth.users(id)
);

create index if not exists scheduler_backups_year_term_idx
  on scheduler_backups (academic_year, term, saved_at desc);

alter table scheduler_backups enable row level security;

-- 管理員（系統管理員S／管理員A／管理員B）可以查詢/下載清單
drop policy if exists "scheduler_backups_select_admin" on scheduler_backups;
create policy "scheduler_backups_select_admin" on scheduler_backups
  for select using (
    exists (
      select 1 from app_users
      where app_users.id = auth.uid()
        and app_users.role in ('system_admin_s', 'admin_a', 'admin_b')
    )
  );

-- 寫入（新增存檔）一律經由 /api/admin/scheduler-backup/create 這支API用「service role」執行，
-- 該API內已經檢查過呼叫者是管理員身分，所以這裡不另外開放 insert/delete 給一般登入使用者，
-- 避免有人繞過應用程式邏輯直接寫資料庫。
