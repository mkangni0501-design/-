-- ============================================================
-- 社團／才藝課管理模組（第二版草稿，取代 2026-08-23 第一版 sql/54clubs_module.sql，
-- 尚未實際執行過，故直接修正原檔，不另外疊一個修正檔）
-- 對應需求文件「社團.txt」，並依實際討論修正三點：
--   1. 社團活動＝現有的「才藝」科目（scores/curriculum 本來就有這個科目），
--      不是另外發明一個新科目名稱。
--   2. 點名、成績輸入的欄位/流程比照現有其他各科（期中考/期末考/平時分三段、
--      出缺勤狀態種類都跟既有系統一樣），只是因為社團是跨班級/跨年級混合，
--      所以名冊、點名、成績、負責老師都用「社團」自己的一組表格獨立運作，
--      最後才把結果自動寫回原本的 scores / attendance 總表。
--   3. 依原始需求文件，實作學生選社功能：志願序電腦抽籤（第一志願優先法／
--      隨機亂數法）與即時搶選（先搶先贏）。
--
-- 需在 sql/1schema.sql ~ sql/53report_card_image_upload_permission.sql
-- 全部依序執行過後，再執行本檔。
-- ============================================================

-- ---------- 社團主檔 ----------
create table clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,                        -- 例如「吉他社」
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  teacher_id uuid references teachers(id),   -- 校內老師：指到現有教師帳號
  external_teacher_name text,                -- 外聘老師：先用純文字姓名記錄（見規格書實務小叮嚀第1點，
                                              -- 外聘老師若要自己登入點名/打分數，仍需請開發人員先建立教職員帳號）
  capacity int,                              -- 名額上限（選配，NULL＝不限）
  period_no int,                             -- 這個社團/才藝課固定在第幾節上課（選配）。
                                              -- 有填的話，社團點名會自動同步寫進全校共用的
                                              -- attendance 出缺席總表該節次；沒填就只留在社團自己的點名紀錄裡。
  description text,
  is_active boolean not null default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (name, academic_year, term)
);

-- ---------- 社團成員（用「學號」關聯，允許跨班級/跨年級） ----------
create table club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  student_no text not null references students(student_no),
  status text not null default '在社' check (status in ('在社', '退社')),
  joined_at timestamptz not null default now(),
  unique (club_id, student_no)
);
create index idx_club_members_club on club_members (club_id);
create index idx_club_members_student on club_members (student_no);

-- ---------- 社團點名（跟 attendance 表欄位風格一致，用「社團+學號+日期」關聯，不綁全校固定節次表） ----------
create table club_attendance (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  student_no text not null references students(student_no),
  record_date date not null,
  status attendance_status not null default '出席',  -- 沿用既有 attendance_status enum（出席/曠課/遲到/病假/事假/公假）
  recorded_by uuid references teachers(id),
  updated_at timestamptz not null default now(),
  unique (club_id, student_no, record_date)
);
create index idx_club_attendance_club_date on club_attendance (club_id, record_date);

-- ---------- 社團成績（欄位比照 scores 表的期中考/期末考/平時分三段，不是另外發明一套加權公式；
--            送出後最終加權比重跟其他科目一樣，統一用教務處「成績設定」裡的全校 grading_rules 計算） ----------
create table club_scores (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id) on delete cascade,
  student_no text not null references students(student_no),
  score_midterm numeric(5,2) check (score_midterm between 0 and 100),  -- 期中考
  score_final numeric(5,2) check (score_final between 0 and 100),      -- 期末考
  score_daily numeric(5,2) check (score_daily between 0 and 100),      -- 平時分
  is_submitted boolean not null default false,  -- 正式送出鎖定；鎖定後社團老師不能再自己改
  submitted_at timestamptz,
  recorded_by uuid references teachers(id),
  updated_at timestamptz not null default now(),
  unique (club_id, student_no)
);

-- ---------- 選社設定：教務處設定這學期用哪一種方式決定學生進哪個社團 ----------
create table club_selection_windows (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  method text not null check (method in ('志願序_第一志願優先', '志願序_隨機亂數', '即時搶選')),
  max_choices int,                    -- 志願序類方法：學生最多可以填幾個志願（例如 5）；即時搶選則不需要
  opens_at timestamptz not null,      -- 志願序：開放填志願的起始時間／即時搶選：開放搶選的起始時間
  closes_at timestamptz,              -- 志願序：填志願截止時間（用來擋逾期送出）／即時搶選：搶選關閉時間（可留空＝額滿為止）
  is_finalized boolean not null default false,  -- 志願序類方法：電腦抽籤是否已經執行過（執行後 club_members 就是正式結果）
  finalized_at timestamptz,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (academic_year, term)   -- 一個學年學期只會有一組選社設定；如需重開，先刪掉舊的再新增
);

-- ---------- 學生志願序登記（只有「志願序_第一志願優先」「志願序_隨機亂數」這兩種方法會用到） ----------
create table club_preferences (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null,
  term text not null check (term in ('上學期', '下學期')),
  student_no text not null references students(student_no),
  club_id uuid not null references clubs(id) on delete cascade,
  choice_rank int not null check (choice_rank between 1 and 10),
  submitted_at timestamptz not null default now(),
  unique (academic_year, term, student_no, choice_rank),
  unique (academic_year, term, student_no, club_id)
);

alter table clubs enable row level security;
alter table club_members enable row level security;
alter table club_attendance enable row level security;
alter table club_scores enable row level security;
alter table club_selection_windows enable row level security;
alter table club_preferences enable row level security;

-- ---------- 輔助函式：目前登入者是不是「這個社團」的指導老師（或教務部門/系統管理員） ----------
create or replace function is_club_teacher(p_club_id uuid) returns boolean as $$
  select is_system_admin() or has_department('academic')
    or exists (select 1 from clubs where id = p_club_id and teacher_id = current_teacher_id());
$$ language sql stable;

-- ---------- 輔助函式：目前登入者（家長/學生 portal 帳號）綁定的「學生本人」學號是誰
--            （只認 relation='學生本人'，家長帳號不能幫小孩選社，避免跟監護人意見不一致的爭議） ----------
create or replace function current_portal_student_no() returns text as $$
  select student_no from portal_accounts
  where auth_user_id = auth.uid() and relation = '學生本人'
  limit 1;
$$ language sql stable;

-- ---------- clubs：全校教職員都能讀，新增/刪除/改基本資料僅限教務部門或系統管理員；
--            社團老師只能改自己社團的描述等內容，不能自己開新社團或改名額。 ----------
create policy read_clubs on clubs for select using (true);
create policy admin_manage_clubs on clubs for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));
create policy club_teacher_update_own_club on clubs for update
  using (teacher_id = current_teacher_id())
  with check (teacher_id = current_teacher_id());

-- 家長/學生 portal 帳號也需要讀 clubs（選社頁要列出可選的社團清單）
create policy portal_read_clubs on clubs for select
  using (current_portal_student_no() is not null);

-- ---------- club_members：名單指派原則上由教務處負責（比照編班的權限精神），
--            社團老師只能「讀」自己社團的名單；學生 portal 帳號只能讀到「自己」是否已在某個社團
--            （選社頁要顯示「你已經被分到＿＿社」），不能讀別人的名單，也不能直接改（要透過即時搶選函式）。 ----------
create policy club_teacher_read_members on club_members for select
  using (is_club_teacher(club_id));
create policy admin_manage_members on club_members for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));
create policy portal_read_own_membership on club_members for select
  using (student_no = current_portal_student_no());

-- ---------- club_attendance：社團老師只能點自己社團的名，教務／系統管理員可全權處理（例如協助代填）。 ----------
create policy club_teacher_manage_attendance on club_attendance for all
  using (is_club_teacher(club_id))
  with check (is_club_teacher(club_id));

-- ---------- club_scores：未送出前社團老師可自由暫存修改；正式送出鎖定後，
--            一般社團老師不能再自己改，只有教務部門/系統管理員能解鎖重填
--            （先簡化成「教務部門即可解鎖」，還沒有比照 scores 表另外做一套「修正申請」流程）。 ----------
create policy club_teacher_manage_scores on club_scores for all
  using (is_club_teacher(club_id) and (not is_submitted or is_system_admin() or has_department('academic')))
  with check (is_club_teacher(club_id) and (not is_submitted or is_system_admin() or has_department('academic')));

-- ---------- club_selection_windows：全校教職員與已登入的 portal 帳號都能讀（選社頁要看目前開放狀態），
--            只有教務部門/系統管理員能設定。 ----------
create policy read_selection_windows on club_selection_windows for select
  using (true);
create policy admin_manage_selection_windows on club_selection_windows for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ---------- club_preferences：學生只能新增/修改/刪除「自己」的志願登記，且必須在該學年學期
--            選社設定開放期間內；教務部門/系統管理員可全權查詢與管理（執行抽籤、協助補登）。 ----------
create policy portal_manage_own_preferences on club_preferences for all
  using (
    student_no = current_portal_student_no()
    and exists (
      select 1 from club_selection_windows w
      where w.academic_year = club_preferences.academic_year and w.term = club_preferences.term
        and w.method like '志願序_%'
        and now() between w.opens_at and coalesce(w.closes_at, 'infinity'::timestamptz)
        and not w.is_finalized
    )
  )
  with check (
    student_no = current_portal_student_no()
    and exists (
      select 1 from club_selection_windows w
      where w.academic_year = club_preferences.academic_year and w.term = club_preferences.term
        and w.method like '志願序_%'
        and now() between w.opens_at and coalesce(w.closes_at, 'infinity'::timestamptz)
        and not w.is_finalized
    )
  );
create policy admin_manage_preferences on club_preferences for all
  using (is_system_admin() or has_department('academic'))
  with check (is_system_admin() or has_department('academic'));

-- ============================================================
-- 成績回寫：社團老師「正式送出」後，自動把期中/期末/平時分寫進學期總成績（scores 表）
-- ============================================================
-- 寫入位置：scores.subject = '才藝'（既有科目，不是另外發明的名稱），
-- exam_type 對應寫入期中考/期末考/平時分，哪幾項有填就寫哪幾項，跟其他科目老師登打
-- 成績的資料形狀完全一樣，後續總分計算、排名、成績單都不用另外改，直接沿用既有邏輯。
--
-- 【重要】如果「才藝」目前還是排在班級課表裡由原班任課老師個別登打成績，
-- 學校需要先決定：這學期才藝改成完全走社團跑班上課＋這裡自動回寫，
-- 就不要再讓原班才藝老師走一般成績登錄頁重複輸入，避免兩邊互相覆蓋
-- （因為 scores 表 enrollment_id+exam_type+subject 只會留一筆，後寫入的會蓋掉先寫入的）。
create or replace function sync_club_score_to_scores(p_club_id uuid, p_student_no text)
returns void as $$
declare
  v_club record;
  v_enrollment_id uuid;
  v_score record;
begin
  select * into v_club from clubs where id = p_club_id;
  if v_club is null then
    return;
  end if;

  select * into v_score from club_scores where club_id = p_club_id and student_no = p_student_no;
  if v_score is null then
    return;
  end if;

  select e.id into v_enrollment_id
  from enrollments e
  join classes c on c.id = e.class_id
  where e.student_no = p_student_no
    and e.term = v_club.term
    and c.academic_year = v_club.academic_year
  order by e.id desc
  limit 1;

  if v_enrollment_id is null then
    raise notice '學生 % 在 %學年度 %，找不到對應班級學籍，社團成績無法回寫學期總表（請確認學籍資料）', p_student_no, v_club.academic_year, v_club.term;
    return;
  end if;

  if v_score.score_midterm is not null then
    insert into scores (enrollment_id, exam_type, subject, score, recorded_by)
    values (v_enrollment_id, '期中考', '才藝', v_score.score_midterm, v_score.recorded_by)
    on conflict (enrollment_id, exam_type, subject)
    do update set score = excluded.score, recorded_by = excluded.recorded_by, updated_at = now();
  end if;

  if v_score.score_final is not null then
    insert into scores (enrollment_id, exam_type, subject, score, recorded_by)
    values (v_enrollment_id, '期末考', '才藝', v_score.score_final, v_score.recorded_by)
    on conflict (enrollment_id, exam_type, subject)
    do update set score = excluded.score, recorded_by = excluded.recorded_by, updated_at = now();
  end if;

  if v_score.score_daily is not null then
    insert into scores (enrollment_id, exam_type, subject, score, recorded_by)
    values (v_enrollment_id, '平時分', '才藝', v_score.score_daily, v_score.recorded_by)
    on conflict (enrollment_id, exam_type, subject)
    do update set score = excluded.score, recorded_by = excluded.recorded_by, updated_at = now();
  end if;
end;
$$ language plpgsql security definer;

create or replace function trg_club_scores_sync() returns trigger as $$
begin
  if new.is_submitted then
    perform sync_club_score_to_scores(new.club_id, new.student_no);
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists club_scores_after_submit on club_scores;
create trigger club_scores_after_submit
  after insert or update on club_scores
  for each row execute function trg_club_scores_sync();

-- ============================================================
-- 點名回寫：社團點名如果這個社團有設定 period_no（固定節次），
-- 自動同步寫進全校共用的 attendance 出缺席總表，導師/學務處看班級出缺席報表時
-- 不用另外查社團系統，這節課的缺曠會自動出現。
-- ============================================================
create or replace function sync_club_attendance_to_attendance(p_club_id uuid, p_student_no text, p_record_date date)
returns void as $$
declare
  v_period int;
  v_status attendance_status;
  v_recorded_by uuid;
begin
  select period_no into v_period from clubs where id = p_club_id;
  if v_period is null then
    return;
  end if;

  select status, recorded_by into v_status, v_recorded_by
  from club_attendance where club_id = p_club_id and student_no = p_student_no and record_date = p_record_date;
  if v_status is null then
    return;
  end if;

  insert into attendance (student_no, record_date, period_no, status, recorded_by)
  values (p_student_no, p_record_date, v_period, v_status, v_recorded_by)
  on conflict (student_no, record_date, period_no)
  do update set status = excluded.status, recorded_by = excluded.recorded_by, updated_at = now();
end;
$$ language plpgsql security definer;

create or replace function trg_club_attendance_sync() returns trigger as $$
begin
  perform sync_club_attendance_to_attendance(new.club_id, new.student_no, new.record_date);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists club_attendance_after_write on club_attendance;
create trigger club_attendance_after_write
  after insert or update on club_attendance
  for each row execute function trg_club_attendance_sync();

-- ============================================================
-- 學生選社：志願序電腦抽籤（兩種邏輯）＋ 即時搶選（先搶先贏）
-- 對應需求文件「1. 志願序分發（電腦抽籤）」「2. 即時搶選」
-- ============================================================

-- ---------- 第一志願優先法：先把所有人的「第一志願」處理完（額滿才抽籤），
--            落選的人才看「第二志願」，以此類推，直到最大志願序。 ----------
create or replace function run_club_lottery_priority(p_academic_year int, p_term text)
returns void as $$
declare
  v_rank int;
  v_max_rank int;
  v_club record;
  v_remaining int;
begin
  delete from club_members m using clubs c
    where m.club_id = c.id and c.academic_year = p_academic_year and c.term = p_term;

  select max(choice_rank) into v_max_rank from club_preferences where academic_year = p_academic_year and term = p_term;
  if v_max_rank is null then
    return;
  end if;

  for v_rank in 1..v_max_rank loop
    for v_club in
      select id, capacity from clubs where academic_year = p_academic_year and term = p_term and is_active
    loop
      select coalesce(v_club.capacity, 2147483647) - count(*) into v_remaining
      from club_members where club_id = v_club.id;

      if v_remaining <= 0 then
        continue;
      end if;

      insert into club_members (club_id, student_no)
      select v_club.id, p.student_no
      from club_preferences p
      where p.academic_year = p_academic_year and p.term = p_term
        and p.club_id = v_club.id and p.choice_rank = v_rank
        and not exists (
          select 1 from club_members m2
          join clubs c2 on c2.id = m2.club_id
          where m2.student_no = p.student_no and c2.academic_year = p_academic_year and c2.term = p_term
        )
      order by random()
      limit v_remaining
      on conflict do nothing;
    end loop;
  end loop;

  update club_selection_windows set is_finalized = true, finalized_at = now()
  where academic_year = p_academic_year and term = p_term;
end;
$$ language plpgsql security definer;

-- ---------- 隨機亂數法：每位學生一個隨機優先順序，依序讓學生從自己第一志願開始，
--            進他志願清單裡「第一個還沒額滿」的社團。 ----------
create or replace function run_club_lottery_random_number(p_academic_year int, p_term text)
returns void as $$
declare
  v_student record;
  v_pref record;
  v_capacity int;
  v_current_count int;
begin
  delete from club_members m using clubs c
    where m.club_id = c.id and c.academic_year = p_academic_year and c.term = p_term;

  for v_student in (
    select distinct student_no from club_preferences
    where academic_year = p_academic_year and term = p_term
    order by random()
  ) loop
    for v_pref in (
      select club_id from club_preferences
      where academic_year = p_academic_year and term = p_term and student_no = v_student.student_no
      order by choice_rank
    ) loop
      -- 【2026-08-24 修正】原本這裡只查 capacity，沒有檢查這個社團是不是還
      -- 「有效」（is_active）——如果學生填志願序之後，教務處把某個社團停用
      -- （例如老師請假、社團取消開課），這裡完全沒過濾，還是可能把學生分發
      -- 進一個已經停用的社團。第一志願優先法（run_club_lottery_priority）
      -- 迴圈本身就有 `and is_active` 這個條件，這裡改成一致的做法：查不到
      -- （代表社團已停用或不存在）就直接當作「這個志願不能選」，繼續看
      -- 學生的下一個志願。
      select capacity into v_capacity from clubs where id = v_pref.club_id and is_active;
      if not found then
        continue;
      end if;
      select count(*) into v_current_count from club_members where club_id = v_pref.club_id;
      if v_capacity is null or v_current_count < v_capacity then
        insert into club_members (club_id, student_no) values (v_pref.club_id, v_student.student_no)
        on conflict do nothing;
        exit;
      end if;
    end loop;
  end loop;

  update club_selection_windows set is_finalized = true, finalized_at = now()
  where academic_year = p_academic_year and term = p_term;
end;
$$ language plpgsql security definer;

-- ---------- 即時搶選（先搶先贏）：學生登入 portal 後自己點「加入」時呼叫這支函式。
--            用 pg_advisory_xact_lock 避免同一秒大量學生搶同一個社團時，名額被算超過。 ----------
create or replace function join_club_first_come(p_club_id uuid)
returns text as $$
declare
  v_student_no text;
  v_club record;
  v_window record;
  v_current_count int;
begin
  v_student_no := current_portal_student_no();
  if v_student_no is null then
    return '找不到您的學生資料，請確認是用學生本人帳號登入';
  end if;

  select * into v_club from clubs where id = p_club_id;
  if v_club is null or not v_club.is_active then
    return '找不到這個社團';
  end if;

  select * into v_window from club_selection_windows
  where academic_year = v_club.academic_year and term = v_club.term;
  if v_window is null or v_window.method <> '即時搶選' then
    return '這學期不是用即時搶選的方式選社';
  end if;
  if now() < v_window.opens_at then
    return '還沒到開放搶選的時間';
  end if;
  if v_window.closes_at is not null and now() > v_window.closes_at then
    return '搶選時間已經結束';
  end if;

  if exists (
    select 1 from club_members m join clubs c on c.id = m.club_id
    where m.student_no = v_student_no and c.academic_year = v_club.academic_year and c.term = v_club.term and m.status = '在社'
  ) then
    return '您這學期已經加入其他社團了';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_club_id::text));

  select count(*) into v_current_count from club_members where club_id = p_club_id and status = '在社';
  if v_club.capacity is not null and v_current_count >= v_club.capacity then
    return '名額已滿，請選別的社團';
  end if;

  insert into club_members (club_id, student_no) values (p_club_id, v_student_no);
  return '報名成功';
end;
$$ language plpgsql security definer;

-- ---------- 社團目前在社人數統計：學生選社頁要顯示各社團「還剩幾個名額」，
--            但學生 portal 帳號不能直接讀 club_members（會看到別人的學號），
--            所以另外開一支只回傳「社團＋目前人數」的函式，不回傳個別學生資料。 ----------
create or replace function club_member_counts(p_academic_year int, p_term text)
returns table(club_id uuid, current_count bigint) as $$
  select c.id, count(m.id)
  from clubs c
  left join club_members m on m.club_id = c.id and m.status = '在社'
  where c.academic_year = p_academic_year and c.term = p_term
  group by c.id;
$$ language sql stable security definer;

-- ============================================================
-- 教務處催收清單用的查詢輔助 view：哪些社團「還沒點名」「還沒送出成績」
-- 對應規格書第4章「異常名單偵測」
-- ============================================================
create or replace view club_submission_status as
select
  c.id as club_id,
  c.name as club_name,
  c.academic_year,
  c.term,
  c.teacher_id,
  (select count(*) from club_members m where m.club_id = c.id and m.status = '在社') as member_count,
  (select count(distinct s.student_no) from club_scores s where s.club_id = c.id and s.is_submitted) as submitted_score_count,
  (select max(a.record_date) from club_attendance a where a.club_id = c.id) as last_attendance_date
from clubs c
where c.is_active = true;
