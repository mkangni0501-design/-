-- ============================================================
-- 修正「成績登錄」權限：
-- 原本 can_write_score() 只要「是這班的導師」就能修改/新增/刪除全班任何科目的成績，
-- 但正確規則應該是：
--   - 管理員 S/A/B：可以直接修改、登錄任何成績（不受鎖定限制）。
--   - 班級導師／任課教師：只能輸入「自己實際教的科目」（class_schedule 裡有指派到
--     這個班級＋這個科目的人），就算是自己導的班，其他科老師的成績也不能碰。
--     （查看全班成績不受影響，scores_select 政策本來就允許導師看全班、任課老師只看自己教的科目，這裡不需要動。）
--
-- 請在 Supabase SQL Editor 執行本檔一次。
-- ============================================================

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

  if current_role_name() in ('admin_a', 'admin_b', 'system_admin_s') then
    return true; -- 管理員不受鎖定限制，負責審核與最終處理
  end if;

  -- 只認「任課教師設定」裡實際指派的班級＋科目，不再因為「是這班導師」就自動放行所有科目。
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

  -- 鎖定後：導師與任課教師都必須有核准的修正申請才能再寫
  return p_score_id is not null and has_approved_correction(p_score_id);
end;
$$ language plpgsql stable security definer;
