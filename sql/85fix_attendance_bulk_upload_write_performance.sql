-- ============================================================
-- 85. 修正「全校出缺席批次上傳仍然上傳一整天還卡在處理中」
-- ------------------------------------------------------------
-- 上一輪已經把「一格一格各自 upsert」改成「收集好分批 upsert」
-- （ATTENDANCE_UPLOAD_CHUNK_SIZE=500），照理說網路來回次數已經大幅減少；
-- sql/84 也已經把「讀取」attendance 的 RLS 改成不會整表逐列重算權限。但這次
-- 反映「還是要一整天」，代表問題不只在「來回次數」，寫入本身也慢——根因跟
-- sql/84 是同一種模式，只是這次出在「寫入」而不是「讀取」。
--
-- attendance_insert／attendance_update（sql/81）呼叫的 can_write_attendance()
-- 是 plpgsql 函式，最上面雖然有「系統管理員／訓導／開發部門直接放行」的快速
-- 路徽，但這個判斷寫在函式「裡面」，每一列 upsert 都要真的呼叫這個函式一次
-- 才能求值——批次上傳整批500筆一次 upsert，Postgres 對這500筆逐列套用
-- with check，等於呼叫了500次 can_write_attendance()，每次都重新算一遍
-- 「這個帳號是不是系統管理員」。全校規模的批次上傳動輒几十萬列，等於
-- 這個判斷被重複算了几十萬次——這才是「已經分批了、還是要跑一整天」的真正
-- 原因（分批只解決了「網路來回次數」，沒有解決「權限判斷的計算量」）。
--
-- 修法：跟 sql/84 同樣的手法，把「是不是系統管理員／訓導／開發部門」這個
-- 跟「這一列資料」完全無關的判斷，從 can_write_attendance() 函式「裡面」搬到
-- RLS 政策的 using／with check 運算式「外面」，並用 (select 函式()) 包一層，
-- 讓 Postgres 能夠只算一次、套用到整批 500 筆，不用每一列都重新呼叫一次
-- can_write_attendance()。can_write_attendance() 本身保留原本的完整判斷式
-- （含管理員檢查）不變，只是這樣一來，管理員批次上傳時，政策外層的快速判斷
-- 已經是 true，Postgres 短路後根本不會再去呼叫 can_write_attendance()，
-- 一般導師/任課教師平常個別登錄出缺勤（本來就只有一列，不受影響）則完全
-- 不受影響、邏輯不變。
-- ============================================================

drop policy if exists attendance_insert on attendance;
create policy attendance_insert on attendance
  for insert
  with check (
    (select is_system_admin()) or (select has_department('discipline')) or (select has_department('dev'))
    or can_write_attendance(student_no, record_date, period_no, id)
  );

drop policy if exists attendance_update on attendance;
create policy attendance_update on attendance
  for update
  using (
    (select is_system_admin()) or (select has_department('discipline')) or (select has_department('dev'))
    or can_write_attendance(student_no, record_date, period_no, id)
  )
  with check (
    (select is_system_admin()) or (select has_department('discipline')) or (select has_department('dev'))
    or can_write_attendance(student_no, record_date, period_no, id)
  );

drop policy if exists attendance_delete on attendance;
create policy attendance_delete on attendance
  for delete
  using (
    (select is_system_admin()) or (select has_department('discipline')) or (select has_department('dev'))
    or can_write_attendance(student_no, record_date, period_no, id)
  );

-- hide_status_changed_students_attendance（sql/84 已經優化過 current_role_name()
-- 那段）是限制性(restrictive)政策，跟上面這三條permissive政策一樣會作用在
-- INSERT/UPDATE 上，兩邊都優化過後，批次上傳整批寫入時，管理員身分只需要
-- 算「一次」，不會再被逐列重算。
notify pgrst, 'reload schema';
