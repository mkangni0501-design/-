-- ============================================================
-- 82. 修正兩項可見範圍問題
-- ============================================================

-- ------------------------------------------------------------
-- 一、【學生資料修改申請審核】收到通知的應該是該班導師，不是所有教師
-- ------------------------------------------------------------
-- 查證結果：
-- - 家長送出申請時「站內通知」的觸發器 notify_homeroom_on_profile_edit_request()
--   （sql/8attendance_alerts_and_guardian_edit.sql）本來就只 insert 給該生現任導師
--   一人，沒有問題；「通知」頁面（app/(app)/notifications/page.tsx）跟 TopNav 未讀
--   角標也都已經在更早一輪（2026-08-11）修正成只抓自己 teacher_id 的通知，這兩處
--   都不用再改。
-- - 真正的缺口在 profile_edit_requests 的 SELECT 政策
--   parent_read_own_edit_requests（sql/22department_policy_rewrite_complete.sql）：
--   除了申請人本人、系統管理員、該生導師之外，還多開放了「is_department_lead
--   不對……是 has_department('academic')」——只要帳號身兼「教務」部門（不需要是
--   主管，一般成員就算），就能讀到『全校』所有學生的修改申請，不限自己帶的班級。
--   「學生資料修改申請審核」頁面（app/(app)/reports/profile-requests/page.tsx）
--   直接把這個政策篩出來的結果整批顯示，於是任何身兼教務部門的教師打開這頁，
--   看到的是全校家長的申請，不是只有自己導師班的——這才是「不是所有教師、但範圍
--   還是比『該班導師』大很多」的根因。（核准/駁回的 API 本身
--   app/api/portal/approve-edit/route.ts 一直都只認 admin_a/admin_b/system_admin_s
--   角色或該生導師，不受這條政策影響，不會被誤核准，但「看得到」本身就已經是
--   一種資料外洩，家長申請修改的內容——例如新地址、新電話——不應該被本來無關的
--   教師看到。）
--
-- 修法：把 has_department('academic') 這條拿掉，只留申請人本人／系統管理員／
-- 該生現任導師三種情況才看得到。
drop policy if exists parent_read_own_edit_requests on profile_edit_requests;
create policy parent_read_own_edit_requests on profile_edit_requests
  for select
  using (
    exists (select 1 from portal_accounts pa where pa.id = profile_edit_requests.requested_by and pa.auth_user_id = auth.uid())
    or is_system_admin()
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = profile_edit_requests.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- ------------------------------------------------------------
-- 二、【修繕申請】完成後，只有總務處管理權限者能看到
-- ------------------------------------------------------------
-- 現況：read_maintenance_tickets（sql/25general_affairs_five_tables.sql）目前是
-- `using (auth.uid() is not null)`，刻意讓全校教職員都能讀取全部修繕案件——這是
-- 為了讓「通報壞掉東西的人」自己也能追蹤處理進度，狀態是「待處理」「處理中」時
-- 這樣設計沒問題。這裡依反映事項收緊：一旦案件狀態變成「已完成」，就只留系統
-- 管理員／總務部門主管（is_department_lead('general')）看得到；「待處理」「處理中」
-- 「取消」三種狀態維持原本「全校教職員可讀」不變，通報人才能繼續追蹤自己報修的
-- 案件有沒有人在處理。
drop policy if exists read_maintenance_tickets on maintenance_tickets;
create policy read_maintenance_tickets on maintenance_tickets
  for select
  using (
    status <> '已完成'
    or is_system_admin()
    or is_department_lead('general')
  );

notify pgrst, 'reload schema';
