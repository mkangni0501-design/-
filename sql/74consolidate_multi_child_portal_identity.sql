-- ============================================================
-- 74. 一次性整併：家裡好幾個小孩的家長，過去登入已經分裂成好幾個不同身分的資料
-- ------------------------------------------------------------
-- 反映事項：「家裡有好幾個小孩在本校就讀的教職員/家長，是否能同時查看所有小孩
-- 的資料？請確認並修復」。
--
-- 根因（見同一輪對 app/api/portal/request-login/route.ts 的修正）：家長/學生
-- 查詢入口的登入流程，原本每次都用「這次登入代碼本身」核發一個獨立的身分
-- （hy0123@portal.internal 這種影子信箱），同一位家長如果分別用不同小孩的
-- 代碼登入過，會拿到好幾個「不同」的身分——即使 /portal 頁面本來就有「同一個
-- 身分下所有綁定學生」的下拉切換功能，因為身分從一開始就沒有共用，這個功能
-- 一直只看得到一個小孩。程式碼那邊已經修正「以後」的登入會自動收斂成同一個
-- 身分，但「已經」因為這個舊行為分裂成好幾個身分的既有家庭，不會因為程式修好
-- 就自動合併回來，需要這裡補一次性的資料整併。
--
-- 做法：用監護人手機號碼（跟登入時同一套正規化規則，見 sql/73 的
-- canonical_phone()）把「同一支手機底下的所有學生」分成一組，同一組裡如果
-- 已經有不只一個 auth_user_id 被綁定過，全部改成同一個（挑「最早綁定」的那個
-- 當作大家共用的身分，比較符合家長「一開始用哪個小孩的代碼登入」的直覺）。
-- 只處理 relation='家長' 這種登入——學生本人是不同的真人，不合併。
-- ============================================================

with guardian_phone_groups as (
  select distinct g.student_no, canonical_phone(g.phone) as cphone
  from guardians g
  where g.phone is not null and length(canonical_phone(g.phone)) >= 8
),
bound as (
  select gpg.cphone, pa.id as portal_account_id, pa.auth_user_id, pa.created_at
  from guardian_phone_groups gpg
  join portal_accounts pa on pa.login_code = 'HY' || gpg.student_no
  where pa.auth_user_id is not null
    and pa.relation = '家長'
),
canonical as (
  select distinct on (cphone) cphone, auth_user_id as canonical_auth_user_id
  from bound
  order by cphone, created_at asc
)
update portal_accounts pa
set auth_user_id = c.canonical_auth_user_id
from bound b
join canonical c on c.cphone = b.cphone
where pa.id = b.portal_account_id
  and pa.auth_user_id is distinct from c.canonical_auth_user_id;

-- 這個 update 語句本身可以放心重複執行（就算沒有需要整併的資料，也只是
-- 0 rows affected），之後如果又有家庭反映同樣狀況，直接重跑這個檔案就可以。
