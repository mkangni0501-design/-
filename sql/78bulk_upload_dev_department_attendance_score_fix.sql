-- ============================================================
-- 78. 修正「批次上傳全校出缺席表會出現錯誤」
-- ------------------------------------------------------------
-- 根因（找到並確認過，不是憑空猜測）：
--
-- 1. 「開發人員」區「一鍵上傳」（components/dev-tools/BulkExcelPanel.tsx）裡的
--    「全校出缺勤(現況)」工作表，寫回資料庫是呼叫
--    lib/bulkHandlers.ts 的 uploadAllAttendanceSheet()，對 attendance 表逐列
--    upsert，實際能不能寫入由 attendance 表的 RLS 政策
--    homeroom_and_subject_teacher_write_attendance（呼叫 can_write_attendance()）
--    把關。
--
-- 2. app/(app)/admin/dev-tools/page.tsx 這個頁面本身的進入權限是
--    `isSystemAdmin || hasDepartment(myDepartments, 'dev')`——也就是說，任何
--    「開發人員」部門的帳號都看得到、也點得到這個「一鍵上傳」功能，UI 完全沒有
--    擋。但 sql/22department_policy_rewrite_complete.sql 把 can_write_attendance()
--    的管理員豁免範圍，從原本「不分部門的 admin_a/admin_b/system_admin_s」，
--    改成只有「is_system_admin() or has_department('discipline')」——漏了
--    'dev' 部門。can_write_score() 也是同樣的模式，豁免只給
--    is_system_admin() or has_department('academic')，一樣漏了 'dev'。
--
-- 3. 結果：一個「開發人員」部門的帳號（不是系統管理員、也不是訓導/教務部門），
--    用「一鍵上傳」上傳全校出缺勤（或全校成績）時，對於不是自己班級／不是自己
--    任教科目的每一列，can_write_attendance()／can_write_score() 都會判斷
--    v_is_owner 為 false 直接回傳 false，RLS 擋下寫入，upsert 回傳權限錯誤——
--    對「全校」範圍的批次上傳來說，這幾乎等於每一列都會失敗，就是回報的
--    「批次上傳全校出缺席表會出現錯誤」。
--
-- 修法：can_write_attendance()／can_write_score() 的管理員豁免，比照
-- app/(app)/admin/dev-tools/page.tsx 頁面本身的權限模型，把 'dev' 部門也一併
-- 納入豁免（is_system_admin() or has_department('discipline') or
-- has_department('dev')；成績同理换成 'academic'）。這不影響訓導/教務部門原本
-- 的權限，也不影響一般導師/任課教師平常登錄出缺勤/成績時仍然受班級歸屬與鎖定
-- 規則限制——只有「開發人員」部門額外取得跟訓導/教務同等的、用於批次匯入/資料
-- 搬遷情境的寫入豁免，跟這個帳號本來就能透過「一鍵上傳」動到全校所有資料的
-- 頁面權限一致。
-- ============================================================

create or replace function can_write_attendance(p_student_no text, p_record_date date, p_period_no int, p_attendance_id uuid default null)
returns boolean as $$
declare
  v_is_owner boolean;
begin
  if is_system_admin() or has_department('discipline') or has_department('dev') then
    return true;
  end if;

  v_is_owner := exists (
    select 1 from enrollments e
    join classes c on c.id = e.class_id
    where e.student_no = p_student_no
      and c.homeroom_teacher_id = current_teacher_id()
  ) or exists (
    select 1 from enrollments e
    join class_schedule cs on cs.class_id = e.class_id
    where e.student_no = p_student_no
      and cs.teacher_id = current_teacher_id()
      and cs.period_no = p_period_no
  );
  if not v_is_owner then
    return false;
  end if;

  if not attendance_locked(p_student_no, p_record_date) then
    return true;
  end if;

  return (p_attendance_id is not null and has_approved_correction(p_attendance_id))
    or exists (
      select 1 from enrollments e
      where e.student_no = p_student_no
        and has_approved_window_open(e.class_id)
    );
end;
$$ language plpgsql stable security definer;
-- homeroom_and_subject_teacher_write_attendance 政策本身呼叫 can_write_attendance()，
-- 上面 create or replace 完就自動套用新規則，政策陳述式不用重建。

-- 同一個「一鍵上傳」也涵蓋「全校成績(現況)」，can_write_score() 有一模一樣的
-- 缺口（豁免只給 academic 部門，漏了 dev），一併修正，理由同上。
create or replace function can_write_score(p_enrollment_id uuid, p_subject text, p_exam_type text, p_score_id uuid default null)
returns boolean as $$
declare
  v_class_id uuid;
  v_academic_year int;
  v_term text;
  v_is_owner boolean;
begin
  select c.id, c.academic_year, e.term into v_class_id, v_academic_year, v_term
  from enrollments e join classes c on c.id = e.class_id
  where e.id = p_enrollment_id;

  if is_system_admin() or has_department('academic') or has_department('dev') then
    return true; -- 教務處不受鎖定限制，負責審核與最終處理；開發人員批次匯入情境同理
  end if;

  v_is_owner := exists (
    select 1 from class_schedule cs
    where cs.class_id = v_class_id and cs.teacher_id = current_teacher_id() and cs.subject = p_subject
  );

  if not v_is_owner then
    return false;
  end if;

  if not scores_locked(v_class_id, v_academic_year, v_term, p_exam_type) then
    return true;
  end if;

  return p_score_id is not null and has_approved_correction(p_score_id);
end;
$$ language plpgsql stable security definer;
