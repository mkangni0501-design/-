-- ============================================================
-- 64. 學籍資料修改申請：學生本人只能改自己的電話/地址，家長才能改監護人資料
-- ------------------------------------------------------------
-- app/(app)/portal/page.tsx 那邊已經把「可修改欄位」清單依登入身分（學生本人／
-- 家長）分開了，但 profile_edit_requests 的 insert RLS 政策
-- （parent_create_edit_request，見 sql/6portal.sql）原本只檢查「送出者是不是
-- 這個 portal_accounts 綁定本人」，完全沒管 relation、target_table、field_name，
-- 這代表這個限制目前只存在於前端畫面上——只要繞過畫面直接呼叫 API/插入資料，
-- 學生帳號一樣送得出監護人姓名/電話的修改申請。這裡把這條規則也搬進資料庫的
-- with check，跟前端限制做同一件事、兩層都擋。
-- ============================================================

drop policy if exists parent_create_edit_request on profile_edit_requests;
create policy parent_create_edit_request on profile_edit_requests
  for insert
  with check (
    exists (
      select 1 from portal_accounts pa
      where pa.id = profile_edit_requests.requested_by
        and pa.auth_user_id = auth.uid()
        and (
          -- 家長：本人（students）或監護人（guardians）欄位都可以申請修改。
          pa.relation = '家長'
          -- 學生本人：只能申請修改 students 表的 phone／address 這兩個欄位，
          -- 不能替監護人（guardians）送出修改申請。
          or (
            pa.relation = '學生本人'
            and profile_edit_requests.target_table = 'students'
            and profile_edit_requests.field_name in ('phone', 'address')
            and profile_edit_requests.guardian_id is null
          )
        )
    )
  );

notify pgrst, 'reload schema';
