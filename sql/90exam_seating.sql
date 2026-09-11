-- ============================================================
-- 90. 考試分班（教務處【考試分班】＋ 導師【輸入考場名單】）
-- ------------------------------------------------------------
-- 對應附件「考場.txt」規格：
--   教務處：進【考試分班】頁 → 選考場（借用目前有開設的某個班級教室，人數
--     上限＝該班目前人數）→ 選在這個考場考試的班級與人數（可手動調整，預設
--     平均分配）→ 用梅花座（7*7）盡量讓同班考生不相鄰 → 確認存檔 → 全部考場
--     都設定完後【發送考場表】通知各班導師。
--   導師：收到通知後從【輸入考場名單】頁把自己班學生填入被分配到的各考場
--     座位（可用「隨機分配」）→【完成名單】送出並鎖定，不可再更改。
--
-- 資料表設計：
--   exam_periods              一次「考試分班」作業（例如「115上學期期中考」）
--   exam_rooms                 考場＝借用某個現有班級的教室，capacity 是借用當下
--                               那個班的人數快照
--   exam_room_class_allocations 這個考場裡，各應試班級分配到的人數
--   exam_room_seats             考場座位（固定 7*7=49 格），梅花座排定後每格
--                               記錄「屬於哪個應試班級」，導師再把學生填進屬於
--                               自己班的格子（student_no）
--   exam_class_submissions      導師「完成名單」的送出紀錄（有這筆＝已鎖定，
--                               不能再改，比照 sql/43restrict_teacher_lock_one_way.sql
--                               「只能鎖、不能自己解鎖」的精神，導師沒有刪除這張表
--                               的權限，要重新開放只能由教務處/管理員處理）
-- ============================================================

create table if not exists exam_periods (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  name text not null,                                   -- 例如「期中考」「模擬考」
  status text not null default '設定中' check (status in ('設定中', '已發送')),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists exam_rooms (
  id uuid primary key default gen_random_uuid(),
  exam_period_id uuid not null references exam_periods(id) on delete cascade,
  room_class_id uuid not null references classes(id),   -- 借用哪個班的教室當考場
  capacity int not null,                                 -- 快照：借用當下那個班的目前人數
  seats_confirmed boolean not null default false,        -- 梅花座已排定並存檔（=可以發送）
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (exam_period_id, room_class_id)
);

create table if not exists exam_room_class_allocations (
  id uuid primary key default gen_random_uuid(),
  exam_room_id uuid not null references exam_rooms(id) on delete cascade,
  class_id uuid not null references classes(id),         -- 應試班級（不一定等於借用教室的那個班）
  student_count int not null default 0 check (student_count >= 0),
  created_at timestamptz not null default now(),
  unique (exam_room_id, class_id)
);

-- 固定 7*7=49 格。seat_row/seat_col 從 1 開始，class_id 是梅花座排定後這一格
-- 屬於哪個應試班級（null＝空位），student_no 是導師後續填入的學生。
create table if not exists exam_room_seats (
  id uuid primary key default gen_random_uuid(),
  exam_room_id uuid not null references exam_rooms(id) on delete cascade,
  seat_row int not null check (seat_row between 1 and 7),
  seat_col int not null check (seat_col between 1 and 7),
  class_id uuid references classes(id),
  student_no text references students(student_no),
  updated_at timestamptz not null default now(),
  unique (exam_room_id, seat_row, seat_col)
);

create index if not exists idx_exam_rooms_period on exam_rooms(exam_period_id);
create index if not exists idx_exam_room_class_allocations_room on exam_room_class_allocations(exam_room_id);
create index if not exists idx_exam_room_seats_room on exam_room_seats(exam_room_id);
create index if not exists idx_exam_room_seats_class on exam_room_seats(class_id);
create index if not exists idx_exam_room_seats_student on exam_room_seats(student_no) where student_no is not null;

create table if not exists exam_class_submissions (
  id uuid primary key default gen_random_uuid(),
  exam_period_id uuid not null references exam_periods(id) on delete cascade,
  class_id uuid not null references classes(id),
  submitted_by uuid references app_users(id),
  submitted_at timestamptz not null default now(),
  unique (exam_period_id, class_id)
);

create index if not exists idx_exam_class_submissions_period on exam_class_submissions(exam_period_id);

-- 方便判斷「這個考試場次、這個班，導師是否已經完成名單（鎖定）」，UI／RLS 都會用到
create or replace function exam_class_is_locked(p_exam_period_id uuid, p_class_id uuid)
returns boolean as $$
  select exists (
    select 1 from exam_class_submissions
    where exam_period_id = p_exam_period_id and class_id = p_class_id
  );
$$ language sql stable;

alter table exam_periods enable row level security;
alter table exam_rooms enable row level security;
alter table exam_room_class_allocations enable row level security;
alter table exam_room_seats enable row level security;
alter table exam_class_submissions enable row level security;

-- ---------- exam_periods ----------
-- 讀取：教務部門／系統管理員看全部；一般教師只能看到「已發送」的場次
-- （設定中的場次還沒輪到導師知道，避免看到教務處還在調整中的半成品）。
create policy read_exam_periods on exam_periods
  for select
  using (
    is_system_admin() or has_department('academic')
    or (status = '已發送' and current_role_name() is not null)
  );

create policy academic_write_exam_periods on exam_periods
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---------- exam_rooms / exam_room_class_allocations ----------
-- 兩張表都是教務處在【考試分班】頁設定用的資料，讀取／寫入都只開放教務部門與
-- 系統管理員；導師端的【輸入考場名單】頁完全不需要直接讀這兩張表（見上方
-- exam_room_seats 的說明，導師只需要看到「屬於自己班的座位格」）。
create policy academic_all_exam_rooms on exam_rooms
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

create policy academic_all_exam_room_class_allocations on exam_room_class_allocations
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---------- exam_room_seats ----------
-- 讀取：教務部門／系統管理員看整個考場（預覽簽到表/座位表用）；導師只能看到
-- 「屬於自己班、而且這個考試場次已經發送」的座位格——設定中還沒發送的場次，
-- 教務處可能還在調整座位，不該讓導師提前看到（也對應下面 exam_periods 的
-- read 政策：一般教師本來就讀不到「設定中」的 exam_periods，這裡座位格
-- 再加一層同樣的限制，避免教師直接查 exam_room_seats 繞過那層限制）。
create policy read_exam_room_seats on exam_room_seats
  for select
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from classes c
      join exam_rooms er on er.id = exam_room_seats.exam_room_id
      join exam_periods ep on ep.id = er.exam_period_id
      where c.id = exam_room_seats.class_id
        and c.homeroom_teacher_id = current_teacher_id()
        and ep.status = '已發送'
    )
  );

-- 新增／刪除／改「這一格屬於哪個應試班級」：只有教務部門（梅花座排定/重排）
create policy academic_write_exam_room_seats on exam_room_seats
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- 導師只能「更新屬於自己班、而且這個班在這個考試場次還沒送出（未鎖定）」的
-- 座位格，而且只能改 student_no（畫面上也只會讓導師改這一欄；class_id／
-- seat_row／seat_col 這些梅花座排定的欄位不歸導師管，這裡用 with check 確保
-- 這幾欄改回同一個值，等於「只能改 student_no」）。
create policy homeroom_fill_own_class_seats on exam_room_seats
  for update
  using (
    exists (
      select 1 from classes c
      join exam_rooms er on er.id = exam_room_seats.exam_room_id
      join exam_periods ep on ep.id = er.exam_period_id
      where c.id = exam_room_seats.class_id
        and c.homeroom_teacher_id = current_teacher_id()
        and ep.status = '已發送'
        and not exam_class_is_locked(er.exam_period_id, exam_room_seats.class_id)
    )
  )
  with check (
    exists (
      select 1 from classes c
      join exam_rooms er on er.id = exam_room_seats.exam_room_id
      join exam_periods ep on ep.id = er.exam_period_id
      where c.id = exam_room_seats.class_id
        and c.homeroom_teacher_id = current_teacher_id()
        and ep.status = '已發送'
        and not exam_class_is_locked(er.exam_period_id, exam_room_seats.class_id)
    )
  );

-- ---------- exam_class_submissions ----------
-- 讀取：教務部門看全部（判斷是否所有班級都送出，才能列印）；導師看自己班的。
create policy read_exam_class_submissions on exam_class_submissions
  for select
  using (
    is_system_admin() or has_department('academic')
    or exists (
      select 1 from classes c
      where c.id = exam_class_submissions.class_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

-- 導師「完成名單」：只能新增自己班的送出紀錄，unique(exam_period_id, class_id)
-- 保證同一場考試同一班只能送出一次；沒有 update／delete 政策＝導師無法自己
-- 撤銷送出（跟 sql/43 的「只能鎖不能解鎖」精神一致，要重新開放需教務處/系統
-- 管理員直接到資料庫處理，畫面上刻意不提供「解鎖」按鈕，避免導師名單送出後
-- 又反悔偷改，失去「完成名單」鎖定的意義）。
create policy homeroom_submit_own_class on exam_class_submissions
  for insert
  with check (
    exists (
      select 1 from classes c
      where c.id = exam_class_submissions.class_id
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

create policy academic_manage_exam_class_submissions on exam_class_submissions
  for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ============================================================
-- 站內通知：沿用 staff_notifications（見 sql/8attendance_alerts_and_guardian_edit.sql、
-- sql/31substitute_notifications.sql），這裡加：
--   1. 新的 category「考場通知」
--   2. link_url 欄位（原本這張表所有通知都只是純文字訊息，這次需求明確要求
--      「導師收到通知後,可從通知連接到【輸入考場名單】」，之前沒有這個需求
--      所以沒做——不是漏掉，是這是第一個真的需要「通知可以點進去跳頁」的功能）
-- ============================================================
alter table staff_notifications drop constraint if exists staff_notifications_category_check;
alter table staff_notifications add constraint staff_notifications_category_check
  check (category in ('個資修改申請', '出缺勤示警', '代課通知', '考場通知'));

alter table staff_notifications add column if not exists link_url text;

-- 教務處按【發送考場表】時，由前端（不是資料庫觸發器）逐一幫每個有分到考場的
-- 班級導師寫入一筆通知——這裡刻意不用 trigger 自動發送，因為「發送考場表」
-- 是教務處確認「所有考場都設定完成」後才手動按的動作，不是每次新增
-- exam_room_seats 資料列就要通知（設定過程中會一直新增/覆蓋座位資料，用
-- trigger 會變成每改一次座位就轟炸導師一次通知）。
