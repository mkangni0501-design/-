-- ============================================================
-- 76. 修正【家長視角】「原本可以看到好幾個小孩，現在只剩一個」的回歸問題
-- ------------------------------------------------------------
-- 反映事項：「原本教職員可以看到自己的多個小孩，現在不可以了」。
--
-- 根因：sql/75 為了不要每次都重新問一次信箱/手機（反映事項2），改成
-- 「current_staff_has_bound_portal_accounts() 只要有任何一筆已經綁定，就直接
-- 跳過認領流程、直接導去 /portal」——但「認領流程」本來就是唯一會去找「這個
-- 人名下其他小孩」並且綁定的地方。只要有一個小孩曾經被綁定過，之後每次都會
-- 在還沒認領其他小孩之前就先跳掉，導致只有第一個被綁定的小孩看得到，其他小孩
-- （不管是本來就有、還是後來才新增的監護人資料）永遠不會再被認領。
--
-- 修正：「已經綁定過，不用再問信箱/手機」這件事本身沒有錯，錯的是「跳過去的
-- 同時，也跳過了幫其他小孩補認領」。改成：已經綁定過的時候，不用再跳出來問
-- 使用者任何東西，但背地裡用「已經綁定的那個小孩，監護人資料裡登記的手機／
-- 信箱」這個本來就存在、不需要使用者重新輸入的資料，去找看看還有沒有「同一支
-- 手機／同一個信箱」底下、還沒被認領的其他小孩，安靜地一併補上——完全不用
-- 使用者做任何額外動作。
-- ============================================================

create or replace function claim_sibling_portal_accounts_for_current_staff()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_count integer := 0;
  my_student_nos text[];
  my_phones text[];
  my_emails text[];
  g record;
  v_login_code text;
begin
  select array_agg(distinct student_no) into my_student_nos
  from portal_accounts
  where auth_user_id = auth.uid();

  if my_student_nos is null or array_length(my_student_nos, 1) = 0 then
    return 0;
  end if;

  select array_agg(distinct phone) into my_phones
  from guardians
  where student_no = any(my_student_nos) and phone is not null and trim(phone) <> '';

  select array_agg(distinct lower(trim(email))) into my_emails
  from guardians
  where student_no = any(my_student_nos) and email is not null and trim(email) <> '';

  for g in
    select distinct gu.student_no, gu.email
    from guardians gu
    where not (gu.student_no = any(my_student_nos))
      and (
        (my_phones is not null and gu.phone is not null and exists (
          select 1 from unnest(my_phones) mp where phones_match(gu.phone, mp)
        ))
        or
        (my_emails is not null and gu.email is not null and lower(trim(gu.email)) = any(my_emails))
      )
  loop
    v_login_code := 'HY' || g.student_no;
    if exists (select 1 from portal_accounts where login_code = v_login_code) then
      update portal_accounts set auth_user_id = auth.uid() where login_code = v_login_code;
      claimed_count := claimed_count + 1;
    else
      insert into portal_accounts (student_no, login_code, email, relation, auth_user_id, created_by)
      values (
        g.student_no,
        v_login_code,
        coalesce(nullif(trim(g.email), ''), v_login_code || '@phone-verified.internal'),
        '家長',
        auth.uid(),
        auth.uid()
      );
      claimed_count := claimed_count + 1;
    end if;
  end loop;

  return claimed_count;
end;
$$;

notify pgrst, 'reload schema';
