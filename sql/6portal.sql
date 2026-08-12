-- ============================================================
-- 家長/學生查詢入口（Portal）
-- 需在 schema.sql、policies.sql、calculations.sql、registration.sql 執行後再執行本檔
-- ============================================================

-- ---------- 帳號綁定：登入代碼(HY+學號) + 信箱，兩者都要對得上 ----------
-- 不用 Google OAuth（那需要另外去 Google Cloud Console 申請憑證），
-- 改用 Supabase 內建的「電子郵件驗證碼/連結」(OTP) 登入：家長不用設密碼，
-- 系統寄一組驗證連結到登記的信箱，點開即完成身份驗證，跟輸入登入代碼合起來就是兩個因素都要對。
-- 不把家長/學生放進 app_users（那是給校務人員用的角色體系），
-- 家長/學生是完全獨立的一組身份，只透過這張表跟特定學號綁在一起。
create table if not exists portal_accounts (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no) on delete cascade,
  login_code text not null unique,       -- 'HY' || 學號，例如 HY0123 / HY262034，建立帳號時自動產生
  email text not null,                   -- 校方登記的家長/學生信箱，登入時必須跟這個一致（可直接帶入監護人資料的email）
  relation text not null default '家長', -- 家長／學生本人
  auth_user_id uuid references auth.users(id), -- 第一次成功登入且比對相符後才會填入
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_accounts_email on portal_accounts (lower(email));

-- ---------- 基本資料修改申請：家長/學生送出，導師核准後才真的更新，並留下核准時間 ----------
create table if not exists profile_edit_requests (
  id uuid primary key default gen_random_uuid(),
  student_no text not null references students(student_no) on delete cascade,
  field_name text not null,              -- 例如 address, phone
  old_value text,
  new_value text not null,
  requested_by uuid references portal_accounts(id),
  requested_at timestamptz not null default now(),
  status text not null default '待審核' check (status in ('待審核', '已核准', '已駁回')),
  reviewed_by uuid references app_users(id),
  reviewed_at timestamptz
);

-- ---------- 判斷目前登入者（家長/學生）是否綁定某個學號 ----------
create or replace function is_linked_parent(p_student_no text) returns boolean as $$
  select exists (
    select 1 from portal_accounts pa
    where pa.auth_user_id = auth.uid() and pa.student_no = p_student_no
  );
$$ language sql stable;

-- ============================================================
-- 收緊 students / enrollments 的權限（現在要開放校外連線，這兩張表不能再無限制開放讀取）
-- ============================================================
alter table students enable row level security;
alter table enrollments enable row level security;

create policy staff_read_students on students
  for select
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e
      join classes c on c.id = e.class_id
      where e.student_no = students.student_no
        and (
          c.homeroom_teacher_id = current_teacher_id()
          or exists (select 1 from class_schedule cs where cs.class_id = c.id and cs.teacher_id = current_teacher_id())
        )
    )
  );

create policy parent_read_own_student on students
  for select
  using (is_linked_parent(students.student_no));

create policy admin_write_students on students
  for insert
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy admin_delete_students on students
  for delete
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- students 的 update 特別處理：管理員可以任意改，
-- 但「基本資料修改申請被核准」這個動作是透過伺服器端 API（用 service role）執行，不經過這條政策，
-- 所以這裡只開放管理員直接寫入，導師不能繞過申請流程直接改學生資料。
create policy admin_update_students on students
  for update
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

create policy staff_read_enrollments on enrollments
  for select
  using (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from classes c
      where c.id = enrollments.class_id
        and (
          c.homeroom_teacher_id = current_teacher_id()
          or exists (select 1 from class_schedule cs where cs.class_id = c.id and cs.teacher_id = current_teacher_id())
        )
    )
  );

create policy parent_read_own_enrollments on enrollments
  for select
  using (is_linked_parent(enrollments.student_no));

create policy admin_write_enrollments on enrollments
  for all
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ============================================================
-- 讓家長/學生也能「讀」自己小孩的成績、出缺勤、學籍狀態
-- （用「新增一條政策」的方式疊加，不動到原本教師/導師的政策）
-- ============================================================
create policy parent_read_own_scores on scores
  for select
  using (exists (select 1 from enrollments e where e.id = scores.enrollment_id and is_linked_parent(e.student_no)));

create policy parent_read_own_attendance on attendance
  for select
  using (is_linked_parent(attendance.student_no));

create policy parent_read_own_status_changes on student_status_changes
  for select
  using (is_linked_parent(student_status_changes.student_no));

create policy parent_read_own_attachments on status_change_attachments
  for select
  using (
    exists (
      select 1 from student_status_changes sc
      where sc.id = status_change_attachments.status_change_id
        and is_linked_parent(sc.student_no)
    )
  );

-- ============================================================
-- 讓家長/學生也能看到「自己小孩」的班排名/年級排名（鎖定後才顯示，跟導師規則一致）
-- 用 create or replace view 疊加在 calculations.sql 已經定義好的 view 上面，
-- 不用回頭改 calculations.sql，維持各檔案各司其職。
-- ============================================================
create or replace view class_rankings
with (security_invoker = true)
as
select * from (
  select
    t.enrollment_id,
    e.class_id,
    e.term,
    c.academic_year,
    st.name,
    e.seat_no,
    t.total_score,
    rank() over (partition by e.class_id, e.term order by t.total_score desc) as class_rank,
    e.student_no
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
) ranked
where (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  )
  and exists (
    select 1 from submission_windows sw
    where sw.data_type = '平時分'
      and sw.scope = '班級'
      and sw.scope_ref = ranked.class_id::text
      and sw.academic_year = ranked.academic_year
      and sw.term = ranked.term
      and sw.is_locked = true
  );

create or replace view grade_rankings
with (security_invoker = true)
as
select * from (
  select
    t.enrollment_id,
    e.class_id,
    e.term,
    c.academic_year,
    c.department,
    c.grade_level,
    st.name,
    e.seat_no,
    t.total_score,
    rank() over (
      partition by c.academic_year, e.term, c.department, c.grade_level
      order by t.total_score desc
    ) as grade_rank,
    e.student_no
  from student_total_scores t
  join enrollments e on e.id = t.enrollment_id
  join classes c on c.id = e.class_id
  join students st on st.student_no = e.student_no
) ranked
where (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (select 1 from classes c2 where c2.id = ranked.class_id and c2.homeroom_teacher_id = current_teacher_id())
    or is_linked_parent(ranked.student_no)
  )
  and exists (
    select 1 from submission_windows sw
    where sw.data_type = '平時分'
      and sw.scope = '班級'
      and sw.scope_ref = ranked.class_id::text
      and sw.academic_year = ranked.academic_year
      and sw.term = ranked.term
      and sw.is_locked = true
  );
alter table portal_accounts enable row level security;

-- 家長/學生只能看到自己已經綁定成功的那筆（auth_user_id對得上自己）
create policy self_read_portal_account on portal_accounts
  for select
  using (auth_user_id = auth.uid());

-- 建立/管理帳號綁定：導師（該生現任導師）與管理員可以新增
create policy staff_create_portal_accounts on portal_accounts
  for insert
  with check (
    current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = portal_accounts.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );

create policy staff_manage_portal_accounts on portal_accounts
  for update
  using (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'))
  with check (current_role_name() in ('admin_a', 'admin_b', 'system_admin_s'));

-- ---------- profile_edit_requests 的權限 ----------
alter table profile_edit_requests enable row level security;

create policy parent_create_edit_request on profile_edit_requests
  for insert
  with check (
    exists (select 1 from portal_accounts pa where pa.id = profile_edit_requests.requested_by and pa.auth_user_id = auth.uid())
  );

create policy parent_read_own_edit_requests on profile_edit_requests
  for select
  using (
    exists (select 1 from portal_accounts pa where pa.id = profile_edit_requests.requested_by and pa.auth_user_id = auth.uid())
    or current_role_name() in ('admin_a', 'admin_b', 'system_admin_s')
    or exists (
      select 1 from enrollments e join classes c on c.id = e.class_id
      where e.student_no = profile_edit_requests.student_no
        and c.homeroom_teacher_id = current_teacher_id()
    )
  );
-- 核准/駁回本身不開放給一般 RLS update，改用伺服器端 API（見 app/api/portal/approve-edit）處理，
-- 確保「核准後同時更新 students 表＋記錄核准時間」是同一個交易內完成，不會兩邊不同步。
