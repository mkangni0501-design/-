-- 成績單「合併列印（Word）」的自訂範本存放處。
--
-- 對應反映事項「把成績單系統的顯示改成用EXCEL/WORD合併列印的方式，讓我上傳提供
-- 樣本修改」：管理員可以在【成績單合併列印範本】頁下載目前生效中的 Word 範本
-- （沒上傳過的話，下載到的是系統內建預設範本，見 public/templates/
-- report-card-merge-template.docx），在 Word 裡自由調整版面/字體/顏色/要不要
-- 印哪些欄位，改完存檔再上傳回來，系統之後產生的「合併列印」成績單就會套用
-- 上傳的這份範本——版面完全交給管理員自己在 Word 裡決定，不用改任何程式碼。
--
-- 跟 report_card_style（PDF列印用的顏色/字級設定）是兩回事、互不影響：PDF 列印
-- 那條路徑完全沒有被這次改動動到，這是「新增」一種輸出方式，不是取代。
create table if not exists report_card_merge_template (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_data bytea not null,
  is_active boolean not null default false,
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

alter table report_card_merge_template enable row level security;

-- 讀取權限跟 report_card_style 一樣開放給所有登入者（前端下載範本按鈕、以及伺服器
-- 端合併列印 API 都要讀得到），寫入權限限管理員（跟 report_card_style 用同一組
-- 角色，不含教務部門一般教師，避免誤上傳壞掉的範本影響全校列印）。
create policy read_report_card_merge_template on report_card_merge_template for select using (true);
create policy admin_write_report_card_merge_template on report_card_merge_template for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

NOTIFY pgrst, 'reload schema';
