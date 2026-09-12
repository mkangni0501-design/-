-- ============================================================
-- 90. 考試分班 / 考場編排
-- ------------------------------------------------------------
-- 對應「考場2.txt」規格：
--   教務處：【考試分班】頁 → 新增/刪除考試 → 各應試班級分配考場 →
--           自動依座位數比例計算各班分配人數（四捨五入＋雙驗證，可手動修改）→
--           依梅花座演算法（方形座位、最大7*7）排出座位表 → 確認儲存 →
--           全部考場設定完後【發送考場表】通知各班導師。
--   導師：收到通知 →【輸入考場名單】填入本班學生在各考場的座位 → 可用隨機分配 →
--         【完成名單】送出並鎖定 → 管理者可預覽並列印座位表／簽到表。
--
-- 執行順序：接在既有 sql/ 資料夾最後（89...之後）執行本檔。
-- 需要 schema.sql（classes / enrollments / students / teachers / app_users）、
-- 2policies.sql（current_role_name() / current_teacher_id()）、
-- 19department_rbac_refactor.sql + 26fix_department_recursion_and_module_visibility.sql
-- （is_system_admin() / has_department()）、
-- 8attendance_alerts_and_guardian_edit.sql（staff_notifications）都已執行過。
-- ============================================================

-- ---------- 0. 保險：先清掉可能殘留的舊版本（例如先前執行到一半中斷、留下欄位不完整的表） ----------
-- 這六張表是這次新增的功能專用，此時不會有任何正式資料，drop cascade 重建最安全，
-- 避免「create table if not exists」誤判成表已存在、卻不是這個檔案要的欄位結構
-- （例如缺了 exam_session_id，導致下面的政策/觸發器出現「column does not exist」）。
drop table if exists exam_class_roster_status cascade;
drop table if exists exam_seat_students cascade;
drop table if exists exam_room_seats cascade;
drop table if exists exam_room_classes cascade;
drop table if exists exam_rooms cascade;
drop table if exists exam_sessions cascade;

-- ---------- 1. 考試（教務處【新增考試】/【刪除考試】） ----------
create table if not exists exam_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,                         -- 例如「113學年度上學期期中考」
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  status text not null default '編排中' check (status in ('編排中', '已發送', '已完成')),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- ---------- 2. 考場（教室＋座位數；系統依座位數換算出方形座位表，最大7*7=49） ----------
create table if not exists exam_rooms (
  id uuid primary key default gen_random_uuid(),
  exam_session_id uuid not null references exam_sessions(id) on delete cascade,
  room_name text not null,                    -- 例如「101教室」
  seat_capacity int not null check (seat_capacity > 0 and seat_capacity <= 49),
  grid_size int not null check (grid_size > 0 and grid_size <= 7),  -- 方形邊長（ceil(sqrt(座位數))，最大7）
  confirmed boolean not null default false,   -- 教務處按【確認】後鎖定座位表
  confirmed_at timestamptz,
  unique (exam_session_id, room_name)
);

-- ---------- 3. 各應試班級分配於哪幾個考場，以及計算/手動修改後的人數 ----------
create table if not exists exam_room_classes (
  id uuid primary key default gen_random_uuid(),
  exam_room_id uuid not null references exam_rooms(id) on delete cascade,
  class_id uuid not null references classes(id),
  allocated_count int not null default 0 check (allocated_count >= 0), -- 該班分配到此考場的人數（四捨五入後，可手動修改）
  unique (exam_room_id, class_id)
);
create index if not exists idx_exam_room_classes_class on exam_room_classes(class_id);

-- ---------- 4. 考場座位表：依梅花座演算法產生，每個座位屬於哪個班（教務處按【確認】後寫入並鎖定） ----------
create table if not exists exam_room_seats (
  id uuid primary key default gen_random_uuid(),
  exam_room_id uuid not null references exam_rooms(id) on delete cascade,
  seat_no int not null,                       -- 考場座位序號 1..座位數（依梅花座排列順序編號）
  row_no int not null,
  col_no int not null,
  class_id uuid references classes(id),       -- null＝該座位為空位（座位數大於實際分配人數時）
  unique (exam_room_id, seat_no)
);
create index if not exists idx_exam_room_seats_room on exam_room_seats(exam_room_id);
create index if not exists idx_exam_room_seats_class on exam_room_seats(class_id);

-- ---------- 5. 導師輸入：考場座位實際坐哪位學生（原班座號） ----------
create table if not exists exam_seat_students (
  exam_room_seat_id uuid primary key references exam_room_seats(id) on delete cascade,
  student_no text references students(student_no),
  class_seat_no int,                          -- 原班座號（對照 enrollments.seat_no），方便導師核對
  updated_by uuid references teachers(id),
  updated_at timestamptz not null default now()
);

-- ---------- 6. 各班在該次考試的名單提交狀態（導師按【完成名單】後鎖定，不得再改） ----------
create table if not exists exam_class_roster_status (
  id uuid primary key default gen_random_uuid(),
  exam_session_id uuid not null references exam_sessions(id) on delete cascade,
  class_id uuid not null references classes(id),
  submitted boolean not null default false,
  submitted_by uuid references teachers(id),
  submitted_at timestamptz,
  unique (exam_session_id, class_id)
);

-- ============================================================
-- Row-Level Security
-- ============================================================
alter table exam_sessions enable row level security;
alter table exam_rooms enable row level security;
alter table exam_room_classes enable row level security;
alter table exam_room_seats enable row level security;
alter table exam_seat_students enable row level security;
alter table exam_class_roster_status enable row level security;

-- ---- exam_sessions：教務處（系統管理員S／教務部門）可完整管理；已登入教職員都可讀（導師端需要看到考試名稱） ----
create policy read_exam_sessions on exam_sessions
  for select
  using (auth.uid() is not null);

create policy academic_manage_exam_sessions on exam_sessions
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---- exam_rooms：教務處管理；已登入教職員都可讀 ----
create policy read_exam_rooms on exam_rooms
  for select
  using (auth.uid() is not null);

create policy academic_manage_exam_rooms on exam_rooms
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---- exam_room_classes：教務處管理；已登入教職員都可讀（導師需要看到自己班分配到哪些考場/人數） ----
create policy read_exam_room_classes on exam_room_classes
  for select
  using (auth.uid() is not null);

create policy academic_manage_exam_room_classes on exam_room_classes
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---- exam_room_seats：教務處管理（產生/確認座位表）；已登入教職員都可讀（導師需要看到哪些座位序號屬於自己班） ----
create policy read_exam_room_seats on exam_room_seats
  for select
  using (auth.uid() is not null);

create policy academic_manage_exam_room_seats on exam_room_seats
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---- exam_seat_students：導師只能填寫「屬於自己班」且「該班名單尚未鎖定」的座位；教務處/系統管理員可讀寫全部（預覽、必要時協助修正） ----
create policy read_exam_seat_students on exam_seat_students
  for select
  using (auth.uid() is not null);

create policy academic_write_exam_seat_students on exam_seat_students
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

create policy homeroom_write_own_class_exam_seat_students on exam_seat_students
  for all
  using (
    exists (
      select 1
      from exam_room_seats ers
      join classes c on c.id = ers.class_id
      where ers.id = exam_seat_students.exam_room_seat_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
    and not exists (
      select 1
      from exam_room_seats ers
      join exam_rooms er on er.id = ers.exam_room_id
      join exam_class_roster_status rs
        on rs.exam_session_id = er.exam_session_id and rs.class_id = ers.class_id
      where ers.id = exam_seat_students.exam_room_seat_id
        and rs.submitted = true
    )
  )
  with check (
    exists (
      select 1
      from exam_room_seats ers
      join classes c on c.id = ers.class_id
      where ers.id = exam_seat_students.exam_room_seat_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- ---- exam_class_roster_status：教務處全權；導師只能對自己帶的班級寫入（送出【完成名單】），且不能把已鎖定的改回未鎖定 ----
create policy read_exam_class_roster_status on exam_class_roster_status
  for select
  using (auth.uid() is not null);

create policy academic_manage_exam_class_roster_status on exam_class_roster_status
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

create policy homeroom_submit_own_class_roster_status on exam_class_roster_status
  for all
  using (
    exists (select 1 from classes c where c.id = exam_class_roster_status.class_id and c.homeroom_teacher_id = current_teacher_id())
    and submitted = false
  )
  with check (
    exists (select 1 from classes c where c.id = exam_class_roster_status.class_id and c.homeroom_teacher_id = current_teacher_id())
  );

-- ============================================================
-- 7. 【發送考場表】：教務處把考試狀態改成「已發送」時，自動通知每個有分配到考場的班級導師
-- ============================================================
alter table staff_notifications drop constraint if exists staff_notifications_category_check;
alter table staff_notifications add constraint staff_notifications_category_check
  check (category in ('個資修改申請', '出缺勤示警', '代課通知', '考場通知'));

create or replace function notify_homeroom_on_exam_session_sent() returns trigger as $$
declare
  v_teacher_id uuid;
  v_class_label text;
  v_class_id uuid;
begin
  if new.status = '已發送' and (old.status is distinct from '已發送') then
    for v_class_id, v_teacher_id, v_class_label in
      select distinct c.id, c.homeroom_teacher_id, coalesce(c.grade_level, '') || coalesce(c.class_name, '')
      from exam_room_classes erc
      join exam_rooms er on er.id = erc.exam_room_id
      join classes c on c.id = erc.class_id
      where er.exam_session_id = new.id and c.homeroom_teacher_id is not null
    loop
      insert into staff_notifications (teacher_id, category, message)
      values (
        v_teacher_id,
        '考場通知',
        new.name || '考場表已公布，請進入【輸入考場名單】填入' || v_class_label || '學生的考場座位。'
      );
      insert into exam_class_roster_status (exam_session_id, class_id, submitted)
      values (new.id, v_class_id, false)
      on conflict (exam_session_id, class_id) do nothing;
    end loop;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_notify_on_exam_session_sent on exam_sessions;
create trigger trg_notify_on_exam_session_sent
  after update on exam_sessions
  for each row execute function notify_homeroom_on_exam_session_sent();
