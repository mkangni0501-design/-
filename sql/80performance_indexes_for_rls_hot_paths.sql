-- ============================================================
-- 80. 修正「全校50位教師一起使用會卡，非常遲緩」
-- 需在 1schema.sql、2policies.sql 執行過後再執行本檔
-- ------------------------------------------------------------
-- 【追查方式】沒有正式環境的連線權限、看不到 pg_stat_statements／Query
-- Performance 面板的實際數字，這裡是從 schema／RLS 政策／查詢寫法三個角度
-- 靜態比對出來的最有把握、風險最低（純新增索引，不改任何邏輯／權限行為）的一項
-- 修正，先處理掉這個之後，如果現場實測還是慢，建議下一步去 Supabase 後台
-- 「Database → Query Performance」抓真正花最久的那幾條 SQL 再細看。
--
-- 【根因】幾乎「每一個」教師會用到的功能（出缺勤、成績登錄、排名、社團...等）都
-- 是透過 sql/2policies.sql 定義的 current_teacher_id() 這個函式：
--     select id from teachers where app_user_id = auth.uid()
-- 來判斷「目前登入的這個人是哪一位老師」，再拿這個 teacher id 去跟
-- classes.homeroom_teacher_id（是不是這班導師）、class_schedule.teacher_id
-- （是不是這節課的任課教師）比對，決定這筆資料能不能讀/寫；attendance／scores
-- 相關政策另外還會用 enrollments.student_no 去反查「這個學生在哪個班」。
--
-- 用 grep 全部 sql/*.sql 統計，current_teacher_id() 被超過90處不同的 RLS 政策
-- 呼叫，等於是整個系統權限判斷的最核心關卡——但 teachers.app_user_id、
-- classes.homeroom_teacher_id、class_schedule.teacher_id、enrollments.student_no
-- 這四個一直被拿來比對的欄位，從 1schema.sql 建表到現在都沒有建過索引（原本
-- schema 裡除了 primary key／unique 限制以外，幾乎沒有另外下過 create index）。
-- 只要沒有索引，Postgres 每一次「這個人是不是這班導師/任課老師」的判斷都要對
-- teachers／classes／class_schedule／enrollments 做循序掃描（sequential scan）
-- ——資料量不大的時候（例如只有幾位老師在測試）感覺不出來，但全校50位教師「同時」
-- 在用、每個人每次操作都會觸發好幾次這種判斷，資料庫要同時處理大量重複的循序
-- 掃描，CPU／連線數就會被大量消耗，整個系統對每個人來說都變慢——這跟
-- sql/44fix_report_card_and_ranking_performance.sql、
-- sql/50fix_ranking_query_timeout.sql 之前修過的「排名查詢逾時」是同一種類型的
-- 問題（RLS／view 裡的判斷式沒有索引或沒有把篩選條件往下推），只是這次是全站
-- 幾乎每個頁面都會踩到的共用判斷式，所以感覺起來是「整個系統」變慢，不是單一
-- 某個頁面。
--
-- 【修法】幫這幾個一直被拿來做等值比對（=）的欄位補上索引。純新增索引，不改變
-- 任何一條政策的判斷邏輯、不影響任何人現有的權限範圍，只是讓資料庫能用索引查
-- 而不是每次都整張表掃過去。這幾張表現在的資料量都還不大（幾十位教師、上千位
-- 學生等級），建表時間非常短，正常情況下秒級完成，不需要挑離峰時段，但如果不放心
-- 還是可以選學生／教師都不在線上的時間執行。
-- ============================================================

-- current_teacher_id() 本身：幾乎「每一次」權限判斷都會呼叫這個函式，
-- 是全站呼叫次數最高的一個查詢，補上這個索引影響範圍最廣。
create index if not exists idx_teachers_app_user_id on teachers (app_user_id);

-- 出缺勤／成績...等政策裡「這個學生現在在哪個班」的反查
-- （例如 sql/2policies.sql 的 homeroom_and_subject_teacher_write_attendance）。
create index if not exists idx_enrollments_student_no on enrollments (student_no);

-- 「是不是這班導師」判斷（attendance／scores／remarks／conduct...等政策都有用到）。
create index if not exists idx_classes_homeroom_teacher_id on classes (homeroom_teacher_id);

-- 「是不是這節課的任課教師」判斷（attendance／scores 任課教師寫入權限都要查這個）。
create index if not exists idx_class_schedule_teacher_id on class_schedule (teacher_id);

-- attendance 本身雖然已經有 unique(student_no, record_date, period_no) 這個複合
-- 索引，但「只依日期範圍查、不先鎖定學生名單」這種查法（例如全校性的出缺勤總覽/
-- 示警批次）用不太到這個索引（student_no排在最前面），額外補一個純日期索引。
create index if not exists idx_attendance_record_date on attendance (record_date);

-- 家長／學生入口網站登入判斷（is_linked_parent()，見 sql/6portal.sql）用到的
-- 對應欄位，跟上面同一類問題，家長/學生人數通常比教師多更多，一併補上。
create index if not exists idx_portal_accounts_auth_user_id on portal_accounts (auth_user_id);
create index if not exists idx_portal_accounts_student_no on portal_accounts (student_no);
