import fs from 'fs';
import path from 'path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { ReportCardData, TermBlock } from './ReportCardDocument';
import { supabaseAdmin } from './supabaseAdmin';

// ------------------------------------------------------------------
// 成績單「合併列印（Word）」：這支檔案是唯一負責「把 ReportCardData 轉成
// 合併欄位（merge tag）」跟「拿 Word 範本 + 合併欄位資料算出最終 .docx」的地方。
//
// 為什麼另外做這一套、不共用 lib/ReportCardDocument.tsx？
// - ReportCardDocument.tsx 是 react-pdf「畫出成績單」的程式碼，版面、顏色、字級都
//   寫死在程式邏輯裡，管理員要改版面得改 ReportCardStyleTab.tsx 能調的那幾項，
//   或請工程師改程式碼。
// - 這裡改用「Word 合併列印」：管理員自己準備一份 .docx 範本（可以照抄使用者提供的
//   「成績單正反.xlsx」版面重做成 Word），版面上想放哪些欄、要用什麼字體/顏色/表格
//   樣式、要不要印校徽，全部在 Word 裡自己排版——範本裡只要放「合併欄位」
//   （例如 {{姓名}}、{{科目名稱}}）當佔位符，系統會在產生成績單時把這些佔位符換成
//   真正的資料。管理員可以在【成績單合併列印範本】頁下載目前範本、在 Word 裡修改、
//   再上傳回來取代，不用動到任何程式碼——這就是「讓我上傳提供樣本修改」這個需求。
//
// 合併欄位（tag）的完整清單、每個欄位代表什麼，請看下面 buildReportCardMergeContext()
// 這支函式的程式邏輯（每個欄位都有中文註解），或是到【成績單合併列印範本】頁面看
// 「可用合併欄位對照表」。
// ------------------------------------------------------------------

const TAG_DELIMITERS = { start: '{{', end: '}}' };

// ---------- 數字格式化：跟 lib/ReportCardDocument.tsx 用同一套規則，兩邊（PDF／
// Word合併列印）印出來的分數格式才會一致（整數就印整數，不然印到小數點後兩位；
// 沒有資料印「－」）。----------
function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined) return '－';
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '－';
  return `${n % 1 === 0 ? n : n.toFixed(1)}%`;
}
function fmtSigned(n: number | null | undefined): string {
  if (n === null || n === undefined) return '－';
  return n > 0 ? `+${fmtScore(n)}` : fmtScore(n);
}

// 操行等第（優/甲/乙/丙/丁）：跟 lib/ReportCardDocument.tsx 的 conductGradeLabel()
// 用同一套級距（90以上優、80-89甲、70-79乙、60-69丙、未滿60丁），這裡照抄一份，
// 是因為原本那支函式沒有 export，兩邊都只有十行內的小邏輯，直接照抄比特地改
// 別的檔案的 export 範圍更不容易牽動到 PDF 那邊的行為。
function conductGradeLabel(score: number | null): string {
  if (score === null) return '';
  if (score >= 90) return '優';
  if (score >= 80) return '甲';
  if (score >= 70) return '乙';
  if (score >= 60) return '丙';
  return '丁';
}

export type ReportCardMergeContext = Record<string, string | ReportCardMergeContext[]>;

// ---------- 把 ReportCardData 攤平成 Word 範本可以用的合併欄位 ----------
// 每一個 return 物件的 key，就是範本裡 {{這個名字}} 要打的合併欄位名稱。
export function buildReportCardMergeContext(data: ReportCardData): ReportCardMergeContext {
  const s1 = data.terms.上學期;
  const s2 = data.terms.下學期;

  // ---- 科目清單：把上/下學期同一個科目合併成同一列，再加上「出缺席」「學業平均」
  // 兩個特殊列（跟成績單正反.xlsx樣本一樣，這兩列外觀上跟科目列排在同一個表格裡）----
  const subjectNames: string[] = [];
  [s1, s2].forEach((term) => {
    term?.subjects.forEach((row) => {
      if (!subjectNames.includes(row.subject)) subjectNames.push(row.subject);
    });
  });

  function findSubject(term: TermBlock | null, subject: string) {
    return term?.subjects.find((r) => r.subject === subject) ?? null;
  }

  const 科目 = subjectNames.map((subject) => {
    const r1 = findSubject(s1, subject);
    const r2 = findSubject(s2, subject);
    return {
      科目名稱: subject,
      比重: r1?.weight != null ? fmtPct(r1.weight * 100) : r2?.weight != null ? fmtPct(r2.weight * 100) : '－',
      上期中: fmtScore(r1?.midterm ?? null),
      上期末: fmtScore(r1?.final ?? null),
      上平時: fmtScore(r1?.daily ?? null),
      上總分: fmtScore(r1?.total ?? null),
      下期中: fmtScore(r2?.midterm ?? null),
      下期末: fmtScore(r2?.final ?? null),
      下平時: fmtScore(r2?.daily ?? null),
      下總分: fmtScore(r2?.total ?? null),
      全年平均:
        r1?.total != null && r2?.total != null
          ? fmtScore((r1.total + r2.total) / 2)
          : fmtScore(r1?.total ?? r2?.total ?? null),
    };
  });

  // ---- 學業平均：【2026-08-27 修正】原本是放在「科目」迴圈陣列最後多加一筆的
  // 「隱藏列」，範本裡看不到獨立對應的合併欄位，管理員在 Word 裡不容易確認這一列
  // 到底有沒有正確算出來、也容易誤會成要自己另外手動加一列（那一列當然就會是空的、
  // 「沒有公式」）。改成獨立、每個欄位都有自己名字的合併欄位（不是迴圈），
  // 範本裡可以直接看到 {{學業平均上總分}} 這種清楚對應的標籤，跟其他科目列一樣
  // 是系統算好、直接套進去的數字（依各科比重加權平均，見 lib/reportCard.ts 的
  // academicAverage 計算邏輯），不是要在 Word 裡自己打公式。----
  const 學業平均全年平均 =
    s1?.academicAverage.total != null && s2?.academicAverage.total != null
      ? fmtScore((s1.academicAverage.total + s2.academicAverage.total) / 2)
      : fmtScore(s1?.academicAverage.total ?? s2?.academicAverage.total ?? null);


  // ---- 出席記錄（曠課/遲到/病假/事假/公假），上下學期各自次數＋合計 ----
  const ATT_ITEMS: (keyof TermBlock['attendance'])[] = ['曠課', '遲到', '病假', '事假', '公假'];
  const 出席記錄 = ATT_ITEMS.map((item) => {
    const n1 = s1?.attendance[item] ?? null;
    const n2 = s2?.attendance[item] ?? null;
    return {
      項目: item,
      上學期數: n1 == null ? '－' : String(n1),
      下學期數: n2 == null ? '－' : String(n2),
      合計: n1 == null && n2 == null ? '－' : String((n1 ?? 0) + (n2 ?? 0)),
    };
  });

  // ---- 懲獎記錄（嘉獎/小功/大功/警告/小過/大過），同上 ----
  const DISC_ITEMS: (keyof TermBlock['discipline'])[] = ['嘉獎', '小功', '大功', '警告', '小過', '大過'];
  const 懲獎記錄 = DISC_ITEMS.map((item) => {
    const n1 = s1?.discipline[item] ?? null;
    const n2 = s2?.discipline[item] ?? null;
    return {
      項目: item,
      上學期數: n1 == null ? '－' : String(n1),
      下學期數: n2 == null ? '－' : String(n2),
      合計: n1 == null && n2 == null ? '－' : String((n1 ?? 0) + (n2 ?? 0)),
    };
  });

  // ---- 操行成績（禮貌/衣著/服務/紀律/獎懲加扣分/操行總分），上/下學期/全學年三欄 ----
  // 【2026-08-27 修正】原本這裡只有禮貌/衣著/服務/紀律四項的平均，直接跳到
  // 「操行總分」，操行總分背後其實已經有把「獎懲加扣分」（嘉獎/警告/小功/小過/
  // 大功/大過依後台設定的點數換算出來的加減總和，見 disciplineAdjustment）加進去，
  // 但這個中間數字沒有出現在合併列印的表格裡，管理員在 Word 範本上看不到「操行總分
  // 到底有沒有算進獎懲」，等於看不出這個總和公式。這裡在「操行總分」前面多插一列
  // 「獎懲加扣分」，把這個中間值秀出來，操行總分＝四項平均＋獎懲加扣分，兩列並排
  // 放在一起，計算方式就清楚可見了。
  const CONDUCT_ITEMS: { key: keyof TermBlock['conduct']; label: string }[] = [
    { key: 'politeness', label: '禮貌' },
    { key: 'dress', label: '衣著' },
    { key: 'service', label: '服務' },
    { key: 'discipline', label: '紀律' },
  ];
  const 操行成績 = CONDUCT_ITEMS.map(({ key, label }) => {
    const v1 = s1?.conduct[key] ?? null;
    const v2 = s2?.conduct[key] ?? null;
    return {
      項目: label,
      上學期分數: fmtScore(v1),
      下學期分數: fmtScore(v2),
      全學年分數: v1 != null && v2 != null ? fmtScore((v1 + v2) / 2) : fmtScore(v1 ?? v2 ?? null),
    };
  });
  {
    const a1 = s1?.disciplineAdjustment ?? null;
    const a2 = s2?.disciplineAdjustment ?? null;
    操行成績.push({
      項目: '獎懲加扣分',
      上學期分數: fmtSigned(a1),
      下學期分數: fmtSigned(a2),
      全學年分數: a1 != null && a2 != null ? fmtSigned(a1 + a2) : fmtSigned(a1 ?? a2 ?? null),
    });
  }
  {
    const o1 = s1?.conduct.overall ?? null;
    const o2 = s2?.conduct.overall ?? null;
    操行成績.push({
      項目: '操行總分',
      上學期分數: fmtScore(o1),
      下學期分數: fmtScore(o2),
      全學年分數: o1 != null && o2 != null ? fmtScore((o1 + o2) / 2) : fmtScore(o1 ?? o2 ?? null),
    });
  }

  // ---- 政策說明（外頁用）：全部從資料庫目前設定算出來，不是寫死文字，管理員在後台
  // 調整對應設定，這裡合併出來的成績單會自動更新（不用改 Word 範本）。----
  const p = data.policy;
  const 出缺席規則 = p.attendance.map((a) => ({
    項目: a.name,
    原始分數: a.rawScore == null ? '－' : String(a.rawScore),
    佔總分比例: a.percentOfTotal == null ? '－' : fmtSigned(a.percentOfTotal) + '%',
  }));

  return {
    // ---- 基本資料 ----
    學校: data.school,
    學年度: String(data.academicYear),
    學期: data.currentTerm,
    年級: data.gradeLevel,
    班級: data.className,
    學號: data.studentNo,
    姓名: data.studentName,
    座號: String(data.seatNo),
    列印日期: data.printedAt,
    導師評語: data.remark || '',

    // ---- 升留級：只有下學期／學年成績單（上下學期都有資料）才會判斷，
    // 上學期單獨列印時這裡是空字串（跟 PDF 那邊的規則一致，見 ReportCardDocument.tsx）----
    升留級: s1 && s2 && s2.academicAverage.total != null ? (s2.academicAverage.total >= 60 ? '升級' : '留級') : '',

    // ---- 科目成績表格（迴圈欄位，範本裡用 {{#科目}}...{{/科目}} 包住一列表格列）----
    科目,

    // ---- 學業平均：獨立的合併欄位（不是迴圈），對應範本裡「科目成績表格」下方
    // 另外固定的一列，見上面的修正說明。----
    學業平均上期中: fmtScore(s1?.academicAverage.midterm ?? null),
    學業平均上期末: fmtScore(s1?.academicAverage.final ?? null),
    學業平均上平時: fmtScore(s1?.academicAverage.daily ?? null),
    學業平均上總分: fmtScore(s1?.academicAverage.total ?? null),
    學業平均下期中: fmtScore(s2?.academicAverage.midterm ?? null),
    學業平均下期末: fmtScore(s2?.academicAverage.final ?? null),
    學業平均下平時: fmtScore(s2?.academicAverage.daily ?? null),
    學業平均下總分: fmtScore(s2?.academicAverage.total ?? null),
    學業平均全年平均,

    // ---- 出席／懲獎記錄（迴圈欄位）----
    出席記錄,
    懲獎記錄,
    上學期全勤: s1?.isPerfectAttendance ? '是' : '',
    下學期全勤: s2?.isPerfectAttendance ? '是' : '',

    // ---- 班級人數／名次 ----
    上學期班級人數: s1?.classSize == null ? '－' : String(s1.classSize),
    下學期班級人數: s2?.classSize == null ? '－' : String(s2.classSize),
    上學期班級名次: s1?.classRank == null ? '－' : String(s1.classRank),
    下學期班級名次: s2?.classRank == null ? '－' : String(s2.classRank),

    // ---- 操行成績表格（迴圈欄位）＋ 操行等第 ----
    操行成績,
    上學期操行等第: conductGradeLabel(s1?.conduct.overall ?? null),
    下學期操行等第: conductGradeLabel(s2?.conduct.overall ?? null),

    // ---- 外頁政策說明：學業成績/特殊表現計算方式、出缺席加扣分規則 ----
    期中比重: p.academicWeights.midterm == null ? '－' : fmtPct(p.academicWeights.midterm),
    期末比重: p.academicWeights.final == null ? '－' : fmtPct(p.academicWeights.final),
    平時比重: p.academicWeights.daily == null ? '－' : fmtPct(p.academicWeights.daily),
    出缺席佔比: p.attendanceWeightPercent == null ? '－' : fmtPct(p.attendanceWeightPercent),
    嘉獎加分: fmtSigned(p.conduct.merit1),
    警告扣分: fmtSigned(p.conduct.demerit1),
    小功加分: fmtSigned(p.conduct.merit3),
    小過扣分: fmtSigned(p.conduct.demerit3),
    大功加分: fmtSigned(p.conduct.merit9),
    大過扣分: fmtSigned(p.conduct.demerit9),
    出缺席規則,
  } as unknown as ReportCardMergeContext;
}

// ---------- 修補「在 Word 裡編輯過的範本，合併欄位被拆散」的問題 ----------
// 這是 Word 合併範本最常見、也最讓人一頭霧水的狀況：管理員在 Word 裡點一下
// {{出席記錄}} 這種標籤附近打字、用注音/拼音輸入法選字、或不小心讓自動校對／
// 字體邊界介入，Word 存檔時可能會「無聲無息」把本來連在一起的一串文字，拆成
// 好幾段各自獨立的內部區塊（XML 術語叫 <w:r> run），例如 {{#出席記錄}} 被拆成
// 「{{#出」＋「席記錄}}」兩段——畫面上用肉眼看起來完全正常、還是同一行同一個
// 樣子，但程式在讀取檔案時，會找不到完整的 {{#出席記錄}}，因而回報「標籤沒有
// 成對」（Unbalanced loop tags）這種讓人看不懂哪裡打錯字的錯誤——因為根本沒有
// 打錯字，是 Word 自己把它拆開的。
//
// 這裡在「檢查範本」跟「合併資料」之前，先自動把「格式完全相同、緊鄰在一起」的
// 相鄰區塊接回成同一段文字，大部分情況都能自動修好，不需要管理員自己去研究
// Word 檔案內部的 XML 格式。
function mergeAdjacentRuns(xml: string): string {
  // 只合併兩個緊鄰、且「有沒有 rPr（字體/顏色等格式設定）」與「rPr 內容」完全相同、
  // 每個都只包含單一個 <w:t>純文字內容的 <w:r>，這是最常見、也最安全能自動判斷是
  // 「同一段文字被拆開」而不是「本來就是使用者刻意分開的兩段不同文字」的情況。
  const PAIR_RE =
    /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t([^>]*)>([^<]*)<\/w:t><\/w:r><w:r>\1<w:t(?:[^>]*)>([^<]*)<\/w:t><\/w:r>/g;
  let result = xml;
  // 標籤有時被拆成 3 段以上（例如 {{ / #出席 / 記錄}}），一次合併只會接回相鄰的
  // 一對，所以重複合併到完全沒有變化為止，最多跑 30 輪保底避免無窮迴圈。
  for (let i = 0; i < 30; i++) {
    const next = result.replace(PAIR_RE, (_m, rPr: string | undefined, _attrs: string, t1: string, t2: string) => {
      return `<w:r>${rPr ?? ''}<w:t xml:space="preserve">${t1}${t2}</w:t></w:r>`;
    });
    if (next === result) break;
    result = next;
  }
  return result;
}

// ---------- 修補整份範本檔案（word/document.xml），回傳修補後的新 Buffer ----------
export function repairTemplateBuffer(buffer: Buffer): Buffer {
  const zip = new PizZip(buffer);
  const file = zip.file('word/document.xml');
  if (!file) return buffer; // 不是有效的 .docx，交給後面驗證邏輯回報錯誤
  const original = file.asText();
  const repaired = mergeAdjacentRuns(original);
  if (repaired === original) return buffer;
  zip.file('word/document.xml', repaired);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}

// ---------- 系統內建的預設 Word 範本（管理員還沒上傳過自訂範本時使用）----------
// 檔案放在 public/templates/，見該資料夾旁的說明；用 fs 直接讀檔（伺服器端執行，
// 不經過瀏覽器打包，路徑用 process.cwd() 組出來跟 lib/reportCard.ts 讀校徽圖檔
// 用同一招）。
export function loadDefaultTemplateBuffer(): Buffer {
  const p = path.join(process.cwd(), 'public', 'templates', 'report-card-merge-template.docx');
  return fs.readFileSync(p);
}

// ---------- 拿「目前生效中」的範本：管理員上傳過自訂範本就用那份，沒有就退回內建
// 預設範本。單一學生列印、批次列印都呼叫這支，確保兩邊用同一份範本。----------
export async function getActiveTemplateBuffer(): Promise<Buffer> {
  const { data } = await supabaseAdmin
    .from('report_card_merge_template')
    .select('file_data')
    .eq('is_active', true)
    .maybeSingle();
  if (data?.file_data) {
    const hex = (data.file_data as string).replace(/^\\x/, '');
    return Buffer.from(hex, 'hex');
  }
  return loadDefaultTemplateBuffer();
}

// ---------- 拿範本 + 一位學生的資料，合併出這位學生的 .docx（Buffer）----------
export function mergeReportCardDocx(templateBuffer: Buffer, data: ReportCardData): Buffer {
  const zip = new PizZip(repairTemplateBuffer(templateBuffer));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: TAG_DELIMITERS,
    nullGetter: () => '', // 範本裡有但這次資料沒填到的欄位，印空白，不要噴錯或印出奇怪字樣
  });
  doc.render(buildReportCardMergeContext(data));
  return doc.getZip().generate({ type: 'nodebuffer' }) as Buffer;
}

// ---------- 批次列印：把多位學生各自合併好的 .docx 接成同一份檔案（每位學生
// 之間插入分頁），做法比照 pdf-lib 合併多份 PDF 的邏輯，只是換成手動接 Word 的
// document.xml——因為每位學生的 .docx 都是同一份範本合併出來的（共用同一套樣式
// /圖片/頁首頁尾），只有內文文字不同，直接把 <w:body> 裡「內容」部分（不含最後
// 的 <w:sectPr> 版面設定）一份一份接起來即可，不用另外處理圖片重複嵌入的問題。----------
export function mergeMultipleDocx(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) throw new Error('沒有任何學生資料可以合併');
  if (buffers.length === 1) return buffers[0];

  const baseZip = new PizZip(buffers[0]);
  const baseXml = baseZip.file('word/document.xml')!.asText();

  const bodyOpenMatch = baseXml.match(/<w:body[^>]*>/);
  const sectPrMatch = baseXml.match(/<w:sectPr[^>]*>[\s\S]*<\/w:sectPr>\s*<\/w:body>/);
  if (!bodyOpenMatch || !sectPrMatch) {
    throw new Error('範本格式不支援批次合併（找不到 <w:body> 或版面設定 <w:sectPr>），請改用單一學生列印。');
  }
  const bodyOpenTag = bodyOpenMatch[0];
  const bodyOpenIdx = baseXml.indexOf(bodyOpenTag) + bodyOpenTag.length;
  const sectPrBlockStart = baseXml.lastIndexOf('<w:sectPr');
  // 每位學生內容之間的分頁符號
  const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  let firstBodyContent = baseXml.slice(bodyOpenIdx, sectPrBlockStart);
  let combined = firstBodyContent;

  for (let i = 1; i < buffers.length; i++) {
    const zip = new PizZip(buffers[i]);
    const xml = zip.file('word/document.xml')!.asText();
    const openTag = xml.match(/<w:body[^>]*>/)![0];
    const openIdx = xml.indexOf(openTag) + openTag.length;
    const sectStart = xml.lastIndexOf('<w:sectPr');
    const bodyContent = xml.slice(openIdx, sectStart);
    combined += PAGE_BREAK + bodyContent;
  }

  // 版面設定（紙張大小/邊界/頁首頁尾）用第一位學生那份的即可，全部學生都是
  // 同一份範本產生，版面設定原本就一樣。
  const sectPrBlock = baseXml.slice(sectPrBlockStart);
  const newXml = baseXml.slice(0, bodyOpenIdx) + combined + sectPrBlock;

  baseZip.file('word/document.xml', newXml);
  return baseZip.generate({ type: 'nodebuffer' }) as Buffer;
}

// ---------- 檢查一份上傳的檔案是不是「看起來像」有效的 Word 合併範本 ----------
// 只做基本檢查（是有效的 .docx zip、裡面有 word/document.xml），不強制要求用到
// 哪些合併欄位——範本裡想用哪些欄位、要不要全部用到，都是管理員自己決定的版面設計。
// 成功時回傳「修補過」的 buffer（見 repairTemplateBuffer）：呼叫端應該存這份、
// 不是存使用者原始上傳的那份，這樣同一份範本以後每次列印都不用重複修補。
export function validateDocxTemplate(buffer: Buffer): { ok: true; repairedBuffer: Buffer } | { ok: false; error: string } {
  const repairedBuffer = repairTemplateBuffer(buffer);
  try {
    const zip = new PizZip(repairedBuffer);
    const doc = zip.file('word/document.xml');
    if (!doc) return { ok: false, error: '這個檔案不是有效的 Word (.docx) 檔案，找不到 word/document.xml，請確認上傳的是 .docx（不是 .doc 舊格式或其他檔案）。' };
    // 用一份假資料試著 render 一次，語法寫錯（例如 {{ 沒對到 }}、迴圈標籤沒成對）
    // 在這裡就會噴錯，比等到真的幫學生列印時才發現好。
    const testDoc = new Docxtemplater(new PizZip(repairedBuffer), {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: TAG_DELIMITERS,
      nullGetter: () => '',
    });
    testDoc.render(buildReportCardMergeContext(SAMPLE_DATA_FOR_VALIDATION));
    return { ok: true, repairedBuffer };
  } catch (err: any) {
    return { ok: false, error: explainDocxtemplaterError(err) };
  }
}

// ---------- 把 docxtemplater 的錯誤訊息，轉成不懂程式的人也看得懂、知道下一步
// 要怎麼做的中文說明。----------
function explainDocxtemplaterError(err: any): string {
  const errors: any[] = err?.properties?.errors ?? [];

  // docxtemplater 內部這個錯誤實際的 id 是 "unbalanced_loop_tags"（不是字面上的
  // "UnbalancedLoopError"），explanation 長得像「Unbalanced loop tags
  // {#xxx}{/xxx}{#yyy}{/yyy}」，意思是它找到兩組迴圈標籤（例如 {{#出席記錄}}…
  // {{/出席記錄}} 跟 {{#懲獎記錄}}…{{/懲獎記錄}}），但沒辦法確定這兩組要各自展開
  // 到哪裡才對——最常見的成因是這兩組迴圈被放在同一個表格的同一列裡緊鄰著
  // （例如左欄一個表格、右欄另一個表格，兩個表格又並排放在同一個外層表格的
  // 同一列），只要之後在 Word 裡對附近的表格做過一些編輯（調整過表格框線／
  // 屬性、儲存格合併過又分割），就可能讓它變得無法判斷；另一種較少見的成因，
  // 是編輯合併欄位附近文字時被 Word 悄悄拆成好幾段（系統已經自動嘗試修補這種
  // 情況，這裡會出現代表修補後仍然失敗）。
  const unbalanced = errors.find((e) => e?.properties?.id === 'unbalanced_loop_tags' || /unbalanced loop tags/i.test(e?.properties?.explanation ?? e?.message ?? ''));
  if (unbalanced) {
    const lastPairTag = unbalanced?.properties?.lastPair?.left ?? '';
    const pairTag = unbalanced?.properties?.pair?.left ?? '';
    const tagsText = [lastPairTag, pairTag].filter(Boolean).join('」跟「');
    return (
      `範本裡有兩組合併欄位的迴圈標籤（「${tagsText || '看下面詳細訊息'}」）系統沒辦法確定各自要展開到哪裡。` +
      `系統已經自動嘗試修補一次（修補常見的「Word 悄悄把標籤文字拆散」問題）仍然失敗，最常見的原因是「這兩組` +
      `迴圈被排在同一個表格的同一列、左右並排」，只要之後在 Word 裡動過附近的表格（調過框線、合併/分割過` +
      `儲存格），就可能讓系統判斷不出這兩組迴圈的範圍。請試試看：\n` +
      `1. 把這兩個表格改成「上下堆疊」放（各自獨立成一個表格，不要放在同一個外層表格的同一列並排），` +
      `這是最穩定、不容易再出問題的排法。\n` +
      `2. 或是回【成績單合併列印範本】頁重新下載一次目前系統版本的範本（已經是上下堆疊的排法），` +
      `把您想要的欄位/文字調整貼進這份乾淨範本裡再上傳，會比修補舊的範本更快。\n` +
      `3. 若不確定怎麼調整，也可以直接把目前這份範本（連同這則錯誤訊息）回報給系統管理員協助檢查。\n\n` +
      `（原始錯誤訊息：${unbalanced?.properties?.explanation ?? unbalanced?.message ?? ''}）`
    );
  }

  const unclosed = errors.find((e) => e?.properties?.id === 'unclosed_loop' || /unclosed loop/i.test(e?.message ?? ''));
  if (unclosed) {
    const tag = unclosed?.properties?.xtag ?? '';
    return `範本裡的迴圈欄位「{{#${tag}}}」有開始標籤，但找不到對應的結束標籤「{{/${tag}}}」，請確認這組標籤有頭有尾、結束標籤沒有被刪掉或打錯字。`;
  }

  const unopened = errors.find((e) => e?.properties?.id === 'unopened_loop' || /unopened loop/i.test(e?.message ?? ''));
  if (unopened) {
    const tag = unopened?.properties?.xtag ?? '';
    return `範本裡的迴圈欄位「{{/${tag}}}」有結束標籤，但找不到對應的開始標籤「{{#${tag}}}」，請確認這組標籤有頭有尾、開始標籤沒有被刪掉或打錯字。`;
  }

  const duplicateOpen = errors.find((e) => e?.properties?.id === 'duplicate_open_tag' || /duplicate open tag/i.test(e?.message ?? ''));
  if (duplicateOpen) {
    return `範本裡有兩個相同名稱的迴圈開始標籤（例如兩個 {{#科目}}）沒有先各自對應到自己的結束標籤 {{/科目}} 就開始下一個，請確認每一組 {{#…}}…{{/…}} 都各自成對、沒有交錯或漏掉結束標籤。`;
  }

  const detail = errors.map((e) => e?.properties?.explanation).filter(Boolean).join('；') || err?.message || String(err);
  return `範本格式有誤，請確認合併欄位（{{...}}）跟迴圈標籤（{{#...}}...{{/...}}）都有正確成對：${detail}`;
}

// 驗證上傳範本時用的假資料：只需要每個欄位「有值可以套」就好，不代表真的有這個學生，
// 純粹是為了讓 docxtemplater 能實際跑一次 render()，抓出「語法?structurally 有沒有
// 問題」（例如迴圈標籤沒成對），資料本身正不正確不重要。
const SAMPLE_DATA_FOR_VALIDATION: ReportCardData = {
  school: '範例學校',
  academicYear: 0,
  currentTerm: '上學期',
  gradeLevel: '範例年級',
  className: '範例班級',
  studentNo: '0000',
  studentName: '範例學生',
  seatNo: 0,
  printedAt: '',
  remark: '',
  terms: {
    上學期: {
      ready: true,
      subjects: [{ subject: '範例科目', weight: 1, midterm: 0, final: 0, daily: 0, total: 0 }],
      academicAverage: { midterm: 0, final: 0, daily: 0, total: 0 },
      attendance: { 曠課: 0, 遲到: 0, 病假: 0, 事假: 0, 公假: 0 },
      isPerfectAttendance: true,
      attendanceScore: 0,
      discipline: { 嘉獎: 0, 小功: 0, 大功: 0, 警告: 0, 小過: 0, 大過: 0 },
      conduct: { politeness: 0, dress: 0, service: 0, discipline: 0, overall: 0 },
      disciplineAdjustment: 0,
      classSize: 0,
      classRank: 0,
      stageWeights: { midterm: 1, final: 1, daily: 1 },
    },
    下學期: null,
  },
  policy: {
    conduct: { merit1: 0, demerit1: 0, merit3: 0, demerit3: 0, merit9: 0, demerit9: 0 },
    academicWeights: { midterm: 0, final: 0, daily: 0 },
    attendanceWeightPercent: 0,
    attendance: [],
  },
} as unknown as ReportCardData;
