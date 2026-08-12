import type * as XLSXNS from 'xlsx';
import { supabase } from './supabaseClient';

// ⚠️ 同 excelTemplates.ts 頂端註解：'xlsx' 套件只能在瀏覽器執行，改成用到才動態載入。
let _xlsx: typeof XLSXNS | null = null;
async function loadXLSX(): Promise<typeof XLSXNS> {
  if (!_xlsx) _xlsx = await import('xlsx');
  return _xlsx;
}
function aoa(XLSX: typeof XLSXNS, rows: any[][]): XLSXNS.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}
function download(XLSX: typeof XLSXNS, wb: XLSXNS.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename);
}

export type UploadResult = { successCount: number; errors: string[]; updatedCount?: number };

/* ============================================================ */
/* 開發人員區「聘書」：以「0509教師資料_VBA列印.xlsm」「0808.xlsm」為樣本                */
/* 原檔3張資料表 → 對應這裡2張資料庫表：                                     */
/*   「在職證明」（改名「歷年教師資料」） → teacher_service_certificates       */
/*   「自聘教師資料」       → teacher_appointment_letters (category='自聘教師聘書') */
/*   「當年教師資料」       → teacher_appointment_letters (category='當年教師聘書') */
/* （原檔「印在職證明」「印自聘教師聘書」「印當年聘書」是VBA排版列印用的畫面，       */
/*   不是資料本身，不建表；有需要列印可直接用「下載目前資料」印出的Excel列印。）      */
/* ============================================================ */

/* -------------------- 共用：Excel 日期/布林值解析 -------------------- */

function toDateOrNull(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return toDateStr(v);
  if (typeof v === 'number') {
    // Excel 日期序號
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    return toDateStr(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = String(v).trim();
  if (!s) return null;
  // 支援「2027/1/1」「2027-01-01」這類文字日期
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return toDateStr(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function toBool(v: any): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  return s === 'V' || s === 'v' || s === '是' || s === 'TRUE' || s === 'true' || s === '1';
}
function toIntOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* -------------------- 在職時間試算（依「0808.xlsx」歷年教師資料工作表 R/S/T 三欄公式逐字還原） -------------------- */
// 原始公式（節錄自 0808.xlsx 歷年教師資料!R3，S3/T3同一套邏輯的月/日版本）：
//   年：IF( IF(N3>0, DATEDIF(J3,K3,"YM")+DATEDIF(L3,M3,"YM")+DATEDIF(N3,$D$1,"YM"),
//            IF(L3>0, DATEDIF(J3,K3,"YM")+DATEDIF(L3,$D$1,"YM"), DATEDIF(J3,$D$1,"YM")) ) > 11,
//          [年的加總]+1, [年的加總] )
//   月：IF( [跟上面同一套邏輯但條件改用K3>0/M3>0、DATEDIF算法改"MD"算出的日加總] > 30,
//          QUOTIENT(日加總,31) + [月的加總], [月的加總] )
//   日：> 30 則 MOD(日加總,31)，否則就是日加總本身
// （J=任職日期1,K=離職日期1,L=任職日期2,M=離職日期2,N=任職日期3，$D$1=計算日期；
//  離職日期3(O欄)公式沒有用到——原始設計是「最多3段，最後一段一律視為在職中，
//  以計算日期為結束」。這裡忠實照抄這個邏輯，只是把 Excel DATEDIF 換成用標準的
//  「完整月數」演算法實作，跟 Excel official DATEDIF 在極少數邊界日期可能有1天以內
//  的落差，僅供內部參考顯示用，不影響資料庫實際存的日期欄位本身。）
function fullMonthsBetween(start: Date, end: Date): number {
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(months, 0);
}
function datedifY(start: Date, end: Date) { return Math.floor(fullMonthsBetween(start, end) / 12); }
function datedifYM(start: Date, end: Date) { return fullMonthsBetween(start, end) % 12; }
function datedifMD(start: Date, end: Date) {
  const months = fullMonthsBetween(start, end);
  const anchor = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
  return Math.max(Math.round((end.getTime() - anchor.getTime()) / 86400000), 0);
}

export function computeServiceDuration(
  cert: {
    start_date_1: string | null; end_date_1: string | null;
    start_date_2: string | null; end_date_2: string | null;
    start_date_3: string | null; end_date_3: string | null;
  },
  calcDate: Date
): { years: number; months: number; days: number; label: string } {
  const s1 = cert.start_date_1 ? new Date(cert.start_date_1) : null;
  const e1 = cert.end_date_1 ? new Date(cert.end_date_1) : null;
  const s2 = cert.start_date_2 ? new Date(cert.start_date_2) : null;
  const e2 = cert.end_date_2 ? new Date(cert.end_date_2) : null;
  const s3 = cert.start_date_3 ? new Date(cert.start_date_3) : null;
  if (!s1) return { years: 0, months: 0, days: 0, label: '共 0年 0個月 0日' };

  // 年／月的加總：依 s3、s2 是否存在決定要算幾段（跟原始公式的 N3>0／L3>0 判斷一致）
  let ySum: number, ymSum: number;
  if (s3) {
    ySum = datedifY(s1, e1 ?? s1) + datedifY(s2 ?? s3, e2 ?? s3) + datedifY(s3, calcDate);
    ymSum = datedifYM(s1, e1 ?? s1) + datedifYM(s2 ?? s3, e2 ?? s3) + datedifYM(s3, calcDate);
  } else if (s2) {
    ySum = datedifY(s1, e1 ?? s2) + datedifY(s2, calcDate);
    ymSum = datedifYM(s1, e1 ?? s2) + datedifYM(s2, calcDate);
  } else {
    ySum = datedifY(s1, calcDate);
    ymSum = datedifYM(s1, calcDate);
  }

  // 日的加總：原始公式這段的分段判斷用的是「離職日期」(K3>0／M3>0)是否存在，
  // 而不是任職日期——跟年/月的判斷條件不同，這裡忠實照抄。
  let mdSum: number;
  if (s3 && e2) {
    mdSum = datedifMD(s1, e1 ?? s1) + datedifMD(s2 ?? s3, e2) + datedifMD(s3, calcDate);
  } else if (e1) {
    mdSum = datedifMD(s1, e1) + datedifMD(s2 ?? calcDate, calcDate);
  } else {
    mdSum = datedifMD(s1, calcDate);
  }

  const years = ySum + (ymSum > 11 ? 1 : 0);
  const monthsBase = ymSum - (ymSum > 11 ? 12 : 0);
  const months = mdSum > 30 ? monthsBase + Math.floor(mdSum / 31) : monthsBase;
  const days = mdSum > 30 ? mdSum % 31 : mdSum;
  return { years, months, days, label: `共 ${years}年 ${months}個月 ${days}日` };
}

/* -------------------- 1. 歷年教師資料（原「在職證明」，改名並補上自動結算在職年數/月數/日數） -------------------- */

export const SERVICE_CERT_SHEET_NAME = '歷年教師資料';
const SERVICE_CERT_HEADER = [
  '歷年序號', '自聘(V)', '離職(V)', '姓名', '出生日期(西元)', '國籍', '性別', '服務部門', '職稱',
  '任職日期1', '離職日期1', '任職日期2', '離職日期2', '任職日期3', '離職日期3', '備註',
];

export async function buildServiceCertTemplate(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    SERVICE_CERT_HEADER,
    ['↓從第2列開始才是資料。日期請用「2016/2/27」或Excel日期格式。自聘/離職欄有打「V」才算是；沒打就留空。', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    [1, '', 'V', '田景燦', '', '', '男', '中學部', '校長', '2016/2/27', '2023/4/30', '', '', '', '', ''],
    [2, 'V', '', '黃崧桓', '1989/3/29', '台灣', '男', '', '辦公室主任', '2020/5/1', '2023/10/1', '2026/5/22', '', '', '', ''],
  ]);
}

export async function downloadServiceCertTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildServiceCertTemplate(), SERVICE_CERT_SHEET_NAME);
  download(XLSX, wb, '歷年教師資料_範本.xlsx');
}

export type ServiceCertRow = {
  id?: string;
  seq_no: number | null;
  self_hired: boolean;
  resigned: boolean;
  name: string;
  birth_date: string | null;
  nationality: string | null;
  gender: string | null;
  department: string | null;
  title: string | null;
  start_date_1: string | null; end_date_1: string | null;
  start_date_2: string | null; end_date_2: string | null;
  start_date_3: string | null; end_date_3: string | null;
  note: string | null;
};

// 【2026-08 修正】原本這裡只會 insert，重新上傳同一批（哪怕只是想修正其中幾筆的錯字/
// 漏填的離職日期）會直接整批變成重複的新資料列，而不是修正舊資料——這就是「批次修正
// 功能」缺少的部分。改成「先查同名是否已有資料，有就更新那一筆，沒有才新增」，
// 上傳同一份姓名對得起來的範本檔就能達到批次修正的效果（例如整批補上漏填的離職日期、
// 修正職稱打錯字…），不會產生重複列。跟原始 Excel 用姓名 VLOOKUP 對照是同一個邏輯，
// 所以這裡也用姓名當比對鍵；如果剛好有兩位教師同名，會更新到第一筆查到的資料，
// 這點跟原始活頁簿的 VLOOKUP 本來就有一樣的限制，不是這次修正造成的新問題。
export async function uploadServiceCertSheet(rowsRaw: any[][], createdBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  let updatedCount = 0;
  const errors: string[] = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[3] == null || String(r[3]).trim() === '') continue; // 姓名(第4欄)空白視為結束/跳過
    if (typeof r[0] === 'string' && r[0].startsWith('↓')) continue; // 略過說明列
    const name = String(r[3]).trim();
    try {
      const row = {
        seq_no: toIntOrNull(r[0]),
        self_hired: toBool(r[1]),
        resigned: toBool(r[2]),
        name,
        birth_date: toDateOrNull(r[4]),
        nationality: r[5] != null ? String(r[5]).trim() || null : null,
        gender: r[6] != null ? String(r[6]).trim() || null : null,
        department: r[7] != null ? String(r[7]).trim() || null : null,
        title: r[8] != null ? String(r[8]).trim() || null : null,
        start_date_1: toDateOrNull(r[9]), end_date_1: toDateOrNull(r[10]),
        start_date_2: toDateOrNull(r[11]), end_date_2: toDateOrNull(r[12]),
        start_date_3: toDateOrNull(r[13]), end_date_3: toDateOrNull(r[14]),
        note: r[15] != null ? String(r[15]).trim() || null : null,
        updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase
        .from('teacher_service_certificates')
        .select('id')
        .eq('name', name)
        .limit(1)
        .maybeSingle();
      if (existing) {
        const { error } = await supabase.from('teacher_service_certificates').update(row).eq('id', existing.id);
        if (error) throw new Error(error.message);
        updatedCount++;
      } else {
        const { error } = await supabase
          .from('teacher_service_certificates')
          .insert({ ...row, created_by: createdBy ?? null });
        if (error) throw new Error(error.message);
        successCount++;
      }
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}）：${err.message}`);
    }
  }
  return { successCount, errors, updatedCount } as UploadResult;
}

export async function fetchCurrentServiceCertSheet(): Promise<{ name: string; aoa: any[][] }> {
  const { data, error } = await supabase
    .from('teacher_service_certificates')
    .select('*')
    .order('seq_no', { nullsFirst: true });
  if (error || !data) return { name: '歷年教師資料(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const calcDate = new Date();
  const rows = (data as any[]).map((c) => {
    const dur = computeServiceDuration(c, calcDate);
    return [
      c.seq_no, c.self_hired ? 'V' : '', c.resigned ? 'V' : '', c.name, c.birth_date, c.nationality, c.gender,
      c.department, c.title, c.start_date_1, c.end_date_1, c.start_date_2, c.end_date_2, c.start_date_3, c.end_date_3,
      c.note, dur.label, dur.years, dur.months, dur.days,
    ];
  });
  return {
    name: '歷年教師資料(現況)',
    aoa: [[...SERVICE_CERT_HEADER, `在職時間(以${toDateStr(calcDate)}試算)`, '年', '月', '日'], ...rows],
  };
}

/* -------------------- 2. 自聘教師資料 ／ 當年教師資料（原「自聘教師聘書」／「當年教師聘書」） -------------------- */
// 【2026-08 修正】依「0509教師資料_VBA列印.xlsm」原始設計比對過：這兩張工作表的姓名／
// 職位／性別欄位本來就是用 VLOOKUP／INDEX 從「在職證明」（即「歷年教師資料」）整批
// 帶出來的，不是各自獨立輸入的名單——沿用同樣的精神，這裡改成「不是另外維護一份姓名
// 清單」，而是直接依「歷年教師資料」勾選的「自聘」欄位分流：
//   自聘教師資料 = 歷年教師資料裡 self_hired = true 的人
//   當年教師資料 = 歷年教師資料裡「未離職」的所有人（不論是否自聘）
// 姓名/職位/性別/離職狀態一律從「歷年教師資料」帶出（唯一事實來源，不會兩邊資料兜不起來），
// teacher_appointment_letters 這張表縮小成只存「聘書專屬」、「歷年教師資料」沒有的欄位：
// 序號／聘期／起／迄／發聘時間，用「類別＋姓名」對應到歷年教師資料的哪一筆。
// （原始 Excel「當年教師資料」的篩選條件其實是「離職＝空白」。中間有一版曾經改成
// 「非自聘教師才出現在當年教師資料」，把「自聘」「當年」兩份名單當成互斥的兩群人——
// 【2026-08 修正】這個理解是錯的：需求已明確澄清「自聘教師也要放入當年教師資料，
// 僅排除離職人員」，也就是自聘教師本來就該同時出現在「自聘教師資料」與「當年教師
// 資料」兩份名單裡，兩者不是互斥關係。這裡改回貼近原始 Excel 的規則：當年教師資料
// 只看「離職」欄位，不管有沒有勾自聘。）

export type LetterCategory = '自聘教師聘書' | '當年教師聘書';

export const SELF_HIRED_LETTER_SHEET_NAME = '自聘教師聘書';
export const ANNUAL_LETTER_SHEET_NAME = '當年教師聘書';

// 【2026-08-10 修正】對照「0808.xlsm」的實際公式後更新：
// - 自聘教師資料!I3：IF(MONTH(TODAY())>6, YEAR(TODAY())+1, YEAR(TODAY())) & "/1/1"
//   ——不是單純「固定下一年」，是「現在如果已經過7月，起聘年就抓明年；否則抓今年」。
// - 當年教師資料!F3：=自聘教師資料!I3+120，120天後落在同一個「起聘年」的5月1日附近，
//   所以當年教師資料的起聘年其實跟自聘教師資料是同一個「參考年」，不是單純看今天是哪一年。
// - 兩者的迄日都是「起日 + 聘期年數 - 1天」（迄日算法一致，只是起日基準不同）。
// 使用者已確認「當年5/1～次年4/30」的方向正確，這裡改成用同一套「參考年」邏輯算，
// 兩份預設值的起聘年才會對得起來（例如現在是2026/8，參考年算出來是2027：自聘變成
// 2027/1/1~2027/12/31，當年則是2027/5/1~2028/4/30）。
function referenceYear(): number {
  const now = new Date();
  const month = now.getMonth() + 1; // 1~12
  return month > 6 ? now.getFullYear() + 1 : now.getFullYear();
}

export function defaultTermDatesForCategory(category: LetterCategory): { start_date: string; end_date: string } {
  const refYear = referenceYear();
  if (category === '自聘教師聘書') {
    return { start_date: `${refYear}-01-01`, end_date: `${refYear}-12-31` };
  }
  return { start_date: `${refYear}-05-01`, end_date: `${refYear + 1}-04-30` };
}

/** 這個類別「有資格」出現的教師名單，姓名/職位/性別/離職狀態都以「歷年教師資料」為準：
 *  - 自聘教師聘書：只看「自聘」有勾選的人（不論離職與否，自聘那邊本來就有自己的「離職」
 *    欄位可以顯示，不需要整筆排除）。
 *  - 當年教師聘書：所有「未離職」的人都算在內，不論有沒有勾選「自聘」——2026-08 修正：
 *    自聘教師也要能同時出現在「自聘教師資料」與「當年教師資料」兩份名單裡，只有已離職
 *    的教師才要從當年教師資料排除。 */
export async function listEligibleCertRows(category: LetterCategory): Promise<ServiceCertRow[]> {
  let query = supabase.from('teacher_service_certificates').select('*');
  if (category === '自聘教師聘書') {
    query = query.eq('self_hired', true);
  } else {
    query = query.eq('resigned', false);
  }
  const { data } = await query.order('seq_no', { nullsFirst: true });
  return (data as ServiceCertRow[]) ?? [];
}

const SELF_HIRED_HEADER = ['序號', '姓名(需已在歷年教師資料勾選自聘)', '聘期', '起', '迄', '發聘時間'];
const ANNUAL_HEADER = ['序號', '姓名(需已在歷年教師資料且未勾選離職)', '聘期', '起', '迄'];

export async function buildAppointmentLetterTemplate(category: LetterCategory): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  if (category === '自聘教師聘書') {
    return aoa(XLSX, [
      SELF_HIRED_HEADER,
      ['↓從第2列開始才是資料。姓名要跟「歷年教師資料」裡的姓名完全一樣（且該筆要有勾選「自聘」），', '', '', '', '', ''],
      ['　系統會自動帶出職位/性別/離職狀態，這裡只需要填聘書專屬的聘期/起迄/發聘時間。日期請用「2027/1/1」或Excel日期格式。', '', '', '', '', ''],
      [1, '黃崧桓', 1, '2027/1/1', '2027/12/31', '2027/1/1'],
      [2, '楊惠彬', 1, '2027/1/1', '2027/12/31', '2027/1/1'],
    ]);
  }
  return aoa(XLSX, [
    ANNUAL_HEADER,
    ['↓從第2列開始才是資料。姓名要跟「歷年教師資料」裡的姓名完全一樣（且該筆不能勾選「離職」，自聘教師也可以出現在這裡），', '', '', '', ''],
    ['　系統會自動帶出職位/性別，這裡只需要填聘書專屬的聘期/起迄。日期請用「2027/5/1」或Excel日期格式。', '', '', '', ''],
    [1, '董嬌玫', 2, '2027/5/1', '2029/4/30'],
    [2, '譚倩盈', 3, '2027/5/1', '2030/4/30'],
  ]);
}

export async function downloadAppointmentLetterTemplate(category: LetterCategory) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const sheetName = category === '自聘教師聘書' ? SELF_HIRED_LETTER_SHEET_NAME : ANNUAL_LETTER_SHEET_NAME;
  XLSX.utils.book_append_sheet(wb, await buildAppointmentLetterTemplate(category), sheetName);
  download(XLSX, wb, `${sheetName}_範本.xlsx`);
}

/** 聘書專屬欄位（存在 teacher_appointment_letters，用 category+姓名 對應到歷年教師資料的哪一筆） */
export type AppointmentLetterRow = {
  id?: string;
  category: LetterCategory;
  seq_no: number | null;
  name: string;
  term_no: number | null;
  start_date: string | null;
  end_date: string | null;
  issued_date: string | null;
  note: string | null;
};

/** 畫面上實際顯示/編輯用的合併列：姓名/職位/性別/離職狀態一律來自歷年教師資料（唯一事實來源），
 *  只有聘期/起迄/發聘時間/序號/備註是這張聘書自己的資料。cert_id 一定有值（因為列表本身就是從
 *  歷年教師資料篩出來的）；letter_id 在還沒填過聘書資料時是 undefined（代表資料庫裡還沒有這筆）。 */
export type MergedAppointmentRow = {
  cert_id: string;
  letter_id?: string;
  category: LetterCategory;
  name: string;
  title: string | null;
  gender: string | null;
  department: string | null;
  resigned: boolean;
  seq_no: number | null;
  term_no: number | null;
  start_date: string | null;
  end_date: string | null;
  issued_date: string | null;
  note: string | null;
};

/** 這個類別目前的完整清單：以「歷年教師資料」勾選結果為主（誰該出現在這裡），
 *  再把已經填過的聘書專屬欄位（聘期/起迄/發聘時間）疊上去；還沒填過聘書資料的教師
 *  一樣會出現在清單裡（聘期等欄位顯示空白），方便管理者直接補填，不用另外「新增」。 */
export async function listMergedAppointmentRows(category: LetterCategory): Promise<MergedAppointmentRow[]> {
  const [certRows, { data: letterRows }] = await Promise.all([
    listEligibleCertRows(category),
    supabase.from('teacher_appointment_letters').select('*').eq('category', category),
  ]);
  const letterByName = new Map<string, any>();
  for (const l of letterRows ?? []) letterByName.set(l.name, l);
  return certRows.map((c) => {
    const l = letterByName.get(c.name);
    return {
      cert_id: c.id!,
      letter_id: l?.id,
      category,
      name: c.name,
      title: c.title,
      gender: c.gender,
      department: c.department,
      resigned: c.resigned,
      seq_no: l?.seq_no ?? null,
      term_no: l?.term_no ?? null,
      start_date: l?.start_date ?? null,
      end_date: l?.end_date ?? null,
      issued_date: l?.issued_date ?? null,
      note: l?.note ?? null,
    };
  });
}

/** 儲存某位教師這個類別的聘書專屬欄位；姓名不在「歷年教師資料」對應的自聘/非自聘名單裡就拒絕存檔
 *（避免聘書資料庫裡出現一筆「歷年教師資料」根本查不到、或自聘勾選對不起來的孤兒資料）。 */
export async function saveMergedAppointmentRow(row: MergedAppointmentRow, createdBy?: string | null): Promise<{ error?: string }> {
  const payload: any = {
    category: row.category,
    seq_no: row.seq_no,
    name: row.name,
    term_no: row.term_no,
    start_date: row.start_date,
    end_date: row.end_date,
    issued_date: row.category === '自聘教師聘書' ? row.issued_date : null,
    note: row.note,
    updated_at: new Date().toISOString(),
  };
  if (row.letter_id) {
    const { error } = await supabase.from('teacher_appointment_letters').update(payload).eq('id', row.letter_id);
    return { error: error?.message };
  }
  const { error } = await supabase.from('teacher_appointment_letters').insert({ ...payload, created_by: createdBy ?? null });
  return { error: error?.message };
}

export async function deleteAppointmentLetterRow(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('teacher_appointment_letters').delete().eq('id', id);
  return { error: error?.message };
}

// 批次上傳：姓名一定要能在「歷年教師資料」這個類別對應的名單（自聘/非自聘）裡查到，
// 查不到就整列報錯，不會建立資料庫裡的孤兒資料；查到了就用「category+姓名」upsert
// （已有聘書資料就更新，沒有就新增）——重新上傳同一份修正過的範本，就是批次修正聘期/起迄/
// 發聘時間的方式，跟「歷年教師資料」的批次修正是同一套邏輯。
export async function uploadAppointmentLetterSheet(rowsRaw: any[][], category: LetterCategory, createdBy?: string | null): Promise<UploadResult> {
  let successCount = 0;
  let updatedCount = 0;
  const errors: string[] = [];
  const eligible = await listEligibleCertRows(category);
  const eligibleNames = new Set(eligible.map((c) => c.name));
  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[1] == null || String(r[1]).trim() === '') continue; // 姓名(第2欄)空白視為結束/跳過
    if (typeof r[0] === 'string' && r[0].startsWith('↓')) continue;
    if (typeof r[0] === 'string' && r[0].startsWith('　')) continue;
    const name = String(r[1]).trim();
    try {
      if (!eligibleNames.has(name)) {
        throw new Error(
          category === '自聘教師聘書'
            ? '歷年教師資料查不到這個姓名、或該筆沒有勾選「自聘」，請先到「歷年教師資料」補上再重新上傳'
            : '歷年教師資料查不到這個姓名、或該筆已勾選「離職」（當年教師資料只排除已離職教師，自聘教師也算在內），請先確認「歷年教師資料」再重新上傳'
        );
      }
      const rawStart = toDateOrNull(r[3]);
      const rawEnd = toDateOrNull(r[4]);
      const useDefault = !rawStart && !rawEnd; // 起迄都沒填才套用預設值，只填一個就照使用者填的來
      const defaults = useDefault ? defaultTermDatesForCategory(category) : null;
      const payload: any = {
        category,
        seq_no: toIntOrNull(r[0]),
        name,
        term_no: toIntOrNull(r[2]),
        start_date: rawStart ?? defaults?.start_date ?? null,
        end_date: rawEnd ?? defaults?.end_date ?? null,
        issued_date: category === '自聘教師聘書' ? toDateOrNull(r[5]) : null,
        updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase
        .from('teacher_appointment_letters')
        .select('id')
        .eq('category', category)
        .eq('name', name)
        .limit(1)
        .maybeSingle();
      if (existing) {
        const { error } = await supabase.from('teacher_appointment_letters').update(payload).eq('id', existing.id);
        if (error) throw new Error(error.message);
        updatedCount++;
      } else {
        const { error } = await supabase.from('teacher_appointment_letters').insert({ ...payload, created_by: createdBy ?? null });
        if (error) throw new Error(error.message);
        successCount++;
      }
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}）：${err.message}`);
    }
  }
  return { successCount, errors, updatedCount };
}

export async function fetchCurrentAppointmentLetterSheet(category: LetterCategory): Promise<{ name: string; aoa: any[][] }> {
  const sheetName = (category === '自聘教師聘書' ? SELF_HIRED_LETTER_SHEET_NAME : ANNUAL_LETTER_SHEET_NAME) + '(現況)';
  const rows = await listMergedAppointmentRows(category);
  if (category === '自聘教師聘書') {
    const body = rows.map((r) => [r.seq_no, r.name, r.title, r.gender, r.term_no, r.start_date, r.end_date, r.resigned ? 'V' : '', r.issued_date]);
    return { name: sheetName, aoa: [['序號', '姓名', '職位(來自歷年教師資料)', '性別(來自歷年教師資料)', '聘期', '起', '迄', '離職(來自歷年教師資料)', '發聘時間'], ...body] };
  }
  const body = rows.map((r) => [r.seq_no, r.name, r.title, r.gender, r.term_no, r.start_date, r.end_date]);
  return { name: sheetName, aoa: [['序號', '姓名', '職位(來自歷年教師資料)', '性別(來自歷年教師資料)', '聘期', '起', '迄'], ...body] };
}

/* -------------------- 編輯／刪除（單筆，供列表頁「編輯」按鈕使用） -------------------- */

export async function saveServiceCertRow(row: ServiceCertRow, createdBy?: string | null): Promise<{ error?: string }> {
  const { id, ...fields } = row;
  const payload: any = { ...fields, updated_at: new Date().toISOString() };
  if (!id) payload.created_by = createdBy ?? null;
  const { error } = id
    ? await supabase.from('teacher_service_certificates').update(payload).eq('id', id)
    : await supabase.from('teacher_service_certificates').insert(payload);
  return { error: error?.message };
}

export async function deleteServiceCertRow(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('teacher_service_certificates').delete().eq('id', id);
  return { error: error?.message };
}

export async function listServiceCertRows(): Promise<ServiceCertRow[]> {
  const { data } = await supabase.from('teacher_service_certificates').select('*').order('seq_no', { nullsFirst: true });
  return (data as ServiceCertRow[]) ?? [];
}

/* -------------------- 3. 列印樣本 -------------------- */
// 【2026-08-10 修正】原本這裡是「上傳一份Excel樣本檔，程式把資料寫進樣本裡讓Excel公式算」
// 的做法（先用0509、後來改用0808.xlsm當內建樣本）。但這次需求明確要PDF/Word檔而不是Excel，
// Excel公式那一套在瀏覽器端本來就不會重新計算，勉強繼續用只會更難維護。改成直接把
// 0808.xlsm三張列印工作表的公式邏輯，用一般TypeScript重新實作（見 lib/teacherLetterContent.ts），
// 內容算好之後直接用 @react-pdf/renderer／docx 套件產生PDF/Word，不再需要上傳/管理Excel樣本檔，
// 校名/校長/董事長/電話/地址這些原本寫死在Excel儲存格的固定文字，改成存在
// teacher_letter_settings資料表（見 sql/36teacher_letter_settings.sql），在「列印」分頁
// 就能直接編輯、存檔，不用再改程式碼或上傳新的樣本檔案。
// 這裡不再需要 Supabase Storage 的 teacher-letter-templates bucket。
