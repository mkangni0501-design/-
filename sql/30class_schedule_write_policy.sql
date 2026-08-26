-- ============================================================
-- class_schedule：補上一直沒有真的套用的寫入政策
-- ------------------------------------------------------------
-- 背景：sql/22department_policy_rewrite_complete.sql 573~580行其實已經寫了要怎麼改，
-- 但只留了一段註解說明「如果您正式環境有對應政策，請比照這樣改」，
-- 沒有實際的 create policy 陳述式──等於這一步當初只有寫文件、沒有真的執行。
-- governed_tables 裡 class_schedule 登記的部門是 'academic'（教務），
-- 跟 curriculum／period_config／grading_rules 這些已經改好的表用同一套規則：
--   is_system_admin()：系統管理員S，全系統最高權限，跨部門不受限制。
--   is_department_lead('academic')：教務處負責人（app_user_departments 裡
--     department='academic', level='lead' 的帳號），不需要是 admin_a/admin_b 角色也能寫。
-- 這就是「一鍵上傳」「排課系統」寫入 class_schedule 時被 RLS 擋下來
-- （new row violates row-level security policy for table "class_schedule"）的根本原因：
-- 這張表從來沒有一條政策允許任何角色寫入，包含系統管理員S自己。
--
-- 查詢政策這裡也一併明確補上（開放給所有已登入使用者──課表、成績登錄頁本來就要能查）。
-- 用 drop policy if exists 是為了避免跟後台手動建立過的同名政策衝突，可以重複執行。
-- ============================================================

alter table class_schedule enable row level security;

drop policy if exists read_class_schedule on class_schedule;
create policy read_class_schedule on class_schedule for select using (true);

drop policy if exists department_lead_write_class_schedule on class_schedule;
create policy department_lead_write_class_schedule on class_schedule
  for all
  using (is_system_admin() or is_department_lead('academic'))
  with check (is_system_admin() or is_department_lead('academic'));
