import type * as XLSXNS from 'xlsx';

// ⚠️ 見 excelTemplates.ts 頂端註解：'xlsx' 套件在 Node.js（建置/伺服器端渲染）環境
// 執行到會直接丟出 `ReferenceError: self is not defined`，所以這裡也改成當下才動態載入，
// 確保只會在瀏覽器裡執行。
let _xlsx: typeof XLSXNS | null = null;
async function loadXLSX(): Promise<typeof XLSXNS> {
  if (!_xlsx) _xlsx = await import('xlsx');
  return _xlsx;
}

export type ParsedClassHeader = {
  academicYear: number;
  term: string;
  gradeLevel: string;
  className: string;
};

export type ParsedStudentRow = { seatNo: number; studentNo: string; name: string; rowIndex: number };

// 解析「成績、出缺輸入表」格式共用的表頭資訊（年度/學期/年級/班級）與學生名單。
// 格式參考「成績統計表0721.xlsx」的「成績、出缺輸入表」工作表。
export function parseSheetHeader(rowsRaw: any[][]): ParsedClassHeader {
  const row1 = rowsRaw[0] ?? [];
  const row2 = rowsRaw[1] ?? [];

  const gradeLevel = row1[2] != null ? String(row1[2]).trim() : '';
  const className = row2[2] != null ? String(row2[2]).trim() : '';

  let academicYear = 0;
  let term = '';
  for (const cell of row1) {
    if (cell == null) continue;
    const text = String(cell);
    const yearMatch = text.match(/(\d{4})學年度/) || text.match(/(\d{4})/);
    if (!academicYear && yearMatch) academicYear = Number(yearMatch[1]);
    if (text === '上學期' || text === '下學期') term = text;
  }

  return { academicYear, term, gradeLevel, className };
}

export function parseStudentRows(rowsRaw: any[][], startRow = 7): ParsedStudentRow[] {
  const students: ParsedStudentRow[] = [];
  for (let i = startRow; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[1] == null) continue; // 學號欄空白就當作結束
    students.push({
      seatNo: Number(r[0]),
      studentNo: String(r[1]).trim(),
      name: r[2] != null ? String(r[2]).trim() : '',
      rowIndex: i,
    });
  }
  return students;
}

export async function readWorkbook(file: File) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames.includes('成績、出缺輸入表') ? '成績、出缺輸入表' : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rowsRaw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  return rowsRaw;
}

// 找出「期中考/期末考/平時分」三個分數區塊各自的起始欄位，以及每個區塊裡的科目名稱（讀第7列，index6）
export function findScoreBlocks(rowsRaw: any[][]) {
  const headerRow = rowsRaw[4] ?? []; // 第5列（index4），文字上寫「期中考/期末考/平時分」
  const subjectRow = rowsRaw[6] ?? []; // 第7列（index6），各年級的科目名稱
  const blockNames = ['期中考', '期末考', '平時分'];
  const blocks: { examType: string; subjects: { index: number; subject: string }[] }[] = [];

  for (const name of blockNames) {
    const startIdx = headerRow.findIndex((v) => v != null && String(v).trim() === name);
    if (startIdx === -1) continue;
    const subjects: { index: number; subject: string }[] = [];
    for (let i = startIdx; i < startIdx + 11; i++) {
      const subj = subjectRow[i];
      if (subj != null && String(subj).trim() !== '' && String(subj).trim() !== '以下空白') {
        subjects.push({ index: i, subject: String(subj).trim() });
      }
    }
    blocks.push({ examType: name, subjects });
  }
  return blocks;
}

// 找出出缺勤區塊：從第5列(index4)開始，每個日期佔5欄（週一至週日，每天最多5節）
// 純文字日期表頭，例如「5月10日」「12月3日」（沒有年份，儲存格格式是「一般」文字，
// 不是 Excel 日期序號，Excel/xlsx 套件不會自動幫我們轉成 Date）。
// 這是實際學校匯出的「成績出缺輸入表」常見格式（見「成績出缺0808.xlsx」樣本），
// 過去只認 Date 物件／日期序號，遇到這種文字日期會整批讀不到、批次上傳因此變成
// 「成功匯入 0 筆」的無聲失敗，這裡補上文字日期的解析。
const TEXT_DATE_RE = /^(\d{1,2})月(\d{1,2})日$/;

// 依「學年度」推算文字日期（沒有年份資訊）對應的西元年份。
// 表頭欄位是由左到右依時間先後排列，所以用「月份比前一欄小」代表跨過年底（12月→1月），
// 這樣即可正確處理橫跨兩個西元年份的學期，同時不影響全部落在同一西元年份內的情況
// （例如樣本檔案「5月10日」～「10月10日」，月份一路遞增、不會跨年，一率算西元academicYear年）。
function resolveTextDateYear(month: number, academicYear: number, lastMonth: number | null, yearOffset: number) {
  if (lastMonth != null && month < lastMonth) {
    yearOffset += 1;
  }
  return { year: academicYear + yearOffset, yearOffset };
}

export async function findAttendanceDateColumns(rowsRaw: any[][], academicYear?: number) {
  const dateRow = rowsRaw[4] ?? []; // 第5列(index4)：日期
  const columns: { colIndex: number; date: Date }[] = [];
  const numericCodes = dateRow.some((v, idx) => idx >= 3 && typeof v === 'number' && v > 40000);
  const XLSX = numericCodes ? await loadXLSX() : null;
  let lastMonth: number | null = null;
  let yearOffset = 0;
  dateRow.forEach((v, idx) => {
    if (idx < 3) return; // 前3欄是座號/學號/姓名
    if (v instanceof Date) {
      columns.push({ colIndex: idx, date: v });
    } else if (typeof v === 'number' && v > 40000 && XLSX) {
      // Excel 日期序號（極少數情況 sheet_to_json 不會自動轉成 Date）
      columns.push({ colIndex: idx, date: XLSX.SSF.parse_date_code(v) as any });
    } else if (typeof v === 'string' && academicYear) {
      const m = v.trim().match(TEXT_DATE_RE);
      if (m) {
        const month = Number(m[1]);
        const day = Number(m[2]);
        const resolved = resolveTextDateYear(month, academicYear, lastMonth, yearOffset);
        lastMonth = month;
        yearOffset = resolved.yearOffset;
        columns.push({ colIndex: idx, date: new Date(resolved.year, month - 1, day) });
      }
    }
  });
  return columns;
}

export const ATTENDANCE_CODE_TO_STATUS: Record<number, string> = {
  10: '曠課',
  1: '遲到',
  2: '病假',
  3: '事假',
  4: '公假',
};
