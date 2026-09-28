-- ============================================================
-- 93. 獎懲登記（大功／小功／嘉獎／大過／小過／警告）
-- ------------------------------------------------------------
-- conduct_events 這張表從 schema.sql 起就存在（也已經接上操行成績加減分，見
-- sql/46 discipline_adjustment()），但一直沒有任何登錄畫面，也沒有「原因」欄位，
-- 只有 sql/28 開放管理者角色寫入。這一版補上：
--   1. reason 欄位（原因）、created_at。
--   2. 訓導部門（has_department('discipline')）與系統管理員S：可寫入全部 6 種獎懲、
--      全校任何學生（含批次登記）。admin_a/admin_b 依 sql/35 預設就掛在訓導部門底下。
--   3. 其他教師：只能新增（不能改、不能刪）、只能登記「嘉獎」「小功」，單筆上限
--      1 小功，且只限自己「有教過」的班級（導師班，或 class_schedule 排過課的班級）
--      裡的學生。原因必填。
-- 已存在的 unique (student_no, event_date, event_type)（sql/28）維持不動，
-- 「一鍵上傳」仍靠它做 upsert。
-- ============================================================

alter table conduct_events add column if not exists reason text;
alter table conduct_events add column if not exists created_at timestamptz not null default now();

-- 這位登入教師「有教過」這位學生所在的班級嗎？
create or replace function teacher_teaches_student(p_student_no text)
returns boolean as $$
  select exists (
    select 1
    from enrollments e
    join classes c on c.id = e.class_id
    where e.student_no = p_student_no
      and (
        c.homeroom_teacher_id = current_teacher_id()
        or exists (
          select 1 from class_schedule cs
          where cs.class_id = e.class_id and cs.teacher_id = current_teacher_id()
        )
      )
  );
$$ language sql stable security definer set search_path = public;

-- 政策：訓導部門／系統管理員S 完整讀寫；教師只能新增（受限）。讀取沿用 sql/28 的 read_conduct_events。
drop policy if exists discipline_write_conduct_events on conduct_events;
create policy discipline_write_conduct_events on conduct_events for all
  using (is_system_admin() or has_department('discipline'))
  with check (is_system_admin() or has_department('discipline'));

drop policy if exists teacher_insert_conduct_events on conduct_events;
create policy teacher_insert_conduct_events on conduct_events for insert
  with check (
    recorded_by = current_teacher_id()
    and event_type in ('嘉獎', '小功')
    and teacher_teaches_student(student_no)
  );

-- 觸發器：教師登記時，點數由伺服器依 conduct_point_defaults 決定（不信任前端傳的值），
-- 上限 1 小功（單筆），原因必填。訓導部門/管理員不受這個限制。
create or replace function enforce_conduct_event_rules() returns trigger as $$
declare
  v_default numeric;
begin
  if is_system_admin() or has_department('discipline') then
    -- 訓導/管理員：不限種類、不限點數；原因由登記畫面要求必填（不在這裡強制，
    -- 避免影響 lib/bulkHandlers.ts「一鍵上傳」既有沒有原因欄位的批次匯入）。
    return new;
  end if;

  if new.reason is null or btrim(new.reason) = '' then
    raise exception '獎懲登記一定要填寫原因';
  end if;
  if new.event_type not in ('嘉獎', '小功') then
    raise exception '教師只能登記嘉獎或小功';
  end if;
  select points into v_default from conduct_point_defaults where item = new.event_type;
  new.points := coalesce(v_default, case new.event_type when '小功' then 3 else 1 end);
  if new.points > 3 then
    raise exception '教師單筆獎勵上限為 1 小功';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_enforce_conduct_event_rules on conduct_events;
create trigger trg_enforce_conduct_event_rules
  before insert on conduct_events
  for each row execute function enforce_conduct_event_rules();
