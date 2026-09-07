-- ============================================================
-- 86. 成績單「直接套用學校 Excel 範本」的自訂範本存放處
-- ------------------------------------------------------------
-- 反映事項「請用EXCEL表，如果要做成WORD請一樣用EXCEL的格式去完成，現在WORD
-- 下載出來的樣式跟我提供的差很多，而且我要自己上傳還因為錯誤被擋下來」。
--
-- 跟 sql/57report_card_merge_template.sql（Word 合併列印範本）是同一個模式，
-- 只是這次的範本是 .xlsx（管理員在 Excel 裡自己調整版面/公式，改完存檔上傳回
-- 來，系統之後產生的成績單就直接套用這份 Excel 檔）。「上傳被錯誤擋下來」是
-- 因為 report_card_merge_template 那個上傳功能只驗證/接受 .docx——這裡是
-- 「新增」一張獨立的表存 .xlsx 範本，不是想辦法讓舊的 docx 上傳功能也收
-- .xlsx（兩種檔案格式的驗證方式完全不同，混在一起會更難維護）。
--
-- 內建預設範本放在 public/templates/report-card-xlsx-template.xlsx，就是
-- 學校目前實際使用、上傳給我們的那份檔案（已經補上範本裡原本缺漏的兩處公式：
-- 科目沒填滿10科時第14/15列的「總分」公式、以及學業平均公式原本漏加第14列
-- 科目——這兩處推測是學校自己在 Excel 裡新增列時，公式忘記往下複製到，
-- 不是刻意設計成這樣，已一併補上，往下不影響已經有資料的前8科）。
create table if not exists report_card_xlsx_template (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_data bytea not null,
  is_active boolean not null default false,
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

alter table report_card_xlsx_template enable row level security;

-- 權限設計跟 report_card_merge_template 一模一樣：讀取開放給所有登入者
-- （下載目前範本、伺服器端套用範本的 API 都要讀得到），寫入限管理員。
create policy read_report_card_xlsx_template on report_card_xlsx_template for select using (true);
create policy admin_write_report_card_xlsx_template on report_card_xlsx_template for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

NOTIFY pgrst, 'reload schema';
