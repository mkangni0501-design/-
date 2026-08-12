-- ============================================================
-- 部門真實權限切割 ＋ 帳號多重角色 草案
-- 這是「草案」，請先在測試環境跑過、確認資料搬移沒問題，
-- 再套用到正式資料庫。需在 sql/ 資料夾原本 17 份檔案都執行過後再執行本檔。
--
-- 對應決議：
--  1) 帳號要能同時身兼多個部門職務（不再是單選）
--  2) 教務／訓導／總務要「真的切開」，不是只有畫面分類
--  3) 排課衝堂：因為是手動調整過程中的即時檢查，不適合用資料庫「唯一鍵」
--     （那樣調整到一半、還沒排完就會被擋下來寫不進去），
--     改成一份「衝堂清單」查詢，畫面/匯出前呼叫它來判斷能不能匯出。
-- ============================================================


-- ============================================================
-- A. 部門與多重角色：新增「帳號－部門」對應表
-- ============================================================

-- 四個部門：開發人員／教務／訓導／總務
create type admin_department as enum ('dev', 'academic', 'discipline', 'general');

-- 同一部門內，兩種層級：
--   lead  = 可審核／可做該部門最終決定的人（例如原本 admin_a 的角色，例如審核修正申請）
--   staff = 一般承辦人員（例如原本 admin_b 的角色，可登錄資料但不能做最終審核）
create type department_level as enum ('lead', 'staff');

-- 一個帳號可以同時對應多個部門（例如某老師身兼教務＋總務兩個職務，各插一筆即可）
create table app_user_departments (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references app_users(id) on delete cascade,
  department admin_department not null,
  level department_level not null default 'staff',
  granted_by uuid references app_users(id),
  granted_at timestamptz not null default now(),
  unique (app_user_id, department)
);

alter table app_user_departments enable row level security;

-- 只有系統管理員 S 可以指派/調整部門權限（對應「開發人員」選單的帳號管理）
create policy system_admin_manage_departments on app_user_departments
  for all
  using (current_role_name() = 'system_admin_s')
  with check (current_role_name() = 'system_admin_s');

-- 本人與同部門的 lead 可以查看（方便部門主管確認自己部門有哪些人）
create policy read_own_or_department_lead on app_user_departments
  for select
  using (
    current_role_name() = 'system_admin_s'
    or app_user_id = auth.uid()
    or exists (
      select 1 from app_user_departments me
      where me.app_user_id = auth.uid()
        and me.department = app_user_departments.department
        and me.level = 'lead'
    )
  );

-- ---------- 輔助函式：取代原本「current_role_name() in ('admin_a','admin_b',...)」的判斷方式 ----------

-- 目前登入者是否屬於某個部門（不分 lead/staff，只要有掛在這個部門底下就算）
create or replace function has_department(p_dept admin_department) returns boolean as $$
  select exists (
    select 1 from app_user_departments
    where app_user_id = auth.uid() and department = p_dept
  );
$$ language sql stable;

-- 目前登入者是否是某個部門的「主管層級」(lead)，例如審核用的權限
create or replace function is_department_lead(p_dept admin_department) returns boolean as $$
  select exists (
    select 1 from app_user_departments
    where app_user_id = auth.uid() and department = p_dept and level = 'lead'
  );
$$ language sql stable;

-- 系統管理員 S：維持原本 role 欄位的判斷方式，S 是全系統唯一、跨部門的最高權限，
-- 不需要、也不應該放進 app_user_departments（S 本來就什麼都能看/改，不受部門切割限制）。
create or replace function is_system_admin() returns boolean as $$
  select current_role_name() = 'system_admin_s';
$$ language sql stable;

-- ---------- 資料搬移：把現有的 admin_a / admin_b 帳號轉成新的部門結構 ----------
-- ⚠️ 這一步不能自動決定「這個 admin_a 帳號該歸在教務、訓導、還是總務」，
-- 需要您人工確認名單後再執行對應的 insert。下面只是範例語法，
-- 實際帳號要自己填 app_user_id：
--
-- insert into app_user_departments (app_user_id, department, level)
-- values ('<某教務主任的帳號id>', 'academic', 'lead');
--
-- insert into app_user_departments (app_user_id, department, level)
-- values ('<某訓導組長的帳號id>', 'discipline', 'lead');
--
-- 如果有人身兼多職，就對同一個 app_user_id 插入多筆不同 department 即可。


-- ============================================================
-- B. 政策改寫對照表（請依此逐一修改 17 份既有檔案裡的 RLS 政策）
-- ============================================================
-- 原則：把所有「current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')」
-- 這種「不分部門、只要是管理員就放行」的寫法，換成「is_system_admin() or has_department(對應部門)」。
-- 審核類的動作（原本只給 admin_a 的，例如 correction_requests 的審核），
-- 換成「is_system_admin() or is_department_lead(對應部門)」。
--
-- 下表列出各資料表該對應哪個部門：
--
-- 【教務 academic】
--   curriculum、class_schedule、period_config、students(學籍相關寫入)、
--   guardians、student_status_changes、status_change_attachments、
--   enrollments、grade_progression、scores、grading_rules、score_adjustments、
--   submission_windows（data_type in 期中考/期末考/平時分 時）、
--   correction_requests（data_type in 期中考/期末考/平時分 時）、
--   portal_accounts、profile_edit_requests 的核准動作
--
-- 【訓導 discipline】
--   attendance、attendance_alert_settings、attendance_notifications、
--   conduct_events、conduct_point_defaults、staff_notifications、
--   submission_windows（data_type = 出缺勤 時）、
--   correction_requests（data_type = 出缺勤 時）
--
-- 【總務 general】
--   日後新增的書庫／校服／簿本／修繕／水電費用等資料表
--
-- 【開發人員 dev】
--   app_users、app_user_departments、teachers 合併、backups、
--   admin_module_categories、account_audit_log、academic_terms（學年學期主檔）
--
-- 這張對照表刻意不去動 17 份既有檔案裡的每一條政策（風險太高，應該在能連到
-- 正式資料庫、能實際測試的環境下逐條修改＋逐條測試），這裡先給您完整的
-- 對照關係，之後不管是您團隊或是接手的 Claude Code 都能照表操課，
-- 不會漏掉哪張表該歸哪個部門。

-- 範例：以 scores（成績登錄）這張表示範「舊寫法 → 新寫法」，其餘資料表依上表比照修改
--
-- 舊：
--   create policy admin_write_students on students for insert
--     with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));
--
-- 新：
--   drop policy if exists admin_write_students on students;
--   create policy admin_write_students on students for insert
--     with check (is_system_admin() or has_department('academic'));
--
-- 審核類的範例（correction_requests 原本限 admin_a）：
-- 舊：
--   create policy admin_a_review_requests on correction_requests for update
--     using (current_role_name() in ('admin_a', 'system_admin_s'));
--
-- 新（依 data_type 分流到訓導或教務主管）：
--   drop policy if exists admin_a_review_requests on correction_requests;
--   create policy department_lead_review_requests on correction_requests
--     for update
--     using (
--       is_system_admin()
--       or (data_type = '出缺勤' and is_department_lead('discipline'))
--       or (data_type in ('期中考','期末考','平時分') and is_department_lead('academic'))
--     );


-- ============================================================
-- C. 排課「教師端衝堂」檢查：用查詢視圖，不用資料庫唯一鍵
-- ============================================================
-- 唯一鍵會在「手動排課、調整到一半」的過程中就擋住儲存（因為那時候本來就會暫時有衝堂），
-- 所以改成一份「目前還有哪些衝堂」的清單，畫面即時顯示，
-- 「完成課表並匯出」按鈕在按下前，先查這份清單，有資料就不給匯出。

create view teacher_schedule_conflicts
with (security_invoker = true)
as
select
  teacher_id,
  academic_year,
  term,
  weekday,
  period_no,
  count(*) as conflict_count,
  array_agg(class_id) as conflicting_class_ids
from class_schedule
where weekday is not null and period_no is not null   -- 排除還沒排入實際時段的「任課教師設定」列
group by teacher_id, academic_year, term, weekday, period_no
having count(*) > 1;

-- 用法：SELECT count(*) FROM teacher_schedule_conflicts WHERE academic_year = ? AND term = ?;
-- 結果 > 0 代表還有老師被排到同一節兩個班，匯出按鈕要保持鎖定狀態。
-- 班級端的衝堂原本就已經被 class_schedule 的 unique(class_id, academic_year, term, weekday, period_no)
-- 擋住了（不可能存進資料庫），所以只需要額外查教師端這一份。
