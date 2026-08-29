-- 撤銷「狀態變更為隱藏名單時自動釋放 is_current」的做法（原本在早期版本的
-- sql/59 裡，該檔已經改寫成只新增 enum 值，這裡是撤銷當時那個做法留下的影響——
-- 如果您是照最新版本的 sql/59/62 順序執行、從未跑過舊版 sql/59，這個檔案執行起來
-- 會是安全的空操作，可以放心照順序執行，不影響結果）。
--
-- 反映事項：確認離校學生是否會影響班級座號——答案是：座號本身有
-- unique(class_id, term, seat_no) 這條資料庫層級的限制在防止重複指派
-- （sql/1schema.sql），跟 enrollments.is_current 無關；就算 is_current 被改成
-- false，這筆 enrollments 紀錄本身還在，同一個班同一個學期同一個座號還是不能
-- 再指派給別人，不會真的「被空出來」——但把它改成 false 會產生另一個更直接的
-- 副作用：管理員自己在用、同樣是用 is_current=true 在查名冊的頁面（例如班級總表），
-- 會連管理員自己都看不到這個學生，等於「連管理員都查不到」，違反「僅有管理員
-- 查詢資料時能看到」這個前提。
--
-- 正確作法是完全不要動 is_current：離校學生「一般人看不到、管理員看得到」這件事
-- 全部交給 sql/37hide_status_changed_students.sql 的 restrictive policy 處理
-- 就足夠、而且是對的（policy 本身就有分 admin / 非 admin），不需要另外用
-- is_current 做第二層「隱藏」，兩層疊加反而讓管理員也被擋住。學生名字不顯示、
-- 但座號維持原本占用狀態（沒有被指派給任何人、也不能被指派給別人）這個效果，
-- 靠 restrictive policy 本身就已經達成：一般教師查詢班級名冊時，這筆 enrollments
-- 紀錄整個不會出現在查詢結果裡（座號自然就顯示成空的，不會出現這位學生的名字），
-- 但這個座號依然是「這筆歷史紀錄占用中」的狀態，不會被系統誤判成空位讓別的
-- 學生用同一個座號——不需要額外處理。

-- ---------- 1. 移除觸發器與函式（如果從未建立過，這兩行安全跳過不做任何事）----------
drop trigger if exists trg_release_enrollment_on_status_change on student_status_changes;
drop function if exists release_enrollment_on_status_change();

-- ---------- 2. 補回被 sql/59 backfill 誤改成 false 的 is_current ----------
-- 只處理「目前完全沒有任何 is_current=true 紀錄」的隱藏狀態學生（這正是 sql/59
-- backfill 唯一會動到的情況——backfill 當時只把「原本是 true」的那一筆改成
-- false，所以現在會變成「這個學生一筆 is_current=true 都沒有」），從這位學生
-- 名下所有 enrollments 紀錄裡，挑「所屬學年度最新」的那一筆改回 true，等同還原
-- 成 sql/59 backfill 執行前的狀態。如果某個隱藏狀態學生名下本來就還有一筆
-- is_current=true（沒被 sql/59 backfill 動過、或本檔已經執行過一次），就不會
-- 再重複處理，這個 UPDATE 可以安全重複執行。
update enrollments e
set is_current = true
from (
  select distinct on (en.student_no) en.id
  from enrollments en
  join classes c on c.id = en.class_id
  where student_is_hidden(en.student_no)
    and not exists (
      select 1 from enrollments en2
      where en2.student_no = en.student_no and en2.is_current = true
    )
  order by en.student_no, c.academic_year desc, en.id desc
) restore
where e.id = restore.id;
