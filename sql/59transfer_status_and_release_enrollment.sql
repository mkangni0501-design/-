-- 對應反映事項「學生休學、轉學、退學以後，出缺、成績等各項資料應自動隱藏不顯示，
-- 僅有管理員查詢資料時能看到」。
--
-- 隱藏機制本身（restrictive policy 疊加在 enrollments／scores／attendance 上）在
-- sql/37hide_status_changed_students.sql 就已經做好了，這裡要補的是：
-- 1. 當時的學籍狀態清單裡沒有「轉學」這個選項（enum 只有 入學/休學/退學/畢業/
--    肄業/復學），沒有轉學狀態可以選，自然也就沒辦法用這套隱藏機制。
-- 2. sql/37 檔案結尾「已知限制」第3點自己就寫了：狀態變更當下不會連動把
--    enrollments.is_current 改成 false，座號不會自動釋放——這在只看 RLS 隱藏
--    本身沒問題（該表該筆資料就是被隱藏了），但任何「用 is_current=true 算目前
--    人數/座號」的地方（例如【班級資料檢查／合併】頁的人數統計、排座號邏輯）
--    看到的還是舊的、還沒扣掉已離校學生的數字，這就是「班級資料檢查／合併頁人數
--    對不起來」反映事項的根因之一。這裡把這件事也一併做掉。

-- ---------- 1. 新增「轉學」狀態 ----------
-- Postgres 的 enum 新增值语法（IF NOT EXISTS 是 PG12+ 支援，避免重複執行本檔時出錯）。
alter type enrollment_status_type add value if not exists '轉學';

-- ---------- 2. 重新定義 student_is_hidden()，把「轉學」也算進隱藏名單 ----------
-- （student_current_status() 本身不用改，改的是「哪些狀態算隱藏」這份清單）
create or replace function student_is_hidden(p_student_no text)
returns boolean as $$
  select coalesce(
    student_current_status(p_student_no) in ('休學', '轉學', '退學', '畢業', '肄業'),
    false
  );
$$ language sql stable;

-- ---------- 3. 狀態變更為隱藏名單時，自動釋放目前的在學狀態（is_current=false）----------
-- 只在「新增」一筆狀態變更紀錄時觸發（畫面上目前也只有新增、沒有修改既有紀錄的
-- 操作），把該學生「目前」那筆 is_current=true 的 enrollment 標記成 false——
-- 效果等同於這個學生從「目前班級」名冊上被移除，座號可以被別的學生使用，
-- 跟手動幫轉學/休學學生從班級移除是一樣的效果，只是自動做掉、不用承辦人另外操作。
--
-- 「入學」「復學」不會觸發（重新讓學生出現在班級名冊，本來就需要另外指派班級/
-- 座號，不是單純把 is_current 改回 true 就能處理，這部分維持要承辦人自己在
-- 「學籍設定及查詢」重新加入班級）。
--
-- security definer：確保不管是哪個角色（管理員或有權限的承辦人）新增狀態變更紀錄，
-- 這個自動釋放的動作都能執行，不會因為觸發當下呼叫者對 enrollments 沒有 update
-- 權限而失敗。
create or replace function release_enrollment_on_status_change()
returns trigger as $$
begin
  if new.status in ('休學', '轉學', '退學', '畢業', '肄業') then
    update enrollments
    set is_current = false
    where student_no = new.student_no and is_current = true;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_release_enrollment_on_status_change on student_status_changes;
create trigger trg_release_enrollment_on_status_change
after insert on student_status_changes
for each row execute function release_enrollment_on_status_change();

-- ---------- 4. 補做一次既有資料 ----------
-- 上面的觸發器只會在「以後新增」狀態變更紀錄時生效；已經記錄過休學/退學/畢業/肄業、
-- 但當初沒有連動釋放 is_current 的舊資料（例如「初三忠」這類班級人數對不起來，
-- 很可能就是這個原因），這裡一次補做，執行完馬上生效，不用等到那些學生「再變更
-- 一次狀態」才會被修正。
update enrollments e
set is_current = false
where e.is_current = true
  and student_is_hidden(e.student_no);

