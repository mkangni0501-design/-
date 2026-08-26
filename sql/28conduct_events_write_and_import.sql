-- ============================================================
-- conduct_events：補上「一鍵上傳」需要的兩件事
-- ------------------------------------------------------------
-- 1. RLS：這張表從 schema.sql 建立以來就沒有 enable RLS、也沒有任何政策，
--    等於還沒開放任何角色寫入（用 service role 以外的連線去 insert/update 都會被擋）。
--    這裡開放給管理者角色（跟 conduct_point_defaults、grading_rules 等設定表一致）；
--    導師／任課教師/家長portal目前都還沒有畫面會用到這張表，先只開放查詢，
--    之後如果要做「班級導師登錄獎懲」的頁面，再依需求另外加寫入政策。
-- 2. 唯一限制：原本完全沒有限制，同一個學生同一天同一個獎懲項目可以無限重複新增。
--    「一鍵上傳」的批次上傳用 upsert，需要一個 unique 限制當作 onConflict 目標，
--    不然重複上傳同一份檔案（例如修正過幾筆分數後再傳一次）會每次都新增一整批重複紀錄。
--    這裡假設「同一天、同一個項目」只會有一筆（跟 attendance 的 (student_no, record_date, period_no)
--    是同樣的設計方式）。如果學校實際上會有「同一天記兩次小過、原因不同」的情況，
--    這個限制要拿掉、改成單純 insert，並在畫面上另外做防呆。
-- ============================================================

alter table conduct_events enable row level security;

create policy read_conduct_events on conduct_events for select using (true);

create policy admin_write_conduct_events on conduct_events for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

alter table conduct_events
  add constraint conduct_events_student_date_type_key unique (student_no, event_date, event_type);
