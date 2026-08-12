# 校務行政系統 — 上架 Vercel 準備度分析

> 基於目前上傳的專案內容（Next.js 14 App Router + Supabase）逐一檢查後整理。

## 一、優點（有利於部署到 Vercel 的地方）

1. **框架與平台原生契合**：Next.js 14 App Router 是 Vercel 自家框架，`next build` 免額外設定即可部署，`app/api/*` 路由會自動變成 Serverless Functions。
2. **沒有需要常駐檔案系統的程式碼**：專案內沒有任何 `fs.writeFileSync`／本機檔案寫入，所有「檔案」都是動態產生後直接回傳（Excel／PDF／DOCX 匯出）或存進 Supabase Storage，跟 Vercel 的無狀態、隨時可能換機器執行的 Serverless 環境相容。
3. **排程機制已經是 Vercel 原生方案**：`vercel.json` 已設定 Vercel Cron 呼叫 `/api/cron/daily-backup`，並用 `CRON_SECRET` 驗證，不依賴額外的排程服務。
4. **敏感金鑰已正確分層**：`SUPABASE_SERVICE_ROLE_KEY`（可繞過 RLS 的最高權限金鑰）只出現在 `lib/supabaseAdmin.ts`，且只被 `app/api/*`（伺服器端路由）使用；前端一律走 `lib/supabaseClient.ts` 的 anon key + RLS。這個切分是對的，部署時不會不小心把高權限金鑰洩漏到瀏覽器端。
5. **有 `package-lock.json`**：安裝結果可重現，Vercel build 不會因為套件版本飄移而跟本機結果不一致。
6. **資料庫遷移腳本齊全且可重複執行**：27 個 `sql/*.sql` 依編號跑一次即可建出完整最新結構，交接文件也說明得很清楚。

## 二、需要注意／建議改善的地方

### 🔴 高優先（建議部署前處理）

1. **`.env.example` 內疑似混入真實密鑰**
   檔案最後一行沒有任何欄位名稱、獨立出現一段字串（`u1ENmJqUQF0G0OwN3KGC1ad9X8hom5Ze`），但檔案開頭註解寫著「這個檔案本身不含真實密鑰，可以放心提交進版本控制」。這段字串很像是不小心貼進去的真實金鑰片段（例如 `CRON_SECRET` 或某組 key 的殘留）。
   **建議**：確認這段字串的來源；如果它曾經是任何一組真實金鑰（尤其是否曾經當作 `SUPABASE_SERVICE_ROLE_KEY` 或 `CRON_SECRET` 使用過），推送到 GitHub 前先刪除這行，並到 Supabase 後台重新產生一組新的 service role key、`CRON_SECRET` 也重新產生一組。**不要假設「反正是 example 檔案就沒事」**，一旦推上公開或半公開的 GitHub repo，任何看過那次 commit 歷史的人都能看到。

2. **專案內完全沒有 `.gitignore`**
   目前找不到任何一份 `.gitignore`。如果直接 `git init` + push，`node_modules/`、`.next/`、`tsconfig.tsbuildinfo`、以及本機測試用的 `.env.local`（如果之後有建立）都可能被一起提交進版本控制——`.env.local` 一旦外流，等同洩漏 Supabase service role key。
   **建議**：部署前先建立最基本的 `.gitignore`：
   ```
   node_modules/
   .next/
   .env.local
   .env*.local
   *.tsbuildinfo
   ```

### 🟡 中優先（不影響能否上架，但建議一併處理）

3. **`next.config.mjs` 裡的 `allowedDevOrigins` 是本機開發設定**
   `['192.168.1.11', 'localhost:3000']` 是為了讓區網內另一台電腦連線測試用的，正式環境下這個設定不會造成問題（Vercel 會用自己的網域），但也不會有任何作用，屬於「跟目前檔案沒有直接關係、留著也無妨」的本機遺留設定，可以视情況清理。

4. **`CRON_SECRET` 沒設定時的行為已經處理妥當**，但要記得部署前一定要到 Vercel 專案設定裡把 4 個環境變數都加上（見下方步驟），漏加 `CRON_SECRET` 只會讓每日自動備份失效（回傳 500），不會擋住其他功能，但會在不知不覺中失去自動備份保護，建議上線後找一天實際檢查 `backups` 資料表有沒有出現「自動」類型的紀錄。

5. **前端登入守門是 client-side 檢查**（`app/(app)/layout.tsx` 用 `supabase.auth.getSession()` 判斷要不要導回登入頁）。這代表畫面上的功能清單/連結不會給未登入的人看到，但**真正的資料安全防線是 Supabase RLS**，不是這層檢查——這是文件裡已經寫明的設計決定，不是漏洞，但值得在上架前**逐一確認 27 個 SQL 檔案的 RLS policy 都已經在正式 Supabase 專案跑過**，因為如果漏跑任何一個政策相關的 SQL，畫面雖然正常，資料還是可能被越權存取。

### 🟢 低優先（觀察即可，暫不影響上架）

6. `xlsx`、`@react-pdf/renderer`、`pdf-lib`、`docx` 這幾個套件都不小，會拉長 Serverless Function 的冷啟動時間，尤其是同時用到好幾個的匯出功能（例如「批次列印成績單」）。目前規模下應該還在 Vercel 的執行時間限制內，但學校規模變大、單次匯出資料量變多時，建議留意對應 API route 的執行時間，必要時把耗時的匯出改成非同步／背景工作。
7. `public/fonts/` 裡的兩個中文字型檔（合計約 2MB）會被打包進部署產物，這是預期內的正常大小，不是問題，只是提醒之後如果要新增更多字型／靜態資源，注意 Vercel 對單一部署大小的限制（Hobby/Pro 方案略有不同）。

## 三、上架 Vercel 步驟

### 步驟 1：整理 Git 儲存庫
1. 在專案根目錄新增第二節提到的 `.gitignore`。
2. 確認、必要時移除 `.env.example` 裡疑似洩漏的那段字串。
3. `git init`（如果還沒有）→ `git add .` → `git commit` → 推送到 GitHub（Vercel 目前主要支援 GitHub / GitLab / Bitbucket 匯入）。

### 步驟 2：準備正式環境的 Supabase 專案
1. 在 Supabase 後台建立正式環境要用的專案（如果還沒有獨立的正式環境，建議跟開發/測試用的專案分開）。
2. 依序執行 `sql/1schema.sql` 到 `sql/39site_content_settings_assets.sql`（依檔名數字順序，不要跳著執行、也不要合併），交接文件裡已確認這 27＋檔案本身就是最精簡可靠的安裝流程。
3. 到 Supabase 後台「Storage」建立程式碼裡用到的兩個 bucket：`site-assets`（背景音樂／公佈欄縮圖等）、`student-documents`（學生歸檔文件），並設定對應的存取政策。
4. 記下這個專案的 `Project URL`、`anon public key`、`service_role key`（下一步會用到）。

### 步驟 3：在 Vercel 建立專案
1. 到 [vercel.com](https://vercel.com) → New Project → 選擇剛推上 GitHub 的這個 repo。
2. Framework Preset 應該會自動偵測為 Next.js，不用手動改。
3. 在「Environment Variables」畫面加入 4 組變數（對照 `.env.example` 的說明）：
   | 變數名稱 | 值 | 備註 |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | 前端會用到，公開沒關係 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key | 前端會用到，公開沒關係 |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | ⚠️ 極機密，只能設在這裡，絕對不要加 `NEXT_PUBLIC_` 前綴 |
   | `CRON_SECRET` | 自訂一組長亂數字串 | 用密碼產生器產生 32 碼即可，跟每日自動備份的驗證有關 |
4. 按下 Deploy，等待 build 完成。

### 步驟 4：部署後檢查
1. 打開 Vercel 給的網址，確認首頁公佈欄、登入流程都正常。
2. 用系統管理員S帳號登入，逐一點過管理後台六大分類，確認 RLS 政策都生效（一般角色帳號看不到不該看的功能/資料）。
3. 到 Vercel 專案的「Cron Jobs」分頁確認 `/api/cron/daily-backup` 已經被排程（對應 `vercel.json` 的 `0 18 * * *`，也就是每天 UTC 18:00）；隔天檢查 Supabase `backups` 資料表是否出現一筆「自動」類型的紀錄，確認金鑰設定正確、排程真的有跑起來。
4. 到 `/admin/dev-tools` 手動按一次「立即備份」，確認備份/還原功能在正式環境一樣正常。
5. 確認自訂網域（如果學校要用自己的網域，例如 `admin.your-school.edu.tw`）：Vercel 專案設定 → Domains 加入，並依指示到網域註冊商設定 DNS。

### 步驟 5：上線後的持續事項
- 定期（例如每學期初）檢查一次 Supabase 專案的資料庫用量／Vercel 的用量，確認沒有超過方案額度。
- 每次要新增 SQL 遷移檔案時，記得依編號延續（下一個是 `sql/40...`），並在正式環境依序執行。
- 金鑰如果之後真的需要更換（例如懷疑外流），記得同時到 Supabase 後台重新產生、Vercel 環境變數更新，兩邊要同步，否則會出現「金鑰對不上」導致整個系統無法連線的狀況。
