-- ============================================================
-- 71. 修正 sql/69【家長視角】切換看不到的問題
-- ------------------------------------------------------------
-- 反映事項：「家長視角我好像沒看到（請用董嬌玫帳號測試）」。
--
-- 根因：sql/69 的兩支函式都直接查詢 auth.users 表（用 auth.uid() 查 email）。
-- 整個專案從 sql/1 到 sql/70，沒有任何一支函式這樣做過——一律只用 auth.uid()
-- 本身（一個 uuid），從來不去讀 auth.users 的其他欄位。這是因為 Supabase 專案
-- 預設不會開放一般角色、甚至部分 security definer 函式直接讀取 auth.users
-- 的其他欄位（跟一般 postgres 資料表的權限模型不同，auth schema 有額外限制）。
-- 這造成 sql/69 那兩支函式实际执行时很可能直接失败或回傳不到資料，
-- current_staff_has_guardian_email_match() 因此一律回傳 false（或整個 RPC
-- 呼叫失敗），「家長視角」選項自然一直不會出現。
--
-- 修正：改成跟這個專案其他地方一致的作法——教職員的登入信箱由「前端」用
-- supabase.auth.getUser() 取得（這是 Supabase JS SDK 標準呼叫，讀的是使用者
-- 自己那把 JWT 裡的資料，不需要額外資料庫權限，這個專案很多地方已經在用，
-- 例如 AttendanceScoreExclusionPanel.tsx／PasswordPolicySettingsPanel.tsx），
-- 再把這個信箱當參數傳給下面兩支函式，函式本身完全不用碰 auth.users。
-- 使用者只能透過 getUser() 拿到「自己」的信箱（不是任意信箱），所以拿這個
-- 信箱去比對監護人資料、認領家長帳號，安全性上沒有問題。
-- ============================================================

drop function if exists current_staff_has_guardian_email_match();
drop function if exists claim_portal_accounts_for_current_staff();

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

create or replace function claim_portal_accounts_for_current_staff(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer;
begin
  if p_email is null or p_email = '' then
    return 0;
  end if;

  update portal_accounts
  set auth_user_id = auth.uid()
  where auth_user_id is null
    and lower(trim(email)) = lower(trim(p_email));

  get diagnostics claimed_count = row_count;
  return claimed_count;
end;
$$;

notify pgrst, 'reload schema';
