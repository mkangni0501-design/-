-- ============================================================
-- 代課安排完成後，自動發站內通知給「原任課教師」與「代課教師」
-- ------------------------------------------------------------
-- 沿用 sql/8attendance_alerts_and_guardian_edit.sql 已經在用的 staff_notifications
-- 站內通知機制（跟「家長送出個資修改申請時通知導師」同一套），這裡比照做法：
-- 新增一個 trigger，substitute_assignments 每 insert 一筆，就各發一則通知給
-- 原任課教師、代課教師。用 security definer 觸發器寫入，不受寫入者本身的
-- RLS 限制（跟 notify_homeroom_on_profile_edit_request() 一樣的作法）。
-- ============================================================

-- category 原本只允許 '個資修改申請'／'出缺勤示警' 兩種，這裡加一種「代課通知」
alter table staff_notifications drop constraint if exists staff_notifications_category_check;
alter table staff_notifications add constraint staff_notifications_category_check
  check (category in ('個資修改申請', '出缺勤示警', '代課通知'));

create or replace function notify_teachers_on_substitute_assignment() returns trigger as $$
declare
  v_class_label text;
begin
  select coalesce(c.grade_level, '') || coalesce(c.class_name, '')
    into v_class_label
  from classes c where c.id = new.class_id;

  insert into staff_notifications (teacher_id, category, message)
  values (
    new.original_teacher_id,
    '代課通知',
    new.substitute_date || ' 第' || new.period_no || '節（' || coalesce(v_class_label, '') || '／' || new.subject ||
      '）已安排代課，代課教師：' || coalesce((select name from teachers where id = new.substitute_teacher_id), '') ||
      coalesce('，事由：' || new.reason, '')
  );

  insert into staff_notifications (teacher_id, category, message)
  values (
    new.substitute_teacher_id,
    '代課通知',
    new.substitute_date || ' 第' || new.period_no || '節（' || coalesce(v_class_label, '') || '／' || new.subject ||
      '）已安排由您代課，原任課教師：' || coalesce((select name from teachers where id = new.original_teacher_id), '') ||
      coalesce('，事由：' || new.reason, '')
  );

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_notify_on_substitute_assignment on substitute_assignments;
create trigger trg_notify_on_substitute_assignment
  after insert on substitute_assignments
  for each row execute function notify_teachers_on_substitute_assignment();
