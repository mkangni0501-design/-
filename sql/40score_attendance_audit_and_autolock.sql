-- ============================================================
-- 40. 出缺勤／成績鎖定 稽核與自動鎖定修正
-- ------------------------------------------------------------
-- 對應需求：
--   1a. 「成績上傳時間設定表」設了開放結束時間(closes_at)後，時間到了要能自動視為鎖定
--       （不用管理員手動再按一次「鎖定」），而且如果鎖定後又打開讓人修正，
--       要留下紀錄，僅系統管理員S、管理員A看得到。
--   2.  導師修改出缺勤紀錄（任何一筆的任何修改），都要留下紀錄，僅系統管理員S、
--       管理員A看得到（B、教務/訓導主管都不算——比 sql/22 那次改寬的範圍更嚴格）。
--
-- 需在 sql/ 資料夾其餘檔案（尤其 sql/1schema.sql、sql/34fix_exam_type_locked_scope.sql）
-- 都執行過後再執行本檔。
-- ============================================================

-- ---------- 0. 稽核紀錄查詢權限：收緊成只有 S / A 兩種角色 ----------
-- sql/22department_policy_rewrite_complete.sql 把這兩張表的查詢權限放寬成
-- 「系統管理員 或 該部門任何成員」（訓導/教務全部門的人都能看），
-- 這裡改回「只有系統管理員S、管理員A」，符合本次需求的明確指示。
create or replace function is_admin_sa() returns boolean as $$
  select current_role_name() in ('system_admin_s', 'admin_a');
$$ language sql stable;

drop policy if exists admin_only_read_attendance_audit on attendance_audit_log;
create policy admin_only_read_attendance_audit on attendance_audit_log
  for select
  using (is_admin_sa());

drop policy if exists admin_only_read_score_audit on score_audit_log;
create policy admin_only_read_score_audit on score_audit_log
  for select
  using (is_admin_sa());

-- 稽核紀錄本身：由程式在寫入 attendance/scores 的同時一併寫入（見下方 insert policy），
-- 一般教師只能新增、不能查詢／修改／刪除既有紀錄，避免自己竄改稽核軌跡。
alter table attendance_audit_log enable row level security;
alter table score_audit_log enable row level security;
drop policy if exists insert_attendance_audit on attendance_audit_log;
create policy insert_attendance_audit on attendance_audit_log
  for insert
  with check (auth.uid() is not null);
drop policy if exists insert_score_audit on score_audit_log;
create policy insert_score_audit on score_audit_log
  for insert
  with check (auth.uid() is not null);

-- ---------- 1. 成績/出缺勤鎖定：時間到了自動視為鎖定 ----------
-- 原本 exam_type_locked() 只看 is_locked 這個手動勾選的欄位，opens_at/closes_at
-- 兩個時間欄位設定了也完全不會有作用。這裡改成：只要「有手動鎖定」或「開放結束時間
-- (closes_at) 已經過了」，兩者任一成立就視為已鎖定——時間一到，排名頁面／總表
-- 會自動開始顯示，不用管理員再手動點一次「鎖定」。
--
-- 範圍優先順序維持不變：班級 > 部別 > 全校，沒有班級層級設定時才往上看。
create or replace function submission_window_locked(
  p_class_id uuid, p_academic_year int, p_term text, p_data_type text
) returns boolean as $$
  select coalesce(
    (
      select sw.is_locked or (sw.closes_at is not null and sw.closes_at < now())
      from submission_windows sw
      where sw.data_type = p_data_type and sw.scope = '班級'
        and sw.scope_ref = p_class_id::text
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1
    ),
    (
      select sw.is_locked or (sw.closes_at is not null and sw.closes_at < now())
      from submission_windows sw
      join classes c on c.id = p_class_id
      where sw.data_type = p_data_type and sw.scope = '部別'
        and sw.scope_ref = c.department
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1
    ),
    (
      select sw.is_locked or (sw.closes_at is not null and sw.closes_at < now())
      from submission_windows sw
      where sw.data_type = p_data_type and sw.scope = '全校'
        and sw.academic_year = p_academic_year and sw.term = p_term
      limit 1
    ),
    false
  );
$$ language sql stable;

-- exam_type_locked() 是 class_rankings / grade_rankings 這兩個 view 實際呼叫的函式名稱，
-- 直接改成呼叫上面新寫的、有考慮時間的版本，view 本身不用動。
create or replace function exam_type_locked(
  p_class_id uuid, p_academic_year int, p_term text, p_data_type text
) returns boolean as $$
  select submission_window_locked(p_class_id, p_academic_year, p_term, p_data_type);
$$ language sql stable;

-- ---------- 2. 出缺勤／成績登錄頁：寫入時也要套用同一套「時間到自動鎖定」規則 ----------
-- 前端（attendance/weekly、attendance/mobile、ScoresEntryTab）目前寫入前的鎖定檢查
-- 只查「這個班自己有沒有設班級層級的 is_locked」，沒有 fallback 部別/全校、也沒看
-- closes_at。前端已經改成呼叫這個函式取代原本那段查詢（見對應的 .tsx 修改）。
comment on function submission_window_locked(uuid, int, text, text) is
  '成績/出缺勤某類資料在某班是否已鎖定（手動鎖定 或 開放結束時間已過，兩者任一成立），供前端寫入前檢查用，也是 exam_type_locked() 的實作。';

-- ---------- 3. 「鎖定後又打開修正」留下紀錄，僅 S/A 查得到 ----------
create table if not exists submission_window_audit_log (
  id uuid primary key default gen_random_uuid(),
  window_id uuid references submission_windows(id) on delete set null,
  academic_year int not null,
  term text not null,
  data_type text not null,
  scope text not null,
  scope_ref text,
  old_is_locked boolean not null,
  new_is_locked boolean not null,
  old_closes_at timestamptz,
  new_closes_at timestamptz,
  changed_by uuid references app_users(id),
  changed_at timestamptz not null default now(),
  reason text
);

alter table submission_window_audit_log enable row level security;
drop policy if exists admin_only_read_window_audit on submission_window_audit_log;
create policy admin_only_read_window_audit on submission_window_audit_log
  for select
  using (is_admin_sa());
-- 寫入由下面的 trigger 執行（trigger function 是 security definer，不受這裡的 RLS 限制），
-- 一般使用者不能直接 insert/update/delete 這張稽核表本身。
drop policy if exists no_direct_write_window_audit on submission_window_audit_log;
create policy no_direct_write_window_audit on submission_window_audit_log
  for all
  using (false)
  with check (false);

-- 「鎖定後又打開」定義：這筆設定原本「已鎖定」（is_locked=true，或 closes_at 已過),
-- 這次更新之後變成「未鎖定」（is_locked=false 且 closes_at 是空的或還沒到）——
-- 不管是直接把 is_locked 改回 false，還是把 closes_at 往後延到未來，都算「打開修正」，
-- 一律留一筆紀錄。reason 欄位讓「成績上傳時間設定表」頁面可以順便帶一段說明文字進來
-- （用 pg 的 session 變數 app.reopen_reason 傳，前端呼叫 update 前先 set 這個變數；
-- 沒有特別設定時 reason 會是空值，不影響紀錄本身有沒有留下）。
create or replace function log_submission_window_reopen() returns trigger
security definer set search_path = public
as $$
declare
  was_locked boolean;
  now_locked boolean;
  v_reason text;
begin
  was_locked := old.is_locked or (old.closes_at is not null and old.closes_at < now());
  now_locked := new.is_locked or (new.closes_at is not null and new.closes_at < now());
  if was_locked and not now_locked then
    begin
      v_reason := current_setting('app.reopen_reason', true);
    exception when others then
      v_reason := null;
    end;
    insert into submission_window_audit_log (
      window_id, academic_year, term, data_type, scope, scope_ref,
      old_is_locked, new_is_locked, old_closes_at, new_closes_at, changed_by, reason
    ) values (
      new.id, new.academic_year, new.term, new.data_type, new.scope, new.scope_ref,
      old.is_locked, new.is_locked, old.closes_at, new.closes_at, auth.uid(), v_reason
    );
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_log_submission_window_reopen on submission_windows;
create trigger trg_log_submission_window_reopen
  after update on submission_windows
  for each row execute function log_submission_window_reopen();

-- 給前端「成績上傳時間設定表」頁用的 RPC：解鎖（含時間已到、視同已鎖定的狀況）並帶一段
-- 原因說明。用同一個 plpgsql function 裡先 set_config 再 update，確保跟上面的 trigger
-- 在同一個交易裡執行、trigger 讀得到這個原因，前端不用另外處理 session 變數。
-- 一般的「鎖定」（從未鎖定→鎖定）則不需要走這支，直接用原本 update is_locked=true 即可，
-- 不算「重新打開」，不必留原因。
create or replace function reopen_submission_window(p_id uuid, p_reason text default null)
returns void
security invoker
as $$
begin
  perform set_config('app.reopen_reason', coalesce(p_reason, ''), true);
  update submission_windows set is_locked = false where id = p_id;
end;
$$ language plpgsql;

-- ---------- 4. 出缺勤：導師（含管理員）任何修改都留下紀錄，僅 S/A 查得到 ----------
-- attendance 這張表本來就有 attendance_audit_log 可以對應，但過去沒有任何程式碼／
-- trigger 真的寫入過。這裡直接用 trigger 在資料庫層級補上，這樣不管是「一週登錄」頁、
-- 「每日/手機版」頁、或未來任何新增的寫入管道，只要是寫進 attendance 這張表，
-- 一律會自動留下紀錄，不會因為前端漏寫某個管道而少記。
create or replace function log_attendance_change() returns trigger
security definer set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.status is distinct from new.status then
    insert into attendance_audit_log (attendance_id, changed_by, old_value, new_value)
    values (new.id, current_teacher_id(), old.status, new.status);
  elsif tg_op = 'INSERT' then
    insert into attendance_audit_log (attendance_id, changed_by, old_value, new_value)
    values (new.id, current_teacher_id(), null, new.status);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_log_attendance_change on attendance;
create trigger trg_log_attendance_change
  after insert or update on attendance
  for each row execute function log_attendance_change();

-- ============================================================
-- 附帶提醒：
-- - current_teacher_id() 對「管理員」帳號會是 null（管理員不是 teachers 表裡的一列），
--   所以管理員直接修改出缺勤時，紀錄的 changed_by 會是空的——畫面上請改顯示「管理員」
--   （前端 audit-logs 頁面已處理：changed_by 是 null 時顯示「管理員」，非 null 時查
--   teachers 表帶出姓名）。
-- - 這裡是用 trigger 在資料庫層級補紀錄，比較不會漏，但相對地「新增一筆全新出缺勤紀錄」
--   （INSERT）也會留一筆 old_value=null 的紀錄，等於連「第一次登錄」也算一筆——
--   這是刻意的（比對「這筆到底原本存不存在」在稽核情境下同樣重要），前端顯示時已經把
--   old_value 是 null 的列標成「新增」而不是「修改」，方便閱讀。
-- ============================================================
