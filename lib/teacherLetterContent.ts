import { ServiceCertRow, MergedAppointmentRow, LetterCategory, computeServiceDuration } from './teacherLetters';
import { TeacherLetterSettings } from './teacherLetterSettings';

// 這個檔案把「0808.xlsm」印在職證明／印自聘教師聘書／印當年聘書 三張工作表的公式邏輯，
// 逐條對照著搬成一般 TS 函式（VLOOKUP／IF／DATEDIF 那些公式在瀏覽器端本來就不會重新計算，
// 只能用實際的資料庫資料算好內容再交給 PDF/Word 產生器排版），PDF 跟 Word 共用同一份內容，
// 排版邏輯改天要調整，數字/文字內容只要改這裡一個地方就好。

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 個位數字轉中文數字（聘期年數通常是1~10年內，原始公式用Excel [DBNum1]格式；這裡只需要支援
 *  合理範圍內的整數，超過20的極端值就直接印阿拉伯數字，不特別處理更複雜的中文數字進位規則）。 */
export function toChineseNumber(n: number): string {
  if (n <= 10) return CHINESE_DIGITS[n] ?? String(n);
  if (n < 20) return '十' + CHINESE_DIGITS[n - 10];
  if (n < 100 && n % 10 === 0) return CHINESE_DIGITS[Math.floor(n / 10)] + '十';
  if (n < 100) return CHINESE_DIGITS[Math.floor(n / 10)] + '十' + CHINESE_DIGITS[n % 10];
  return String(n);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !day) return d;
  return `${y}/${m}/${day}`;
}

export type CertificateContent = {
  schoolTitle: string;
  principalName: string;
  name: string;
  birthDate: string;
  gender: string;
  nationality: string;
  department: string;
  title: string;
  serviceSegments: { start: string; end: string }[];
  serviceDurationLabel: string;
  employmentStatusLabel: string; // "(現仍在職)" 或 "(現已離職)"
  note: string;
  phone: string;
  address: string;
  issueDateLabel: string;
};

/** 對照「印在職證明」：D3(出生)/B4(性別)/D4(國籍)/B5(部門)/D5(職務)/B7~D9(任職起訖)/B11(服務年資) */
export function buildCertificateContent(cert: ServiceCertRow, settings: TeacherLetterSettings, calcDate: Date): CertificateContent {
  const duration = computeServiceDuration(cert, calcDate);
  const segments: { start: string; end: string }[] = [];
  if (cert.start_date_1) segments.push({ start: fmtDate(cert.start_date_1), end: cert.end_date_1 ? fmtDate(cert.end_date_1) : '至今' });
  if (cert.start_date_2) segments.push({ start: fmtDate(cert.start_date_2), end: cert.end_date_2 ? fmtDate(cert.end_date_2) : '至今' });
  if (cert.start_date_3) segments.push({ start: fmtDate(cert.start_date_3), end: cert.end_date_3 ? fmtDate(cert.end_date_3) : '至今' });

  return {
    schoolTitle: `${settings.school_name_zh}任職證明書`,
    principalName: settings.principal_name,
    name: cert.name,
    birthDate: fmtDate(cert.birth_date),
    gender: cert.gender ?? '',
    nationality: cert.nationality ?? '',
    department: cert.department ?? '',
    title: cert.title ?? '',
    serviceSegments: segments,
    serviceDurationLabel: `※服務年資共計：${duration.label}`,
    employmentStatusLabel: cert.resigned ? '(現已離職)' : '(現仍在職)',
    note: '本證書旨在證明該員在本校服務',
    phone: settings.phone,
    address: settings.address,
    issueDateLabel: fmtDate(calcDate.toISOString().slice(0, 10)),
  };
}

export type AppointmentContent = {
  category: LetterCategory;
  name: string;
  genderTitle: string; // 先生/女士
  positionLine: string; // "擔任本校 {部門}{職位}，聘期為{中文數字}年，"
  startDateLabel: string;
  endDateLabel: string;
  closingLine1: string; // "泰國清萊雲南會館"
  closingLine2: string; // "附屬美賽華雲學校"
  signatureLine: string; // "校長  XXX" 或 "董事長 XXX"
  issueDateLabel: string;
};

/** 對照「印自聘教師聘書」／「印當年聘書」：B11/B10(姓名+稱謂)、B13/B12(擔任本校...聘期為N年)、
 *  D17~D19／D16~D18(約聘期間起訖)、D25/D26(校長或董事長簽署——如果印的人剛好是校長本人，
 *  簽署人改成董事長，避免校長替自己簽聘書這種奇怪狀況)。 */
export function buildAppointmentContent(row: MergedAppointmentRow, settings: TeacherLetterSettings, calcDate: Date): AppointmentContent {
  const genderTitle = row.gender === '女' ? '女士' : '先生';
  const termYears = row.term_no ?? 1;
  const positionLine = `擔任本校 ${row.department ?? ''}${row.title ?? ''}，聘期為${toChineseNumber(termYears)}年，`;
  const isPrincipalHerself = !!settings.principal_name && row.name === settings.principal_name;
  const signatureLine = isPrincipalHerself && settings.chairman_name ? `董事長 ${settings.chairman_name}` : `校長  ${settings.principal_name}`;
  // 發文日期：原始活頁簿是用「聘期起算日+119天」這種湊出來的公式（本意大概是抓聘期起始
  // 前一小段時間當發文日），對現在的系統來說直接用「發聘時間」欄位（自聘）或今天的日期
  // （當年，原始工作表沒有獨立的發聘時間欄位）更清楚也更好維護。
  const issueDate = row.category === '自聘教師聘書' && row.issued_date ? row.issued_date : calcDate.toISOString().slice(0, 10);
  return {
    category: row.category,
    name: row.name,
    genderTitle,
    positionLine,
    startDateLabel: fmtDate(row.start_date),
    endDateLabel: fmtDate(row.end_date),
    closingLine1: '泰國清萊雲南會館',
    closingLine2: '附屬美賽華雲學校',
    signatureLine,
    issueDateLabel: fmtDate(issueDate),
  };
}
