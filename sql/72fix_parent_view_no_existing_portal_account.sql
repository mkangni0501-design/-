-- ============================================================
-- 72. 修正【家長視角】「還沒有綁定任何學生資料」的問題
-- ------------------------------------------------------------
-- 反映事項：「董嬌玫使用家長視角，出現『目前這個帳號還沒有綁定任何學生資料』」。
--
-- 根因：sql/71 的 claim_portal_accounts_for_current_staff() 只會去「認領」
-- portal_accounts 裡「已經存在、但還沒綁定登入帳號」的那幾筆——如果這個監護人
-- 從來沒有被學校在【學生管理】>【家長查詢帳號】那個管理頁面產生過帳號，
-- portal_accounts 裡根本沒有對應的那一筆，就沒有東西可以「認領」，
-- /portal 查到 0 筆自然顯示「還沒有綁定任何學生資料」——這不是信箱比對錯誤，
-- 是這個監護人原本就還沒有家長查詢帳號可以綁。
--
-- 修正：這支函式除了原本「認領既有帳號」，再加一步——這個信箱如果真的登記在
-- 【家長／監護人資料】(guardians.email) 裡、但對應的學生「完全沒有」任何家長
-- 查詢帳號時，直接補建一筆（登入代碼照系統既有慣例「HY」+學號，見
-- sql/6portal.sql 的欄位註解），並直接綁定成教職員本人這次登入——教職員本人
-- 已經通過學校帳密登入這件事本身就是身分證明，不用再走一次寄信驗證信的流程。
-- 如果那個學號已經有別人（例如另一位監護人）登記的家長查詢帳號，這裡不會動它
-- （保留原樣，不搶別人的帳號），這種情況要看到資料就要請學校改用那個既有帳號、
-- 或請學校確認要不要把 guardians 資料改成董嬌玫的信箱。
-- ============================================================

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

  -- 步驟1：認領「已經存在、但還沒綁定登入帳號」的家長查詢帳號（跟 sql/71 一樣）。
  update portal_accounts
  set auth_user_id = auth.uid()
  where auth_user_id is null
    and lower(trim(email)) = lower(trim(p_email));
  get diagnostics step_count = row_count;
  claimed_count := claimed_count + step_count;

  -- 步驟2：這個信箱登記在【家長／監護人資料】裡，但對應的學生完全沒有任何
  -- 家長查詢帳號（不管是誰的）時，直接補建一筆、直接綁定成自己。
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

notify pgrst, 'reload schema';
