-- ============================================================
-- 81. 修正「班級導師在修正其他任課教師點名表時出現錯誤提示」
-- ------------------------------------------------------------
-- 反映事項：導師在「學生出缺席登錄（一週）」頁面，對已經超過補登期限（逾期，
-- 見 attendance_alert_settings.backfill_overdue_days）、原本是其他任課教師登錄
-- 的節次，點格子準備送出「修正申請」時，系統顯示「這個時段目前還沒有出缺勤
-- 紀錄，這種情況無法送出修正申請」——但那個時段其實明明有登錄過紀錄，訊息是
-- 錯的，導師看到會誤以為系統壞掉或資料不見了。
--
-- 【根因，已找到並確認】
-- attendance 表從 sql/2policies.sql 開始，一直都只用「同一條 `for all` 政策」
-- 同時管控 SELECT／INSERT／UPDATE／DELETE 四種操作（sql/9attendance_window_open_requests.sql
-- 把判斷邏輯改寫成呼叫 can_write_attendance()，但仍然是同一條 `for all` 政策）。
--
-- can_write_attendance() 的邏輯本來就是設計給「能不能寫入」用的：如果記錄已經
-- 「逾期鎖定」（attendance_locked() 為真）、又還沒有一筆「已核准」的修正申請／
-- 開放申請，就回傳 false。這對「不給寫入」是對的，但因為它同時也管到 SELECT，
-- 結果變成「還沒核准修正申請之前，連這筆紀錄本身都查不到（RLS 直接把整列濾掉，
-- 不會有任何錯誤訊息，查詢結果就是空的）」——這正好是导師要送出修正申請的
-- 那個當下：申請都還沒送、當然不可能有「已核准」的申請，於是
-- `attendance/weekly/page.tsx` 的 handleSubmitCorrectionRequest() 用
-- `.select('id')...maybeSingle()` 查這筆紀錄時查到 null，被誤判成「這個時段
-- 根本沒有登錄過」，顯示出那則誤導的錯誤訊息。
--
-- 更進一步：這個問題不只影響送修正申請，連「學生出缺席登錄（一週）」整個網格
-- 本身的顯示都會受影響——一旦某天的紀錄變成逾期鎖定，那幾格的 SELECT 也會被
-- 同一條政策擋掉，畫面上會用預設值「出席」把原本記錄的「曠課」「事假」等真實
-- 狀態蓋過去（見該頁 `attMap[key] ?? '出席'`），等於逾期越久、看到的出缺勤網格
-- 越不準——這是比「修正申請訊息錯誤」更嚴重的資料呈現問題，一併在這裡修正。
--
-- 【修法】能不能「讀取」跟能不能「寫入」本來就是兩件事：只要是這筆紀錄學生的
-- 導師、或這個節次的任課教師（或系統管理員／訓導／開發人員部門），就應該隨時
-- 讀得到這筆紀錄，不管有沒有逾期鎖定；「逾期鎖定需要核准才能修改」這條規則只
-- 應該擋「寫入」，不該擋「讀取」。把原本合在一起的 `for all` 政策拆成：
--   1. 一條只管 SELECT 的政策，用新的 can_read_attendance()（沿用
--      can_write_attendance() 裡「歸屬判斷」那一段，但不檢查鎖定狀態）。
--   2. 三條分別管 INSERT／UPDATE／DELETE 的政策，沿用原本的 can_write_attendance()
--      （鎖定規則不變，逾期沒核准仍然不能寫入，這部分維持原設計不放寬）。
-- ============================================================

create or replace function can_read_attendance(p_student_no text, p_period_no int)
returns boolean as $$
  select
    is_system_admin() or has_department('discipline') or has_department('dev')
    or exists (
      -- 導師：對自己班級所有學生的出缺勤，任何時候都讀得到（不受逾期鎖定影響）
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = p_student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
    or exists (
      -- 任課教師：讀自己任教節次的出缺勤，同樣不受逾期鎖定影響
      select 1 from enrollments e
      join class_schedule cs on cs.class_id = e.class_id
      where e.student_no = p_student_no
        and cs.teacher_id = current_teacher_id()
        and cs.period_no = p_period_no
    );
$$ language sql stable security definer;

drop policy if exists homeroom_and_subject_teacher_write_attendance on attendance;

create policy attendance_read on attendance
  for select
  using (can_read_attendance(student_no, period_no));

create policy attendance_insert on attendance
  for insert
  with check (can_write_attendance(student_no, record_date, period_no, id));

create policy attendance_update on attendance
  for update
  using (can_write_attendance(student_no, record_date, period_no, id))
  with check (can_write_attendance(student_no, record_date, period_no, id));

create policy attendance_delete on attendance
  for delete
  using (can_write_attendance(student_no, record_date, period_no, id));

-- 注意：hide_status_changed_students_attendance（sql/37，restrictive 政策，隱藏已離校/
-- 狀態異動學生）跟 discipline_dept_read_attendance（sql/47）、parent_read_own_attendance
-- （sql/6，家長查詢）都是獨立的政策，會自動疊加在新的 attendance_read 上，不用跟著改。

notify pgrst, 'reload schema';
