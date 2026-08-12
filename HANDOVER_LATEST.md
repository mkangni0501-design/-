# 校務行政系統 2.0 交接文件（最新版）

> 這份文件取代 `README.md` 跟 `IMPLEMENTATION_NOTES.md` 裡跟現況不符的部分——
> 那兩份文件在多次修正後已經有些地方跟實際程式碼對不起來（例如還寫著「三大分類」
> 「整批下載/上傳只剩兩張表」），之後如果要看「現在系統長怎樣」，請以這份為準；
> 那兩份留著當歷史脈絡參考就好，不用刪除。

## 一、專案結構速覽

- `app/(app)/` — 需要登入才能看的頁面（管理後台、出缺勤、通知…），共用
  `app/(app)/layout.tsx`（登入守門）＋ `components/TopNav.tsx`（返回上頁／切換身分／登出）。
- `app/page.tsx` — 首頁（未登入），三張身分卡片＋公佈欄。
- `app/portal/` — 家長／學生查詢入口，登入代碼＋信箱驗證信機制，跟教職員帳號分開。
- `lib/` — 資料存取與商業邏輯；`components/` — UI 元件；`sql/` — 依編號循序執行的資料庫遷移。

## 二、SQL 安裝順序

目前總共 **27 個檔案**，全部都已經在正式環境執行過。往後不管是「增量升級」還是
「整個系統重製、資料庫全新重裝」，都是**依數字順序把 `sql/1schema.sql` 到
`sql/27bulletin_board.sql` 全部重新執行一次**，不需要、也不建議合併或刪減：

- 後面的檔案本來就是設計成「疊在前面版本上直接修正」（多半用
  `drop policy if exists ...; create policy ...` 或
  `create or replace function ...` 這種可重複執行的寫法），在全新的空白資料庫上
  依序整個跑一次，結果會等於「早期版本的錯誤已經被後面的檔案修正過」，
  不會殘留中間過程的錯誤版本。也就是說，**現在這 27 個檔案本身就是最精簡可靠的
  安裝流程，重新安裝跟目前累積升級用的是同一組檔案**，不需要另外整理一份「精簡版」。
- 已知的修正關係（僅供理解脈絡，不需要手動處理）：
  - `12period_config_fix.sql` 修正 `1schema.sql` 的節次設定 bug
  - `15scores_write_permission_fix.sql` 修正 `2policies.sql` 的成績寫入權限
  - `21ranking_lock_granularity_fix.sql` 修正 `10exam_type_rankings.sql` 的排名鎖定粒度
  - `22department_policy_rewrite_complete.sql` 把 `19department_rbac_refactor.sql`
    導入部門制之後，其餘各檔案裡角色判斷（`admin_a`/`admin_b`）的政策逐一改寫成部門判斷
  - `26fix_department_recursion_and_module_visibility.sql` 修正 `19` 的
    `app_user_departments` 政策無限遞迴，並擴充 `11module_categories.sql` 的分類欄位限制
- 若之後真的要為了教學/交接方便整理一份「新裝一次到位」的精簡腳本，建議由**熟悉全部
  27 個檔案最終狀態的開發人員**重新逐表核對「最終欄位/政策長怎樣」後手動整理，
  不要用自動化工具直接串接，避免遺漏中間修正過的地方。

## 三、資料表總覽（依 SQL 檔案出現順序）

app_users・students・teachers・classes・enrollments・curriculum・class_schedule・
period_config・scores・attendance・conduct_events・student_remarks・grading_rules・
score_adjustments・attendance_audit_log・score_audit_log・submission_windows・
correction_requests・guardians・portal_accounts・student_status_changes・
status_change_attachments・grade_progression・conduct_point_defaults・
attendance_alert_settings・attendance_notifications・staff_notifications・
exam_type_rankings（view）・admin_module_categories・period_config_fix（同一張表的欄位修正）・
scheduler_backups・account_audit_log・app_user_departments・pending_changes・
governed_tables・academic_terms・substitute_assignments・locked_periods・
common_subject_locks・general_inventory_items・general_inventory_transactions・
maintenance_tickets・utility_bills・**app_user_module_overrides**（本輪新增）・
**bulletin_posts**（本輪新增）

## 四、本輪（本次對話）處理的項目

### 1. 部門職務儲存失敗：`infinite recursion detected in policy for relation "app_user_departments"`
根因：`19department_rbac_refactor.sql` 的 `read_own_or_department_lead` 政策用子查詢
查詢「自己這張表」，Postgres 檢查子查詢時又要套用同一條政策，形成無窮迴圈；
`has_department()`／`is_department_lead()` 也因為沒下 `security definer`，
被任何其他表的政策呼叫到都會連帶炸開。**已在 `sql/26fix_department_recursion_and_module_visibility.sql`
修正**（改用 `security definer` 函式繞過遞迴）。

### 2. 直接打 `/admin`（含大小寫變化）不登入也能看到畫面
根因：`app/(app)/layout.tsx` 原本完全沒做登入檢查。**已加上登入守門**：沒有 session
就導回登入頁，不會再顯示任何功能清單/連結。（真正的資料安全底線仍然是 Supabase RLS，
這一層只解決「畫面不該被看到」。）

### 3. 管理後台六大分類＋帳號個別可見內容
- `lib/adminModules.ts` 從「教務／訓導／總務」三區擴充成
  「教務／訓導／總務／教師／家長學生／開發人員」六區。
- **一個功能現在可以同時掛在多個分類底下**（例如「成績相關設定及查詢」同時掛在
  教務／教師兩區），管理者S在「修正分類」畫面用勾選框決定每個功能要出現在哪幾區
  （改成勾選框、不是拖曳，避免多分類跟拖曳單一目標互相矛盾）。
- 新增 `app_user_module_overrides` 資料表：系統管理員S可以在「帳號管理」頁的
  「帳號可見內容（個別調整）」區塊，針對單一帳號多開放或藏起特定功能，
  不影響其他同角色/同部門的人。

### 4. 每一頁「返回上頁」＋「切換身分」
`components/TopNav.tsx`（所有 `(app)` 路由共用同一個外層，改一處就全站生效）：
- 新增「← 返回上頁」按鈕（`router.back()`）。
- 具管理帳號（system_admin_s／admin_a／admin_b）的人，原本「回首頁」改成
  「切換身分 ▾」下拉選單，可直接切換「管理者視角／教師視角」不用登出重登；
  一般教師帳號（只有一種身分）維持原本的「回首頁」連結。

### 5. 首頁公佈欄
新增 `bulletin_posts` 資料表（`sql/27bulletin_board.sql`），已發布的文章開放給
**未登入**的人也讀得到（首頁本來就在登入之前）。`/admin/bulletin` 提供管理者
新增/編輯/發布/刪除公告；首頁三張登入卡片上方會顯示最新一篇的縮圖，
縮圖下方列出其餘4篇的標題，點擊可以展開內文。

### 6. 「一鍵下載的資料大量缺失、一鍵上傳失敗」
**找到根因**：開發人員區「下載完整資料快照」按鈕，原本呼叫的
`buildDeveloperSetupSheets()` 其實是設計給「全新學校第一次建檔」用的
**空白範本產生器**（除了帳號名單，其餘7張工作表都只有2列示範資料，
完全不是從資料庫查出來的現況），卻被包進標榜「完整資料快照」的下載檔案裡，
難怪打開來看幾乎全是空的；重新上傳這種本來就是空的範本，自然也不會有實際資料被匯入。

**已修正**：新增 `lib/currentDataSheets.ts`，針對帳號名單、班級與導師設定、
科目與比重設定、任課教師設定、學校課表、節次設定、整體佔比與加扣分規則、
既有學生快速建檔 這8張表，全部改成**真的查詢資料庫目前現況**，
`components/dev-tools/BulkExcelPanel.tsx` 的「下載完整資料快照」已改用這組新函式。
帳號名單重新上傳時，同一信箱已存在的帳號會被系統自動判斷為「已存在、略過」，
不會報錯或產生重複帳號（這部分原本就有做好，不用擔心）。

**已知限制／建議下一步**：
- 「科目與比重設定」目前現況查詢，是把資料庫裡「每個年級每個科目各自的比重/節數」
  重新拼回範本那種「年級當欄位」的寬表格式；如果同一份比重節數底下，同一個年級
  同時對到兩個以上不同科目，程式會自動多開一列避免互相覆蓋，但欄位數量較多、
  情境較複雜，建議正式導入前找一個班級實際下載→上傳跑一次確認結果符合預期。
- 「成績、出缺輸入表」（每班每學期持續登錄用）本來就**不包含**在這個一鍵下載/上傳
  範圍內（這是原本程式碼註解就寫明的設計決定，因為每班每學期都要重新登錄，
  不適合當作一次性建檔資料），這部分請繼續用「成績登錄」「出缺勤登錄」等專屬頁面操作。
- `lib/backupRestore.ts`（「開發人員區」另一個「備份與還原」JSON快照功能，跟上面
  Excel這組是不同機制）原本漏掉了 `app_user_departments`、`conduct_events`、
  `pending_changes`、`governed_tables`、`profile_edit_requests`、
  `attendance_notifications`、`staff_notifications`、`admin_module_categories`
  這幾張表，這次也一併補上。**這組 JSON 備份/還原只適合「同一個 Supabase 專案」的
  災難復原**（因為 `app_user_departments` 等表的外鍵指向 `app_users`，而
  `app_users` 本身刻意不備份），**不能拿一份備份搬去全新的 Supabase 專案重建**；
  真要整個搬家到新專案，請用上面這組 Excel 匯出/匯入，或請開發人員協助搬移
  `auth.users`／`app_users`。

## 五、目前已知、尚未處理的缺口

- 家長／學生登入是獨立的「登入代碼＋信箱驗證信」機制，跟教職員的 Email＋密碼
  登入完全分開；管理後台的「家長／學生」分類目前只放了「建立家長/學生登入帳號」
  「學生歸檔文件查詢」這類**管理者操作的功能**，並不是把家長/學生自己會用到的
  查詢頁面搬進管理後台——這兩者是不同的使用情境，如果之後有「想讓管理後台
  也能直接預覽家長/學生看到的畫面」這種需求，需要另外討論設計。
- `docs/` 資料夾原本沒有規劃書（兩份 `.docx` 是後來才附上傳的），部分 SQL 檔案
  裡的欄位設計（例如 `academic_terms`）是依現有系統慣例推斷出的最小可行版本，
  不是對照正式規格文件寫的，正式欄位需求請對照規劃書或跟提出需求的人確認。
