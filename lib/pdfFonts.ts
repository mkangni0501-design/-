import path from 'path';
import { Font } from '@react-pdf/renderer';

/**
 * 中文字型注册（給所有用 @react-pdf/renderer 產生的 PDF 共用：成績單、聘書/證明信）。
 *
 * 這裡要修正兩個問題：
 * 1. 原本 lib/ReportCardDocument.tsx 完全沒有註冊字型（只有註解說「示意版型結構」），
 *    react-pdf 內建字型不含中文字，所以除了數字（ASCII）以外全部印出來是亂碼/空白方框。
 * 2. lib/TeacherLetterPdfDocuments.tsx 雖然有嘗試註冊，但寫的是瀏覽器用的網址路徑
 *    寫法 `/fonts/NotoSansTC-Regular.woff2`——這支程式是在 Next.js API route（伺服器端
 *    Node.js）執行，不是瀏覽器，`/fonts/...` 這種開頭斜線的字串在 Node.js 裡會被當成
 *    「檔案系統絕對路徑」直接去讀，也就是去讀機器上真的存在的 `/fonts/...`（檔案系統
 *    根目錄），不是專案裡的 `public/fonts/...`，一般部署環境根本没有這個路徑，字型檔
 *    讀不到，一樣會印出亂碼——這裡要改成用 `process.cwd()` 組出正確的專案內絕對路徑。
 *
 * 另外字型檔案本身也從 .woff2 換成 .ttf（從 Google Fonts 官方 Noto Sans TC 可變字重字型
 * 抽出 400/700 兩個固定字重，用 fonttools 處理過），因為 @react-pdf/renderer 底層的
 * fontkit 對 woff2 格式的相容性比較不穩定，.ttf 是最有把握能正常運作的格式（已經實際
 * 產生過 PDF 並且用 pypdf 反向擷取文字驗證中文字是正確嵌入、不是亂碼）。
 *
 * 呼叫方式：每個要輸出中文 PDF 的 Document 元件檔案，在模組最上層呼叫一次
 * `registerNotoSansTC()`（重複呼叫沒有副作用，react-pdf 內部會處理重複註冊）。
 */
let registered = false;

export function registerNotoSansTC() {
  if (registered) return;
  registered = true;
  const fontsDir = path.join(process.cwd(), 'public', 'fonts');
  Font.register({
    family: 'NotoSansTC',
    fonts: [
      { src: path.join(fontsDir, 'NotoSansTC-Regular.ttf'), fontWeight: 400 },
      { src: path.join(fontsDir, 'NotoSansTC-Bold.ttf'), fontWeight: 700 },
    ],
  });
  // react-pdf 預設會嘗試連字（ligature）跟字距微調計算，中文字型不需要、反而偶爾會拖慢
  // 排版速度，關掉沒有副作用。
  Font.registerHyphenationCallback((word) => [word]);
}
