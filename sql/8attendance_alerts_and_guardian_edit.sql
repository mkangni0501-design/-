-- ============================================================
-- 一、出缺席紀錄：
--   1) 管理者可設定「事假+病假+曠課」累計節數門檻，達到門檻時導師可自行選擇是否寄發通知信
--      （同時留下紀錄給管理者查看）。
--   2) 家長/學生查詢頁：出缺席狀況在「達門檻一半」時要特別放大顯示。
-- 二、家長/學生查詢頁的「監護人」資料修改，需要能核准到 guardians 表（不是 students 表）。
--
-- 執行順序：schema.sql → policies.sql → calculations.sql → registration.sql →
-- portal.sql → student_edit.sql → attendance_window_open_requests.sql →
-- exam_type_rankings.sql → 本檔。
-- ============================================================

-- ---------- 1. 出缺席示警門檻設定（全校只有一組設定值） ----------
create table if not exists attendance_alert_settings (
  id int primary key default 1,
  threshold_periods int not null default 3, -- 事假+病假+曠課 累計節數達到這個值，導師端就會出現是否寄信的提示
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  constraint attendance_alert_settings_singleton check (id = 1)
);
insert into attendance_alert_settings (id, threshold_periods)
  values (1, 3)
  on conflict (id) do nothing;

alter table attendance_alert_settings enable row level security;

-- 門檻數字不算敏感資料：只要是登入的使用者（教職員或家長/學生）都要能讀到，
-- 才能在導師端跟家長端都正確顯示「還差幾節會達標」。
create policy read_attendance_alert_settings on attendance_alert_settings
  for select
  using (auth.uid() is not null);

create policy admin_write_attendance_alert_settings on attendance_alert_settings
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ---------- 2. 各生「事假+病假+曠課」等各類出缺勤累計節數 ----------
-- 注意：跟先前「學生出席紀錄查詢」頁一樣，資料庫沒有存學期起訖日，
-- 這裡採計「目前資料庫中已登錄的所有出缺勤紀錄」累計節數（security_invoker 會沿用
-- attendance 表既有的 RLS：任課教師只看得到自己任教節次、導師看得到自己班級、
-- 管理員看全校、家長看自己小孩）。
create view student_absence_counts
with (security_invoker = true)
as
select
  student_no,
  count(*) filter (where status in ('事假', '病假', '曠課')) as absence_periods,
  count(*) filter (where status = '事假') as personal_leave_periods,
  count(*) filter (where status = '病假') as sick_leave_periods,
  count(*) filter (where status = '曠課') as truancy_periods,
  count(*) filter (where status = '遲到') as late_periods,
  count(*) filter (where status = '公假') as excused_periods,
  count(*) filter (where status = '出席') as present_periods
from attendance
group by student_no;

-- ---------- 3. 通知信寄送紀錄（導師的選擇，管理者可查看全部） ----------
create table if not exists attendance_notifications (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no) on delete cascade,
  absence_count int not null,       -- 送出當下的「事假+病假+曠課」累計節數
  threshold_snapshot int not null,  -- 送出當下的門檻設定值（門檻之後若被管理者調整，這裡仍保留當時的值）
  decision text not null check (decision in ('已寄送', '不寄送')),
  note text,
  decided_by uuid references teachers(id),
  created_at timestamptz not null default now()
);

alter table attendance_notifications enable row level security;

-- 導師（該生現任班級導師）與管理員可以新增紀錄
create policy homeroom_insert_attendance_notifications on attendance_notifications
  for insert
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = attendance_notifications.student_no
        and e.is_current = true
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 查看：管理員看全部；導師只看得到自己班級學生的紀錄（任課教師看不到——這是導師/管理者之間的溝通紀錄）
create policy staff_read_attendance_notifications on attendance_notifications
  for select
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = attendance_notifications.student_no
        and e.is_current = true
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- ---------- 4. 讓「基本資料修改申請」也能用來修改監護人資料（guardians 表），不只是 students 表 ----------
-- target_table 決定核准時要更新哪張表；guardian_id 只有在 target_table='guardians' 時才會用到。
alter table profile_edit_requests
  add column if not exists target_table text not null default 'students' check (target_table in ('students', 'guardians'));
alter table profile_edit_requests
  add column if not exists guardian_id uuid references guardians(id);

-- 家長也要能讀到自己小孩的監護人資料，才能在修改表單上看到「目前的監護人資料」
create policy parent_read_own_guardians on guardians
  for select
  using (is_linked_parent(guardians.student_no));

-- ---------- 5. 站內通知（給導師）：家長送出基本資料/監護人修改申請時，自動通知該生現任導師 ----------
create table if not exists staff_notifications (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id),
  category text not null check (category in ('個資修改申請', '出缺勤示警')),
  message text not null,
  student_no text references students(student_no),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table staff_notifications enable row level security;

create policy teacher_read_own_notifications on staff_notifications
  for select
  using (teacher_id = current_teacher_id() or current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy teacher_mark_own_notifications_read on staff_notifications
  for update
  using (teacher_id = current_teacher_id())
  with check (teacher_id = current_teacher_id());

-- 一般不開放直接 insert（都是透過下面的觸發器自動產生），管理員例外方便測試/手動補發
create policy admin_insert_notifications on staff_notifications
  for insert
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- 家長送出基本資料/監護人修改申請時，自動通知該生現任導師（security definer：不受申請人本身的 RLS 限制）
create or replace function notify_homeroom_on_profile_edit_request() returns trigger as $$
declare
  v_teacher_id uuid;
  v_student_name text;
begin
  select c.homeroom_teacher_id into v_teacher_id
  from enrollments e
  join classes c on c.id = e.class_id
  where e.student_no = new.student_no and e.is_current = true
  limit 1;

  if v_teacher_id is not null then
    select name into v_student_name from students where student_no = new.student_no;
    insert into staff_notifications (teacher_id, category, message, student_no)
    values (
      v_teacher_id,
      '個資修改申請',
      coalesce(v_student_name, new.student_no) || ' 的家長／學生申請修改「' || new.field_name || '」，請至「學生資料修改申請審核」頁面處理。',
      new.student_no
    );
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_notify_homeroom_on_profile_edit_request on profile_edit_requests;
create trigger trg_notify_homeroom_on_profile_edit_request
  after insert on profile_edit_requests
  for each row execute function notify_homeroom_on_profile_edit_request();
