-- ============================================================
-- 89. 最後總體確認：休學/轉學/退學/畢業/肄業學生的資料，補齊剩下沒有
--     隱藏規則的幾張表
-- ------------------------------------------------------------
-- 反映：「做最後確認，是否休學、轉學、退學的學生，只能在用管理者視角下看到
-- 他們的相關資料，其他視角皆無法顯示？避免未來要調檔案時查不到轉出或畢業的
-- 學生。」
--
-- 藉這個機會把目前存有「單一學生資料」的每一張表都重新盤點一次，結果：
-- enrollments／scores／attendance／students 這四張已經在前幾輪加過隱藏規則
-- （sql/37、62、87），這次逐一確認過都還在、邏輯正確。
--
-- 但盤點時發現還有三張表，存的也是「單一學生」的資料，卻從來沒有加過同一種
-- 隱藏規則：
--   - conduct_events（懲獎紀錄的原始事件，嘉獎/小功/大功/警告/小過/大過）
--   - student_remarks（導師評語——原始設計本來就是「只有導師與管理員能看，
--     任課教師不可見」，跟這次的隱藏名單精神完全一致，理當一併保護）
--   - guardians（監護人聯絡資料——上一輪才剛好把這張表獨立出一個「只給教職員
--     監護人電話」的功能，這裡一併補上隱藏規則，避免導師在學生休學之後，
--     還能透過班級名冊查到他監護人的電話）
--
-- 這三張都補上完全相同模式的 restrictive 政策：管理員（admin_a／admin_b／
-- system_admin_s，真實資料庫身分，不受「切換身分→教師視角」影響）看得到全部，
-- 其他任何身分（含家長/學生登入）都會被這個規則擋下休學/轉學/退學/畢業/肄業
-- 學生的資料——這跟 enrollments/scores/attendance/students 四張表已經套用的
-- 規則完全一致，管理員之外沒有任何例外或後門。
--
-- 【关于「避免未来要调档案时查不到」】只要是用管理員角色登入（不是切換成
-- 教師視角預覽），這七張表全部都還是可以正常查到已離校學生的完整歷史資料——
-- 這是刻意保留的設計，不會因為這次補洞而受影響。
-- ============================================================

drop policy if exists hide_status_changed_students_conduct_events on conduct_events;
create policy hide_status_changed_students_conduct_events on conduct_events
  as restrictive
  using (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

-- student_remarks 用 enrollment_id，要透過 enrollments 反查 student_no，
-- 跟 scores 表用的是同一個手法。
drop policy if exists hide_status_changed_students_student_remarks on student_remarks;
create policy hide_status_changed_students_student_remarks on student_remarks
  as restrictive
  using (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden((select e.student_no from enrollments e where e.id = student_remarks.enrollment_id))
  )
  with check (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden((select e.student_no from enrollments e where e.id = student_remarks.enrollment_id))
  );

drop policy if exists hide_status_changed_students_guardians on guardians;
create policy hide_status_changed_students_guardians on guardians
  as restrictive
  using (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  )
  with check (
    (select current_role_name()) in ('admin_a', 'admin_b', 'system_admin_s')
    or not student_is_hidden(student_no)
  );

-- ------------------------------------------------------------
-- guardian_phones_for_roster()（sql/83fix_roster_pii_exposure.sql，學生名冊
-- 給非導師教師看監護人電話用）本身是 security definer，不受一般 RLS 政策
-- 影響（包括上面剛加的 guardians 隱藏規則）——直接在函式本身也加上同一個
-- 判斷，雙重保險：不管是透過畫面點名冊、還是直接呼叫這支函式，都不會查到
-- 休學/轉學/退學/畢業/肄業學生的監護人電話。
-- ------------------------------------------------------------
create or replace function guardian_phones_for_roster(p_student_no text)
returns table(relation text, name text, phone text) as $$
  select g.relation, g.name, g.phone
  from guardians g
  where g.student_no = p_student_no
    and exists (select 1 from app_users where id = auth.uid())
    and not student_is_hidden(p_student_no);
$$ language sql stable security definer;

notify pgrst, 'reload schema';
