-- 承接 sql/59transfer_status_enum.sql：把「轉學」也算進 student_is_hidden() 的
-- 隱藏名單裡（轉學後這位學生的出缺勤／成績等資料，比照休學/退學/畢業/肄業，
-- 一般查詢畫面自動隱藏，只有管理員看得到——實際生效的隱藏機制是
-- sql/37hide_status_changed_students.sql 裡疊加在 enrollments／scores／attendance
-- 三張表上的 restrictive policy，這裡只是把這個函式判斷「哪些狀態算隱藏」的
-- 清單更新一下，policy 本身不用重新建立）。
--
-- 【必須】要等 sql/59transfer_status_enum.sql 先單獨執行、確定送出（commit）成功
-- 之後，才能執行這個檔案——如果兩個檔案在同一次執行裡一起跑，會出現
-- 「新的 enum 值必須先送出才能使用」的錯誤（見 sql/59 開頭的說明）。
create or replace function student_is_hidden(p_student_no text)
returns boolean as $$
  select coalesce(
    student_current_status(p_student_no) in ('休學', '轉學', '退學', '畢業', '肄業'),
    false
  );
$$ language sql stable;
