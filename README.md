# 學校成績系統 — 第一階段程式碼

對應《成績系統_模組規格文件》第一階段：帳號權限、學生班級資料、出缺勤登錄+鎖定、成績登錄+鎖定。

## 目錄結構

```
sql/
  schema.sql        -- 資料庫結構（角色、學生、班級、課程、登錄、稽核、鎖定）
  policies.sql       -- Row-Level Security 權限政策
  calculations.sql   -- 【第二階段】成績計算引擎（加權總分、排名，皆為 view）
  registration.sql   -- 【新生註冊模組】students擴充欄位、監護人、學籍狀態歷程、佐證附件
  portal.sql         -- 【家長/學生入口】帳號綁定、基本資料修改審核、收緊students/enrollments權限
  promotion.sql      -- 【升級/轉班】年級升級對照表、enrollments加入is_current標記
  conduct_defaults.sql -- 出缺勤/獎懲預設加扣分參考值（僅供參考，不影響總成績計算）
  module_categories.sql -- 【首頁改版】管理後台首頁「教務／訓導／總務」自訂分類（系統管理員S用拖曳調整的儲存表）
app/
  page.tsx                        -- 【首頁改版】校務行政系統首頁：管理者／教師／家長 三卡片選擇 → 依卡片身分登入
  (app)/layout.tsx                -- 頂部導覽列（回首頁／登出），套用在下面所有已登入頁面
  (app)/admin/layout.tsx          -- 【第五輪】非管理員擋在「系統設定」類頁面外（/admin、/admin/grading、/admin/registrar 例外，內部自己依角色決定顯示哪些分頁）
  (app)/admin/page.tsx            -- 【首頁改版】管理後台首頁：管理者視角＝教務／訓導／總務三區（系統管理員S可按「修正分類」拖曳調整）；教師卡片視角＝僅顯示教學相關攤平清單
  (app)/admin/scheduling/page.tsx -- 【排課系統整合】① 產生排課工具貼上格式 ② 內嵌/連結排課工具本體 ③ 排課完成匯出Excel後上傳，自動寫回班級/科目節數/課表
  (app)/admin/grading/page.tsx    -- 【本次整合】成績相關設定及查詢（6分頁：成績相關設定〔管理員限定〕/學生成績登錄/班級成績總表/班級成績結果與排名/全校排行榜/歷年成績查詢）
  (app)/admin/registrar/page.tsx  -- 【本次整合】學籍設定及查詢（7分頁：查詢學生〔全體教職員〕/新生登記/快速建檔/學籍狀態變更/學期中轉班/升級作業/年級升級對照表設定〔以上6項管理員限定〕）
  (app)/admin/accounts/page.tsx           -- 帳號管理（S管理A/B；A/B可自行新增同角色帳號）
  (app)/admin/school-timetable/page.tsx   -- 學校課表（讀取排課系統匯入的班級課表）
  (app)/admin/attendance-alert-settings/page.tsx -- 出缺席示警門檻設定
  (app)/admin/backups/page.tsx            -- 每日自動備份／手動備份／還原
  (app)/admin/bulk-import/page.tsx        -- 整批下載／上傳（現只剩「整體佔比與加扣分規則」「既有學生快速建檔」兩張工作表；班級/科目節數/任課教師/節次改由排課系統匯入）
  (app)/admin/teacher-accounts/page.tsx   -- 教師資料檢查／合併
  (app)/admin/students/portal-accounts/page.tsx -- 建立家長/學生登入帳號
  (app)/admin/students/documents/page.tsx -- 學生歸檔文件查詢
  (app)/attendance/weekly/page.tsx    -- 電腦版一週出缺勤表格（含鎖定顯示）
  (app)/attendance/mobile/page.tsx    -- 手機版每日出缺勤登錄
  (app)/attendance/report/page.tsx    -- 學生出席紀錄查詢
  (app)/attendance/subject-view/page.tsx -- 任課班級出席查詢
  (app)/reports/school-attendance/page.tsx -- 全校出缺席狀況總覽
  (app)/reports/attendance-unlock-requests/page.tsx -- 出缺勤鎖定開放申請審核
  (app)/reports/profile-requests/page.tsx -- 【家長入口】導師審核家長基本資料修改申請
  (app)/notifications/page.tsx        -- 通知
  (app)/portal/page.tsx               -- 【家長入口】家長/學生查詢儀表板
  portal/login/page.tsx               -- 【家長入口】家長/學生登入頁（登入代碼＋信箱驗證信綁定）
  api/admin/invite-user/route.ts               -- 帳號邀請API（伺服器端，含權限檢查）
  api/reports/report-card/[enrollmentId]/route.tsx -- 【第三階段】成績單PDF產出API
  api/portal/link-account/route.ts -- 【家長入口】驗證登入代碼+信箱並完成綁定
  api/portal/request-login/route.ts -- 【家長入口】驗證登入代碼+信箱配對後才寄出驗證信
  api/portal/approve-edit/route.ts -- 【家長入口】導師/管理員核准基本資料修改申請
components/
  TopNav.tsx             -- 頂部導覽列（回首頁／登出）
  ExcelUploadButton.tsx  -- 共用的Excel上傳按鈕元件（選檔→解析→顯示成功/失敗筆數）
  admin-tabs/            -- 【本次整合】原本的獨立頁面搬過來當「成績相關設定及查詢」「學籍設定及查詢」兩個新首頁的分頁內容，邏輯完全沒改，只是換了檔案位置：
    CurriculumSettingsTab.tsx / GradingRulesTab.tsx / ScoresEntryTab.tsx / ClassSummaryTab.tsx / ClassResultsTab.tsx / SchoolRankingsTab.tsx / HistoryTab.tsx
    StudentsSearchTab.tsx / StudentsNewTab.tsx / StudentsImportTab.tsx / StudentsStatusChangeTab.tsx / StudentsTransferTab.tsx / StudentsPromotionTab.tsx / GradeProgressionTab.tsx
lib/
  supabaseClient.ts      -- 前端用 Supabase 連線與角色輔助函式
  supabaseAdmin.ts       -- 僅伺服器端使用的 Supabase Admin 連線
  adminModules.ts        -- 【首頁改版】管理後台功能模組清單、預設分類、讀取／儲存自訂分類（Supabase）
  schedulerBridge.ts     -- 【排課系統整合】校務系統↔排課工具雙向轉換：既有資料轉貼上格式、排課工具匯出Excel解析回寫班級/科目節數/課表
  bulkHandlers.ts        -- Excel批次上傳的實際寫入邏輯（resolveClassId／resolveTeacherByName 等共用工具，排課系統匯入也重複使用這兩個）
  gradeMapping.ts        -- 年級↔部別對照、具體年級清單
  ReportCardDocument.tsx -- 【第三階段】成績單PDF版型元件
  scoreAttendanceSheetParser.ts -- 解析「成績、出缺輸入表」格式（表頭、學生名單、分數區塊、出缺勤日期欄位）
public/
  scheduler/scheduler-tool.html -- 【排課系統整合】排課工具本體（原始檔案上加了「學年度」分頁＋「帳號管理」導覽項，排課核心邏輯未更動；資料只存在瀏覽器記憶體，須自行「備份專案」下載JSON）
docs/
  操作流程_新學年到成績單.md -- 新學年建立 → 舊生升級 → 排課 → 列印課表 → 點名/登錄成績 → 列印成績單 的完整編號操作流程
  排課系統整合規劃.md       -- 當初評估排課演算法整合方式的草案（已被實際整合取代，保留作分析參考）
```
**重要：除了登入頁（`app/page.tsx`）和家長登入頁（`app/portal/login/page.tsx`），其餘所有頁面都搬進了 `app/(app)/` 這個資料夾**（例如 `app/(app)/admin/accounts/page.tsx`）。`(app)` 是 Next.js 的「路由群組」，網址不會多一層（還是 `/admin/accounts`），但這樣可以讓 `app/(app)/layout.tsx` 統一套用頂部導覽列（回首頁／登出），不用在20幾個頁面裡各自貼一次。同時把所有 `import ... from '../../../lib/...'` 這種相對路徑改成 `@/lib/...` 這種別名（`tsconfig.json` 已設定好），這樣以後不管檔案搬到多深的資料夾，import都不會斷掉。

## 建置步驟

1. **建立 Supabase 專案**（https://supabase.com），取得 Project URL 與 anon key。
2. 在 Supabase SQL Editor 依序執行 `sql/schema.sql`、`sql/policies.sql`、`sql/calculations.sql`、`sql/registration.sql`、`sql/promotion.sql`、`sql/portal.sql`、`sql/conduct_defaults.sql`。
   `registration.sql` 需要用到檔案儲存，請在 Supabase 後台 Storage 建立一個名為 `student-documents` 的 bucket（私有即可，不需公開），用來存放學籍狀態變更的佐證資料。
   `portal.sql` 的家長/學生登入**不需要額外申請 Google OAuth**，用的是 Supabase 內建的信箱驗證連結（Magic Link），預設就會用，不用去 Google Cloud Console 申請任何東西。
3. 在專案根目錄建立 `.env.local`：
   ```
   NEXT_PUBLIC_SUPABASE_URL=你的 Supabase Project URL
   NEXT_PUBLIC_SUPABASE_ANON_KEY=你的 anon key
   SUPABASE_SERVICE_ROLE_KEY=你的 service_role key（Supabase後台 Settings > API 可找到，切記不能外流）
   ```
4. **建立第一個「系統管理員S」帳號**：這個角色不能透過網頁的邀請功能建立（避免誤設超過1位），
   請在 Supabase 後台的 Authentication 頁面手動新增一位使用者，再到 SQL Editor 執行：
   ```sql
   insert into app_users (id, name, role)
   values ('剛剛新增的使用者UUID', '你的姓名', 'system_admin_s');
   ```
   之後這位帳號登入後，就能在「帳號管理」頁面邀請 系統管理員A / 管理員B。
5. 安裝套件並啟動開發伺服器：
   ```
   npm install
   npm run dev
   ```
6. 部署到 Vercel：將專案推上 GitHub，於 Vercel 匯入該倉庫，並在 Vercel 專案設定中加入同樣的環境變數。


7. 每天自動備份 / 還原備份**：
   - 新增 `backups` 資料表（`sql/backups.sql`），只存校務資料（學生、班級、課表、成績、出缺勤...等），**刻意不包含帳號本身**（`app_users`/`portal_accounts`，因為這兩張表跟 Supabase Auth 的登入帳號綁在一起，整批還原可能造成無法登入）。
   - `admin/backups` 頁面：手動「立即備份」、下載 JSON、還原（**限系統管理員S本人**，需輸入「確定還原」四個字確認）。
   - 自動每日備份靠 `vercel.json` 的 Vercel Cron 排程呼叫 `api/cron/daily-backup`，用環境變數 `CRON_SECRET` 驗證（**部署前請在 Vercel 專案設定新增這個環境變數**，隨便一組長亂數字串即可）。若不是部署在 Vercel，需要改用你的平台對應的排程機制呼叫同一支 API，並帶上一樣的 `Authorization: Bearer <CRON_SECRET>`。
   - **已知限制**：備份內容直接存成 `backups.tables` 這個 jsonb 欄位，學校規模很大、資料量很多時可能會遇到單一 row 過大的問題，屆時建議改成存到 Supabase Storage 的檔案而不是資料庫欄位；還原是「先刪全部、再整批插入」，還原途中若中斷，資料表可能會處於「已清空但還沒插入完成」的中間狀態，建議還原前後都再手動用「立即備份」留一份存檔。

**執行順序建議**：`schema.sql` → `policies.sql` → （其餘既有的選擇性 SQL）→ `sql/phase4_updates.sql` → `sql/backups.sql`。

## 角色說明

| 角色 | 說明 |
|---|---|
| system_admin_s | 最高權限，系統限制僅能有1筆有效帳號 |
| admin_a | 審核任課教師的修正申請；可自行新增同角色帳號 |
| admin_b | 設定開放時間/鎖定、基礎資料；可自行新增同角色帳號 |
| homeroom_teacher | 導師，對自己班級可直接修正 |
| subject_teacher | 任課教師，僅能操作課表指定的班級/節次/科目 |
