-- ============================================================
-- 69. 教職員身分切換新增【家長視角】：信箱跟監護人資料相同時可切換
-- ------------------------------------------------------------
-- 反映事項：「當【家長／監護人資料】中信箱跟教師/管理者信箱相同時，切換身分處請
-- 多一個【家長視角】選單」——例如某老師同時也是本校在籍學生的家長，登記在
-- guardians.email 的信箱剛好跟他自己教職員帳號的登入信箱（auth.users.email）
-- 相同時，讓他不用另外登出、改用家長入口(login_code)登入，直接在教職員畫面
-- 「切換身分」多一個選項，切過去就能看到自己小孩的資料。
--
-- 家長查詢入口（portal_accounts）是完全獨立的另一套帳號機制（sql/6portal.sql），
-- 用 login_code + email 綁定、第一次登入驗證成功才會填入 auth_user_id。這裡不用
-- 額外做整套 OTP 登入流程——因為教職員本人已經用同一個信箱登入過一次（現在這個
-- session 本身就是身分證明），只要 portal_accounts 裡有一筆 email 相同、
-- auth_user_id 還沒填的紀錄，直接把它「認領」成同一個 auth_user_id 即可，
-- 不用再走一次寄信驗證。
-- ============================================================

-- ---------- 1. 判斷「現在登入的教職員」信箱是不是也登記在監護人資料裡 ----------
-- 只回傳 true/false，不外洩任何監護人或學生的細節，前端只用這個來決定
-- 「切換身分」要不要多顯示【家長視角】這個選項。
create or replace function current_staff_has_guardian_email_match()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from guardians g
    join auth.users u on lower(u.email) = lower(g.email)
    where u.id = auth.uid()
      and g.email is not null
      and g.email <> ''
  );
$$;

-- ---------- 2. 認領跟自己信箱相同、還沒綁定的家長查詢帳號 ----------
-- 找 portal_accounts 裡 email 跟現在這個教職員登入信箱相同、auth_user_id 還是
-- null 的那幾筆（一個人可能是不只一個小孩的家長/監護人），直接填入自己的
-- auth_user_id，等於用教職員帳號本身的登入驗證取代原本的 OTP 驗證信步驟。
-- 回傳認領到的筆數，前端認領完就導去 /portal，/portal 本來的查詢邏輯
-- （portal_accounts.auth_user_id = 目前登入者）完全不用改，自然就看得到了。
create or replace function claim_portal_accounts_for_current_staff()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer;
  my_email text;
begin
  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then
    return 0;
  end if;

  update portal_accounts
  set auth_user_id = auth.uid()
  where auth_user_id is null
    and lower(email) = lower(my_email);

  get diagnostics claimed_count = row_count;
  return claimed_count;
end;
$$;

notify pgrst, 'reload schema';
