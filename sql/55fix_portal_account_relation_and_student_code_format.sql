-- ============================================================
-- 2026-08-24 修正：portal_accounts.relation 可能存到錯誤的值 ＋
--                  學生本人登入代碼格式改成 HYS+學號（原本是 HY+學號+S）
-- ============================================================

-- ---------- 一、修正 relation 欄位可能存到的錯誤值 ----------
-- 根因：app/(app)/admin/students/portal-accounts/page.tsx 的「帶入{監護人}
-- 信箱」按鈕，原本除了帶入 email，還會用 setRelation(g.relation) 把「身分」
-- 下拉選單（合法值只有 '家長' / '學生本人' 兩種）的畫面值，直接覆蓋成
-- guardians 表裡的監護人關係（'父'/'母'/'監護人'…），這兩個欄位語意完全
-- 不同，誤用會把不對的值存進 portal_accounts.relation。
--
-- 這個 bug 具體會怎麼影響資料：由於 handleCreate 產生登入代碼的判斷式是
-- `relation === '學生本人' ? ... : 'HY'+學號`，relation 一旦被按鈕覆蓋成
-- '父'/'母'/'監護人' 這類字串（不等於'學生本人'），會落入 ELSE 分支，
-- 產生的 login_code 其實還是正確的「HY+學號」（家長格式）——換句話說，
-- 這個 bug 只弄壞了 relation 這個「身分標籤」欄位本身，login_code 沒有錯。
-- 但任何依賴 relation='學生本人' 判斷「這是學生自己的帳號」的地方
-- （例如社團選社頁只讓學生本人身分的登入者填志願序）都會找不到這筆帳號，
-- 對使用者來說就像是「明明有建立帳號，登入後卻找不到對應功能/資料」。
--
-- 修法：這類壞掉的 relation 幾乎可以肯定原本就是要建立「家長」帳號時，
-- 承辦人點了「帶入監護人信箱」按鈕誤觸——因為 guardians 表裡本來就不會有
-- 學生本人的資料，這顆按鈕原本只出現在協助建立家長帳號的情境，所以統一
-- 修正為 '家長'（login_code 因為前述原因已經是對的，不用跟著改）。
update portal_accounts
set relation = '家長'
where relation not in ('家長', '學生本人');

-- 加上檢查限制，避免以後再發生同樣的資料污染（例如日後其他頁面/腳本
-- 又不小心把 guardians.relation 之類的值寫進這個欄位，資料庫層會直接擋掉，
-- 不會等到某個依賴 relation 篩選的功能「看起來找不到資料」才發現）。
alter table portal_accounts drop constraint if exists portal_accounts_relation_check;
alter table portal_accounts add constraint portal_accounts_relation_check
  check (relation in ('家長', '學生本人'));

-- ---------- 二、學生本人登入代碼格式：字尾 S → 字首 HYS ----------
-- 原本學生本人代碼是 'HY' || 學號 || 'S'（例如 HY0140S），這輪改成
-- 'HYS' || 學號（例如 HYS0140）。把既有「relation='學生本人'」的帳號
-- 全部依學號重新產生成新格式，不用解析舊代碼字串（反正學號本身就在
-- student_no 欄位，直接重組即可）。
--
-- ⚠️ 這會讓已經发出去的舊代碼（HY...S 字尾）失效——不是只有第一次登入
-- 綁定時才需要輸入代碼，app/portal/login/page.tsx 的 handleRequestLink
-- 每次登入都要重新輸入代碼比對，所以已經領過舊代碼的學生，這批帳號更新
-- 後需要重新通知新代碼（HYS+學號），已經完成綁定（auth_user_id 已填入）
-- 的帳號不受影響、不用重新綁定，只是「代碼」本身要換新的告訴學生。
update portal_accounts
set login_code = 'HYS' || upper(student_no)
where relation = '學生本人';

comment on column portal_accounts.login_code is
  'HY+學號（家長，例如 HY0123）；HYS+學號（學生本人，例如 HYS0123）。兩種身分要用不同代碼，login_code 是 unique，同一個學生的家長帳號跟學生本人帳號不能共用同一組代碼，否則第二個會建立失敗。建立時由 app/(app)/admin/students/portal-accounts/page.tsx 自動產生。';
