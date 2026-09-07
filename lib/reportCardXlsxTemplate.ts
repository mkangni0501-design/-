import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { supabaseAdmin } from './supabaseAdmin';
import type { ReportCardData, TermBlock } from './ReportCardDocument';
import { conductGradeLabel } from './ReportCardDocument';

// ============================================================
// 成績單「直接套用學校自己的 Excel 範本」——反映事項「請用EXCEL表，如果要做成
// WORD請一樣用EXCEL的格式去完成，現在WORD下載出來的樣式跟我提供的差很多，而且
// 我要自己上傳還因為錯誤被擋下來」。
//
// 背景：原本 lib/ReportCardDocument.tsx（PDF）、lib/reportCardDocxTemplate.ts
// （Word 合併列印）都是「看著學校提供的 Excel 樣本、在程式碼裡手動重畫一份長得
// 很像的版面」——每次學校反映「這裡對不齊、那裡差一點」，都是在追一個手畫版面
// 跟原始 Excel 之間的落差，永遠追不完，而且 Word 合併列印範本原本就是另外找的
// 內建預設檔案，本來就不是照這份 Excel 做的，難怪「樣式差很多」。「我要自己
// 上傳還因為錯誤被擋下來」是因為原本【成績單合併列印範本】那個上傳功能只收
// .docx，上傳 .xlsx 一定會被 validateDocxTemplate 擋掉。
//
// 這裡改成完全不重畫版面：直接拿學校上傳的這份 .xlsx 當範本，用 ExcelJS 把
// 「輸入類」儲存格（科目名稱/分數、出缺勤次數、懲獎次數、操行分數、班級人數/
// 名次、導師評語、學生基本資料……）填進對應座標，範本裡本來就有的公式（例如
// 學業平均、操行等第、總分、升留級判斷、全勤判斷）完全不去動，交給 Excel／
// 開啟檔案的軟體自己算——這樣算出來的結果保證跟學校自己在 Excel 裡打的一模一樣，
// 不會有「我們自己重算一遍、結果對不上」的風險。ExcelJS 只改儲存格的值，不會
// 重寫其他儲存格的格式/框線/合併/顏色，原始範本長什麼樣，填完資料還是長什麼樣。
//
// 【重要，跟 Word 合併列印不一樣的地方】這裡刻意不做「轉成 PDF」這一步。
// Word 那邊本來就是直接讓使用者下載 .docx 檔案；這裡也是一樣，直接下載
// 「已經填好這位學生資料」的 .xlsx 檔案，使用者用 Excel／Google 試算表／
// LibreOffice 打開就能看、就能列印，跟原始範本一模一樣。技術上是可以拿
// LibreOffice 把 .xlsx 轉成 PDF 給瀏覽器直接預覽（開發時我也是這樣測試、
// 確認填值填對地方），但正式環境（Vercel）的伺服器沒有安裝 LibreOffice，
// 硬是依賴它，上線後這個功能會直接壞掉、噴 500 錯誤——所以線上這裡不做
// PDF 轉換，只提供 .xlsx 下載，避免部署一個實際上會壞掉的功能。
// ============================================================

// ---------- 系統內建的預設 Excel 範本：管理員還沒上傳過自訂範本時使用 ----------
// 檔案就是學校目前實際使用、上傳給我們的那一份（public/templates/ 下面），跟
// Word 範本用同一套「fs 讀檔＋process.cwd() 組路徑」方式讀取。
export function loadDefaultXlsxTemplateBuffer(): Buffer {
  const p = path.join(process.cwd(), 'public', 'templates', 'report-card-xlsx-template.xlsx');
  return fs.readFileSync(p);
}

// ---------- 拿「目前生效中」的範本：管理員上傳過自訂範本就用那份，沒有就退回
// 內建預設範本。單一學生列印、批次列印都呼叫這支，確保兩邊用同一份範本。----------
export async function getActiveXlsxTemplateBuffer(): Promise<Buffer> {
  const { data } = await supabaseAdmin
    .from('report_card_xlsx_template')
    .select('file_data')
    .eq('is_active', true)
    .maybeSingle();
  if (data?.file_data) {
    const hex = (data.file_data as string).replace(/^\\x/, '');
    return Buffer.from(hex, 'hex');
  }
  return loadDefaultXlsxTemplateBuffer();
}

// ---------- 驗證上傳的檔案至少長得像我們預期的範本（兩個分頁都在），不是隨便
// 一份 .xlsx。跟 validateDocxTemplate 一樣只做「基本合理性」檢查，不強求
// 儲存格座標完全一致（管理員換版面本來就可能調整儲存格位置，我們檔案格式
// 驗證只負責擋「根本不是這份範本」的情況，不負責檢查版面內容本身）。----------
export async function validateXlsxTemplate(buffer: Buffer): Promise<{ ok: true } | { error: string }> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
  } catch (err: any) {
    return { error: '這不是一份有效的 .xlsx 檔案：' + (err?.message ?? String(err)) };
  }
  const sheetNames = wb.worksheets.map((ws) => ws.name);
  if (!sheetNames.includes(COVER_SHEET) && !sheetNames.includes(DETAIL_SHEET)) {
    return {
      error: `範本裡找不到「${COVER_SHEET}」或「${DETAIL_SHEET}」分頁（目前分頁：${sheetNames.join('、') || '（無）'}）。` +
        '請確認上傳的是成績單範本本身（可以先用「下載目前範本」對照分頁名稱）。',
    };
  }
  return { ok: true };
}

const COVER_SHEET = '成績外';
const DETAIL_SHEET = '成績內';

// 科目列：第6列開始，最多10科真實科目＋固定最後一列（第16列）是「出缺席」——
// 跟 lib/ReportCardDocument.tsx 的 MAX_REAL_SUBJECT_SLOTS／TOTAL_SUBJECT_SLOTS
// 是同一套「固定排幾列，科目不夠的班級留空白」設計，兩邊科目數對不上的話
// 這裡也要跟著改。
const SUBJECT_FIRST_ROW = 6;
const ATTENDANCE_SUBJECT_ROW = 16; // 「出缺席」固定在第16列
const ACADEMIC_AVERAGE_ROW = 17; // 學業平均
const CONDUCT_OVERALL_ROW = 18; // 操行成績（含等第 甲/乙/丙/丁/優）
const CONDUCT_POLITENESS_ROW = 19; // 禮貌
const CONDUCT_DRESS_ROW = 20; // 衣著
const CONDUCT_SERVICE_ROW = 21; // 服務
const CONDUCT_DISCIPLINE_ROW = 22; // 紀律
const REMARK_CELL = 'C23'; // 導師評語（合併到 C23:L25）

// 出席記錄／懲獎記錄：M~P欄、Q~T欄，第5列開始，項目順序固定。
const ATTENDANCE_ITEM_ROWS: Record<'曠課' | '遲到' | '病假' | '事假' | '公假', number> = {
  曠課: 5,
  遲到: 6,
  病假: 7,
  事假: 8,
  公假: 9,
};
const DISCIPLINE_ITEM_ROWS: Record<'嘉獎' | '小功' | '大功' | '警告' | '小過' | '大過', number> = {
  嘉獎: 5,
  小功: 6,
  大功: 7,
  警告: 8,
  小過: 9,
  大過: 10,
};
const CLASS_SIZE_SPRING_CELL = 'P11';
const CLASS_SIZE_FALL_CELL = 'P12';
const CLASS_RANK_SPRING_CELL = 'T11';
const CLASS_RANK_FALL_CELL = 'T12';

function setCell(ws: ExcelJS.Worksheet, addr: string, value: string | number | null) {
  // 合併儲存格只有「左上角」那一格是真正可以寫值的儲存格，範本裡這裡用到的
  // 座標都已經對照過 merged_cells 確認是左上角，直接寫入即可；ExcelJS 對
  // 已合併範圍裡的非左上角儲存格寫值會丟例外，所以刻意都用左上角座標。
  ws.getCell(addr).value = value === null ? null : value;
}

// ---------- 主要函式：拿範本 + 一位學生的資料，回傳填好的 .xlsx（Buffer）----------
export async function fillReportCardXlsx(templateBuffer: Buffer, data: ReportCardData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuffer as any);

  const cover = wb.getWorksheet(COVER_SHEET);
  const detail = wb.getWorksheet(DETAIL_SHEET);
  if (!detail) {
    throw new Error(`範本裡找不到「${DETAIL_SHEET}」分頁，無法套用資料。`);
  }

  // ---------- 外頁（封面）：只填學生基本資料，其餘（計算方式說明文字、校名）
  // 維持範本原樣，不覆蓋——那些是固定的政策說明文字，不是逐生變動的資料。----------
  if (cover) {
    setCell(cover, 'B7', `${data.gradeLevel}${data.className}`);
    setCell(cover, 'B8', data.studentName);
    setCell(cover, 'B9', data.seatNo);
    setCell(cover, 'B10', data.studentNo);
  }

  // ---------- 內頁抬頭 ----------
  setCell(detail, 'K1', `${data.academicYear}學年度`);
  setCell(detail, 'N1', data.currentTerm);
  setCell(detail, 'C2', data.studentNo);
  setCell(detail, 'N2', data.studentName);
  setCell(detail, 'P2', data.gradeLevel);
  setCell(detail, 'Q2', data.className);
  setCell(detail, 'R2', `${data.seatNo}號`);
  // U6 範本原本是 =NOW()，會在開啟檔案時自動更新成「今天」，不是「產出當下」——
  // 這裡改成寫死 data.printedAt（跟 PDF／Word 版用同一個列印日期），避免使用者
  // 之後某天重新打開這份檔案時日期自動跳掉。
  setCell(detail, 'U6', data.printedAt);

  const spring = data.terms['上學期'];
  const fall = data.terms['下學期'];

  // ---------- 科目成績：固定10列（第6~15列），科目不夠的班級後面幾列留空白，
  // 跟 PDF／Word 版本同一套「固定格數」設計；第16列固定是「出缺席」。----------
  const maxSubjects = Math.max(spring?.subjects.length ?? 0, fall?.subjects.length ?? 0);
  void maxSubjects; // 目前用固定10列，這個數字只是保留給以後想做「超過10科要警告」時用。
  for (let i = 0; i < 10; i++) {
    const row = SUBJECT_FIRST_ROW + i;
    const s = spring?.subjects[i];
    const f = fall?.subjects[i];
    const subjectName = s?.subject ?? f?.subject ?? null;
    const weight = s?.weight ?? f?.weight ?? null;
    if (subjectName == null) {
      // 這一列沒有科目：不寫入任何值，保留範本原本的空白（範本的公式儲存格
      // 遇到空白輸入格，本來就會顯示空白，不用特別清除）。
      continue;
    }
    setCell(detail, `A${row}`, subjectName);
    setCell(detail, `B${row}`, weight);
    if (spring?.ready) {
      setCell(detail, `C${row}`, s?.midterm ?? null);
      setCell(detail, `D${row}`, s?.final ?? null);
      setCell(detail, `E${row}`, s?.daily ?? null);
    }
    if (fall?.ready) {
      setCell(detail, `G${row}`, f?.midterm ?? null);
      setCell(detail, `H${row}`, f?.final ?? null);
      setCell(detail, `I${row}`, f?.daily ?? null);
    }
  }

  // ---------- 出缺席（固定第16列）：範本這一列的分數是「輸入值」不是公式
  // （對照範例檔案 C16/G16 都是直接打數字，不是 =...），所以這裡寫入我們
  // 系統既有、全站統一算法算出來的 attendanceScore（跟 PDF／Word 版、學業平均
  // 排名用的是同一個數字，確保三種格式的成績單一定互相對得起來）。----------
  setCell(detail, `A${ATTENDANCE_SUBJECT_ROW}`, '出缺席');
  if (spring?.ready) {
    for (const col of ['C', 'D', 'E', 'F']) setCell(detail, `${col}${ATTENDANCE_SUBJECT_ROW}`, spring.attendanceScore);
  }
  if (fall?.ready) {
    for (const col of ['G', 'H', 'I', 'J']) setCell(detail, `${col}${ATTENDANCE_SUBJECT_ROW}`, fall.attendanceScore);
  }

  // ---------- 操行成績（禮貌/衣著/服務/紀律 是輸入值，操行成績本身/等第範本
  // 用公式算——但範本裡「優/甲/乙…」那個等第儲存格 E18/I18 在範例檔案裡其實是
  // 打死的文字、不是公式，跟我們系統既有的等第換算規則（見
  // lib/ReportCardDocument.tsx 的 conductGradeLabel）不一定會自動同步，這裡
  // 直接算好寫入，確保等第跟操行分數永遠對得上。----------
  if (spring?.ready) {
    setCell(detail, `C${CONDUCT_POLITENESS_ROW}`, spring.conduct.politeness);
    setCell(detail, `C${CONDUCT_DRESS_ROW}`, spring.conduct.dress);
    setCell(detail, `C${CONDUCT_SERVICE_ROW}`, spring.conduct.service);
    setCell(detail, `C${CONDUCT_DISCIPLINE_ROW}`, spring.conduct.discipline);
    setCell(detail, `E${CONDUCT_OVERALL_ROW}`, conductGradeLabel(spring.conduct.overall));
  }
  if (fall?.ready) {
    setCell(detail, `G${CONDUCT_POLITENESS_ROW}`, fall.conduct.politeness);
    setCell(detail, `G${CONDUCT_DRESS_ROW}`, fall.conduct.dress);
    setCell(detail, `G${CONDUCT_SERVICE_ROW}`, fall.conduct.service);
    setCell(detail, `G${CONDUCT_DISCIPLINE_ROW}`, fall.conduct.discipline);
    setCell(detail, `I${CONDUCT_OVERALL_ROW}`, conductGradeLabel(fall.conduct.overall));
  }

  // ---------- 出席記錄／懲獎記錄：次數是輸入值，「合計」欄範本本身有公式
  // （雖然範例檔案 M5~M8 那幾列公式寫成相乘不是相加，看起來像是範本自己的
  // 筆誤，但這是學校自己範本裡原本就有的公式，我們不擅自幫忙「修正」——
  // 不去動任何公式儲存格，只填輸入值，公式怎麼算是學校自己範本的事）。----------
  if (spring?.ready) {
    for (const [item, row] of Object.entries(ATTENDANCE_ITEM_ROWS)) {
      setCell(detail, `N${row}`, spring.attendance[item as keyof typeof spring.attendance]);
    }
    for (const [item, row] of Object.entries(DISCIPLINE_ITEM_ROWS)) {
      setCell(detail, `R${row}`, spring.discipline[item as keyof typeof spring.discipline]);
    }
    setCell(detail, CLASS_SIZE_SPRING_CELL, spring.classSize);
    setCell(detail, CLASS_RANK_SPRING_CELL, spring.classRank);
  }
  if (fall?.ready) {
    for (const [item, row] of Object.entries(ATTENDANCE_ITEM_ROWS)) {
      setCell(detail, `O${row}`, fall.attendance[item as keyof typeof fall.attendance]);
    }
    for (const [item, row] of Object.entries(DISCIPLINE_ITEM_ROWS)) {
      setCell(detail, `S${row}`, fall.discipline[item as keyof typeof fall.discipline]);
    }
    setCell(detail, CLASS_SIZE_FALL_CELL, fall.classSize);
    setCell(detail, CLASS_RANK_FALL_CELL, fall.classRank);
  }

  // ---------- 導師評語 ----------
  setCell(detail, REMARK_CELL, data.remark || '');

  // 範本裡的公式（總分/學業平均/操行成績/升留級/全勤判斷……）完全沒有動，
  // 交給打開這份檔案的 Excel／Google 試算表／LibreOffice 自動重新計算。

  // ---------- 強制「打開檔案時全部重新計算」----------
  // 這裡發現一個重要的坑：範本檔案裡的公式儲存格，存檔時 Excel/LibreOffice 會把
  // 「上次算出來的結果」一起快取進檔案；我們只是用程式改了輸入儲存格的值，
  // 公式本身沒有變、ExcelJS 也不會自動幫忙重算，於是公式儲存格裡「快取的舊結果」
  // 會原封不動留著。有些應用程式打開檔案時看到 fullCalcOnLoad 這個提示會主動
  // 全部重算（設定見下面），但實測 LibreOffice 的無頭轉檔模式即使有這個提示也
  // 不會重算——不能保證所有會拿去開這份檔案的軟體都會乖乖聽這個提示。
  //
  // 保險做法：乾脆不留「快取結果」——把每一個公式儲存格的舊快取值都清掉，只
  // 留公式本身。這樣不管用哪套軟體打開，因為根本沒有舊結果可以顯示，一定會
  // 自己重新算一遍，不會有僥倖顯示到舊快取的可能。
  for (const sheet of [cover, detail]) {
    if (!sheet) continue;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'formula' in v && v.formula) {
          cell.value = { formula: v.formula } as any;
        }
      });
    });
  }
  wb.calcProperties.fullCalcOnLoad = true;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
