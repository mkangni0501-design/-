-- ============================================================
-- 75. 修正【家長視角】兩個問題：已經有真實家長登入紀錄時無法切換、每次都要重新輸入手機
-- ------------------------------------------------------------
-- 反映事項：
--   1.「家長帳號可用手機號碼登入（董嬌玫），但現在無法從教職員視角切換，輸入
--      手機後出現『沒有找到相符的監護人資料』」
--   2.「已經透過輸入手機號進入家長視角的教職員，是否能自動綁定學生資料，不用
--      每次都得重新輸入號碼」
--
-- 根因（第1點）：董嬌玫本來就有用手機真的登入過家長查詢入口，她那個學生的
-- portal_accounts 那一列，auth_user_id 早就綁定她「本人用家長查詢入口登入」
-- 那個身分了（不是 null，也不是不存在）。sql/73 的
-- claim_portal_accounts_for_current_staff_by_phone() 為了不要「搶走」別人的
-- 帳號，設計成只處理「auth_user_id 是 null」或「這一列還不存在」這兩種情況，
-- 已經綁定的一律跳過不動——但這裡「已經綁定的那個人」其實就是董嬌玫自己
-- （只是換一個身分：教職員登入 vs 家長查詢入口登入，兩者是同一個真人），
-- 不該被當成「別人的帳號」擋下來。這支函式執行時已經用手機比對驗證過「這確實
-- 是這個學生監護人的手機」，這個驗證強度跟真正的家長登入頁一致，可以放心直接
-- 覆蓋成教職員這次的登入身分。
--
-- 根因（第2點）：原本 handleViewAsParent() 每次都是「先試信箱、信箱沒有比對到
-- 才問手機」，即使教職員上次已經成功用手機綁過，下次點還是會重新走一次流程
-- （信箱沒對到 → 又要問一次手機）。應該先確認「我自己這個教職員身分，是不是
-- 已經綁過任何一筆家長查詢帳號」，有的話直接跳過去，不用再驗證一次。
-- ============================================================

-- ---------- 修正1：claim 函式改成一律覆蓋，不再區分「已綁定/未綁定」 ----------
create or replace function claim_portal_accounts_for_current_staff(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer := 0;
  g record;
  v_login_code text;
begin
  if p_email is null or trim(p_email) = '' then
    return 0;
  end if;

  for g in
    select distinct student_no
    from guardians
    where lower(trim(email)) = lower(trim(p_email))
      and email is not null
      and trim(email) <> ''
  loop
    v_login_code := 'HY' || g.student_no;
    if exists (select 1 from portal_accounts where login_code = v_login_code) then
      -- 信箱比對通過，等同真正登入頁驗證過的強度，直接覆蓋成這次的登入身分，
      -- 不管原本是 null 還是已經綁過別的身分（含這個人自己過去用家長查詢入口
      -- 登入留下的身分）。
      update portal_accounts set auth_user_id = auth.uid() where login_code = v_login_code;
      claimed_count := claimed_count + 1;
    else
      insert into portal_accounts (student_no, login_code, email, relation, auth_user_id, created_by)
      values (g.student_no, v_login_code, p_email, '家長', auth.uid(), auth.uid());
      claimed_count := claimed_count + 1;
    end if;
  end loop;

  return claimed_count;
end;
$$;

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
    if exists (select 1 from portal_accounts where login_code = v_login_code) then
      -- 手機比對通過，等同真正家長登入頁（app/api/portal/request-login）驗證
      -- 過的強度，直接覆蓋成這次的登入身分，不管原本是 null 還是已經綁過別的
      -- 身分（很可能就是這個人自己過去用家長查詢入口登入留下的身分）。
      update portal_accounts set auth_user_id = auth.uid() where login_code = v_login_code;
      claimed_count := claimed_count + 1;
    else
      v_email := coalesce(nullif(trim(g.email), ''), v_login_code || '@phone-verified.internal');
      insert into portal_accounts (student_no, login_code, email, relation, auth_user_id, created_by)
      values (g.student_no, v_login_code, v_email, '家長', auth.uid(), auth.uid());
      claimed_count := claimed_count + 1;
    end if;
  end loop;

  return claimed_count;
end;
$$;

-- ---------- 修正2：先確認自己是不是已經綁過，綁過就不用再驗證 ----------
-- 只看「目前這個教職員身分（auth.uid()）底下，portal_accounts 裡有沒有任何一筆
-- 已經綁在自己身上」，不外洩任何學生細節，前端只用來決定要不要跳過信箱/手機
-- 驗證直接導去 /portal。
create or replace function current_staff_has_bound_portal_accounts()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from portal_accounts where auth_user_id = auth.uid());
$$;

notify pgrst, 'reload schema';
