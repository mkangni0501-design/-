-- ============================================================
-- 53. 成績單樣式設定新增校徽/校園照片上傳：修正權限不一致
-- ------------------------------------------------------------
-- 【成績單樣式設定】頁本身開放給 admin_a／admin_b／system_admin_s 三種管理員都能用
-- （見 report_card_style 表的 admin_write_report_card_style 政策），但這輪新增的
-- 圖片上傳功能借用的 site-assets 這個共用儲存空間，原本上傳權限只開放給
-- system_admin_s 一種角色（sql/39site_content_settings_assets.sql，當初是給背景
-- 音樂用的，只有系統管理員S能換背景音樂）——如果不修正，admin_a/admin_b 兩種管理員
-- 點進【成績單樣式設定】頁，會發現顏色/字級/文字都能改，但圖片上傳會失敗（RLS擋下），
-- 造成頁面裡功能可用範圍不一致、也沒有任何提示說明為什麼上傳失敗。
--
-- 這裡新增一條政策，只針對「report-card/」這個資料夾路徑，開放跟 report_card_style
-- 一樣的三種管理員都能上傳/更新/刪除；背景音樂等其他既有用途的檔案（不在
-- report-card/ 這個路徑下）維持原本只有 system_admin_s 才能動，不受影響。
-- ============================================================

drop policy if exists admin_write_report_card_images on storage.objects;
create policy admin_write_report_card_images on storage.objects
  for insert
  with check (
    bucket_id = 'site-assets'
    and (storage.foldername(name))[1] = 'report-card'
    and current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  );

drop policy if exists admin_update_report_card_images on storage.objects;
create policy admin_update_report_card_images on storage.objects
  for update
  using (
    bucket_id = 'site-assets'
    and (storage.foldername(name))[1] = 'report-card'
    and current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  )
  with check (
    bucket_id = 'site-assets'
    and (storage.foldername(name))[1] = 'report-card'
    and current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  );

drop policy if exists admin_delete_report_card_images on storage.objects;
create policy admin_delete_report_card_images on storage.objects
  for delete
  using (
    bucket_id = 'site-assets'
    and (storage.foldername(name))[1] = 'report-card'
    and current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
  );
