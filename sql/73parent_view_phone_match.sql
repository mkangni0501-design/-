-- ============================================================
-- 73. 【家長視角】改成信箱、手機號碼都可以比對（跟家長/學生登入頁一致）
-- ------------------------------------------------------------
-- 反映事項：「家長/學生登入那邊現在只能用手機，沒辦法用信箱，是不是因為這樣
-- 所以就算手機是董嬌玫的，也抓不到這個學生？那這樣是不是要改成可以用手機或
-- 信箱登入（只要學籍系統那邊有填寫就好）」。
--
-- 查證：家長/學生查詢入口從 2026-08-28 那一輪起，登入方式已經整個改成
-- 「登入代碼＋手機號碼」（app/api/portal/request-login/route.ts），不再用
-- 信箱驗證信這條路——手機號碼直接比對 guardians.phone／students.phone，這是
-- 學籍資料本來就會維護的欄位。上一輪（sql/69~72）幫【家長視角】做的比對只查了
-- guardians.email，但學校現在很可能已經沒有持續在維護 guardians.email 這個欄位
-- 了（登入本身用不到），這才是董嬌玫比對不到的真正原因——不是信箱比對本身有
-- bug，是「只比對信箱」這件事本身跟現在系統實際運作的方式（手機為主）不一致。
--
-- 這裡不去動家長/學生登入頁本身（那邊改成手機是刻意的設計決定，見上面連結的
-- 檔案裡的說明：不用維護額外的登入信箱、資料來源單一），只把【家長視角】這個
-- 教職員專用的切換功能，比照登入頁「手機」這個實際會用到的欄位，補上手機比對，
-- 信箱、手機任一個對得上就算數，兩者都用學籍系統本來就有在維護的欄位，不需要
-- 額外的建檔動作。手機正規化的規則（拿掉國碼／開頭0、比對邏輯）跟
-- app/api/portal/request-login/route.ts 的 canonicalPhone()／phonesMatch()
-- 完全一致，只是從 TypeScript 搬成 SQL。
-- ============================================================

-- ---------- 手機正規化（跟 route.ts 的 canonicalPhone 逐步對應，避免用複雜的
-- 單一正則表達式猜錯邊界情況） ----------
create or replace function canonical_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  d := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  if left(d, 2) = '66' and length(d) > 9 then
    d := substring(d from 3);
  end if;
  if left(d, 1) = '0' then
    d := substring(d from 2);
  end if;
  return d;
end;
$$;

create or replace function phones_match(a text, b text)
returns boolean
language sql
immutable
as $$
  select
    length(canonical_phone(a)) >= 8
    and length(canonical_phone(b)) >= 8
    and canonical_phone(a) = canonical_phone(b);
$$;

-- ---------- 判斷：信箱或手機，任一個對得上監護人資料就算 ----------
create or replace function current_staff_has_guardian_email_match(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from guardians g
    where lower(trim(g.email)) = lower(trim(p_email))
      and g.email is not null
      and trim(g.email) <> ''
      and p_email is not null
      and trim(p_email) <> ''
  );
$$;

-- 手機比對用另一支獨立的函式（跟信箱那支分開），前端點【家長視角】時，信箱先
-- 自動試、沒有比對到才會另外跳出來問手機號碼——這支就是問到手機號碼之後用的。
create or replace function guardian_phone_match_exists(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from guardians g where phones_match(g.phone, p_phone)
    union all
    select 1 from students s where phones_match(s.phone, p_phone)
  );
$$;

-- ---------- 認領／補建家長查詢帳號：信箱、手機都補上對應版本 ----------
create or replace function claim_portal_accounts_for_current_staff(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer := 0;
  step_count integer;
  g record;
  v_login_code text;
begin
  if p_email is null or trim(p_email) = '' then
    return 0;
  end if;

  update portal_accounts
  set auth_user_id = auth.uid()
  where auth_user_id is null
    and lower(trim(email)) = lower(trim(p_email));
  get diagnostics step_count = row_count;
  claimed_count := claimed_count + step_count;

  for g in
    select distinct student_no
    from guardians
    where lower(trim(email)) = lower(trim(p_email))
      and email is not null
      and trim(email) <> ''
  loop
    v_login_code := 'HY' || g.student_no;
    if not exists (select 1 from portal_accounts where login_code = v_login_code) then
      insert into portal_accounts (student_no, login_code, email, relation, auth_user_id, created_by)
      values (g.student_no, v_login_code, p_email, '家長', auth.uid(), auth.uid());
      claimed_count := claimed_count + 1;
    end if;
  end loop;

  return claimed_count;
end;
$$;

-- 【本輪新增】手機版的認領/補建——邏輯跟上面信箱版一致，差別只在比對欄位換成
-- phones_match()；家長查詢帳號本身的 email 欄位是 not null，這裡找不到監護人
-- 登記的信箱時，用 p_phone 組一個看得出來源的佔位字串（不是真的信箱、也不會被
-- 拿去登入或寄信），避免 insert 失敗。
create or replace function claim_portal_accounts_for_current_staff_by_phone(p_phone text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer := 0;
  g record;
  v_login_code text;
  v_email text;
begin
  if p_phone is null or trim(p_phone) = '' or length(canonical_phone(p_phone)) < 8 then
    return 0;
  end if;

  for g in
    select distinct gu.student_no, gu.email
    from guardians gu
    where phones_match(gu.phone, p_phone)
  loop
    v_login_code := 'HY' || g.student_no;
    if exists (select 1 from portal_accounts where login_code = v_login_code and auth_user_id is null) then
      update portal_accounts set auth_user_id = auth.uid() where login_code = v_login_code and auth_user_id is null;
      claimed_count := claimed_count + 1;
    elsif not exists (select 1 from portal_accounts where login_code = v_login_code) then
      v_email := coalesce(nullif(trim(g.email), ''), v_login_code || '@phone-verified.internal');
      insert into portal_accounts (student_no, login_code, email, relation, auth_user_id, created_by)
      values (g.student_no, v_login_code, v_email, '家長', auth.uid(), auth.uid());
      claimed_count := claimed_count + 1;
    end if;
  end loop;

  return claimed_count;
end;
$$;

notify pgrst, 'reload schema';
