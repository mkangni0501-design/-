-- ============================================================
-- 35. 修正「管理員A看不到任何學生資料」（app_users.role 是 admin_a/admin_b，
--     但沒有對應的 app_user_departments 部門職務）
-- ------------------------------------------------------------
-- 根因：22department_policy_rewrite_complete.sql 把 students 等資料表的 RLS
-- 政策從「角色判斷（current_role_name() in ('admin_a','admin_b',...)）」
-- 全部改成「部門職務判斷（has_department('academic') 等）」，但當時只改了
-- RLS 政策，沒有同步處理「admin_a／admin_b 帳號本身要有對應的部門職務
-- 才看得到資料」這件事——不管是既有帳號、還是帳號管理頁面日後新建的
-- admin_a／admin_b 帳號，只要沒有在 app_user_departments 指派部門，
-- lib/adminModules.ts 的 computeVisibleModuleKeys() 雖然仍然讓他們看得到
-- 選單（/admin/students/roster、/admin/registrar 這類本來就 adminOnly:false），
-- 但一實際查 students／curriculum／attendance…等受 RLS 保護的資料表就完全
-- 查不到任何一筆——這就是「管理員A看不到任何學生資料」的根本原因，
-- 不是單一帳號設定錯誤，是這個角色從一開始就沒有被回補部門職務。
--
-- admin_a／admin_b 在改成部門制之前，本來就等同「教務＋訓導＋總務＋開發人員」
-- 全部都能直接操作（見 6portal.sql 等舊政策一律 current_role_name() in
-- ('admin_a','admin_b','system_admin_s')），所以這裡回補的做法是讓他們
-- 在四個部門都取得 'lead' 層級，維持這兩個角色原本「全校管理」的實際能力、
-- 不因為改成部門制而功能倒退。日後若要讓 admin_a／admin_b 改成只管特定部門，
-- 請系統管理員S到「帳號管理」頁面手動調整/移除其中幾個部門即可，不影響這裡
-- 的一次性回補。
-- ============================================================

-- A. 回補現有帳號：role 是 admin_a/admin_b 但目前完全沒有部門職務的
insert into app_user_departments (app_user_id, department, level)
select u.id, d.department, 'lead'
from app_users u
cross join (
  values ('dev'::admin_department), ('academic'::admin_department), ('discipline'::admin_department), ('general'::admin_department)
) as d(department)
where u.role in ('admin_a', 'admin_b')
on conflict (app_user_id, department) do nothing;

-- B. 往後新建 admin_a/admin_b 帳號時（不論從「帳號管理」頁面或直接寫資料庫），
--    自動補上四個部門的 lead 職務，避免同樣的問題再次發生。
create or replace function trg_auto_assign_admin_departments() returns trigger as $$
begin
  if NEW.role in ('admin_a', 'admin_b') then
    insert into app_user_departments (app_user_id, department, level)
    values
      (NEW.id, 'dev', 'lead'),
      (NEW.id, 'academic', 'lead'),
      (NEW.id, 'discipline', 'lead'),
      (NEW.id, 'general', 'lead')
    on conflict (app_user_id, department) do nothing;
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists auto_assign_admin_departments on app_users;
create trigger auto_assign_admin_departments
  after insert on app_users
  for each row
  execute function trg_auto_assign_admin_departments();

-- 【重要】上面的 A/B 兩步只處理「部門職務」本身；如果套用這份檔案時，
-- 系統管理員S的帳號管理頁面已經有把某位 admin_a／admin_b 手動調整成只管
-- 部分部門（例如只給教務、拿掉總務），A 段的回補會被 on conflict do nothing
-- 跳過那些已存在的部門、但不會動到已經存在的資料列，所以套用這份檔案不會
-- 覆蓋管理員S已經手動調整過的設定，只補齊完全沒有任何部門職務的帳號。
