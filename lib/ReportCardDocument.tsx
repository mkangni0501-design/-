import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';
import { registerNotoSansTC } from './pdfFonts';

// 中文字型註冊：見 lib/pdfFonts.ts 的完整說明。原本這裡完全沒有註冊字型
// （react-pdf 內建字型不含中文），除了數字以外全部印出來是亂碼，已修正。
registerNotoSansTC();

// ------------------------------------------------------------------
// 版型依「本校目前的成績單正面」樣本（使用者提供的 AI.xlsx）逐欄位還原：
// 科目/比重 + 上學期/下學期各自的 期中/期末/平時/總分 + 學年成績 + 出席記錄 +
// 懲獎記錄 + 學業平均 + 操行成績（含禮貌/衣著/服務/紀律）+ 全班人數/全班名次 +
// 升留級 + 家長簽章及建議 + 導師/訓導/教務/校長簽章 + 導師評語 + 列印日期。
// 反面（背面）樣本尚未提供，這次只做正面。
//
// 顏色/字級/邊框/文字標籤都可以由管理員透過 ReportCardStyleTab.tsx 下載/上傳一份
// JSON 設定檔調整（見 ReportCardStyleConfig 這個型別，也是那個管理頁表單欄位的
// 依據）——資料從哪裡來、哪個欄位對應哪個資料庫欄位，完全寫死在這個檔案的程式
// 邏輯裡，管理員上傳的設定檔改不到這部分，只能調整看起來的樣子跟文字敘述。
//
// 【資料缺口，目前先留空，等確認後再補】
// - 升留級：現有資料庫沒有對應欄位，先留空白；且只有印「下學期／學年」成績單
//   （上下學期都有資料）時這格才會出現，上學期單獨列印時整格空白。
// - 學校校徽/印章圖案：沒有拿到圖檔，先留空。
// ------------------------------------------------------------------

export type SubjectScoreRow = {
  subject: string;
  weight: number;
  midterm: number | null;
  final: number | null;
  daily: number | null;
  total: number | null;
};

export type TermBlock = {
  ready: boolean;
  subjects: SubjectScoreRow[];
  academicAverage: { midterm: number | null; final: number | null; daily: number | null; total: number | null };
  attendance: Record<'曠課' | '遲到' | '病假' | '事假' | '公假', number>;
  isPerfectAttendance: boolean;
  attendanceScore: number;
  discipline: Record<'嘉獎' | '小功' | '大功' | '警告' | '小過' | '大過', number>;
  conduct: { politeness: number | null; dress: number | null; service: number | null; discipline: number | null; overall: number | null };
  classSize: number | null;
  classRank: number | null;
  stageWeights: { midterm: number; final: number; daily: number } | null;
};

// 成績單「外頁」（封面說明頁）動態資料，見 lib/reportCard.ts 的 buildPolicySummary()——
// 全部從資料庫現有設定抓，不是寫死的文字，之後在後台調整對應設定，這裡會自動更新。
export type ReportCardPolicySummary = {
  conduct: { merit1: number | null; demerit1: number | null; merit3: number | null; demerit3: number | null; merit9: number | null; demerit9: number | null };
  academicWeights: { midterm: number | null; final: number | null; daily: number | null };
  attendanceWeightPercent: number | null;
  attendance: { name: string; rawScore: number | null; percentOfTotal: number | null }[];
};

export type ReportCardData = {
  school: string;
  academicYear: number;
  currentTerm: string;
  gradeLevel: string;
  className: string;
  studentNo: string;
  studentName: string;
  seatNo: number;
  terms: Record<'上學期' | '下學期', TermBlock | null>;
  remark: string;
  printedAt: string;
  policy: ReportCardPolicySummary;
};

// ---------- 管理員可調整的樣式設定：顏色/字級/邊框/文字標籤/版面配置，不含資料綁定 ----------
export type ReportCardStyleConfig = {
  colors: {
    yearBoxBg: string;
    termBoxBg: string;
    infoValueBg: string;
    infoValueGreenBg: string;
    sectionTitleBg: string;
    cellLeftLabelBg: string;
    borderColor: string;
  };
  sizes: {
    baseFontSize: number;
    headerFontSize: number;
    titleFontSize: number;
    borderWidth: number;
  };
  labels: {
    title: string; // 成績通知書
    academicYearSuffix: string; // "學年度"
    subject: string; // 科目
    weight: string; // 比重
    annualTotal: string; // 學年成績
    academicAverage: string; // 學業平均
    attendanceSubject: string; // 出缺席
    conductOverall: string; // 操行成績
    conductPoliteness: string; // 禮貌
    conductDress: string; // 衣著
    conductService: string; // 服務
    conductDiscipline: string; // 紀律
    attendanceRecordTitle: string; // 出席記錄
    disciplineRecordTitle: string; // 懲獎記錄
    perfectAttendance: string; // 全勤
    classSize: string; // 全班人數
    classRank: string; // 全班名次
    promotionStatus: string; // 升留級
    parentSignature: string; // 家長簽章及建議
    homeroomSign: string; // 導師簽章
    disciplineSign: string; // 訓導簽章
    academicSign: string; // 教務簽章
    principalSign: string; // 校長簽章
    remark: string; // 導師評語
  };
  // 【2026-08-21 新增】版面配置：解決「沒有拖曳編輯器之前，至少讓管理員自己能調整
  // 一部分版面」這個需求。不是真的拖曳定位（那是完全不同量級的工程，需要另外排一輪
  // 專門做），是「常見的、風險可控的調整項目」開放成設定：校徽/校園照片圖檔、外頁
  // 要不要印、內頁幾個欄位的寬度比例。改這裡不需要重新部署程式碼，存檔後下一次
  // 列印就會套用。
  layout: {
    logoUrl: string; // 校徽圖片網址，空字串＝顯示「校徽」文字佔位色塊
    campusPhotoUrl: string; // 校園照片圖片網址，空字串＝顯示「（校園照片）」文字佔位色塊
    showCoverPage: boolean; // 是否列印外頁（封面說明頁）；關閉的話成績單只印內頁
    subjectColWidthPercent: number; // 內頁「科目」欄寬度（佔整個表格寬度的%）
    weightColWidthPercent: number; // 內頁「比重」欄寬度（%）
    annualColWidthPercent: number; // 內頁「學年成績」欄寬度（%）
  };
};

export const DEFAULT_REPORT_CARD_STYLE: ReportCardStyleConfig = {
  colors: {
    yearBoxBg: '#BDD7EE',
    termBoxBg: '#A9D18E',
    infoValueBg: '#FFF2CC',
    infoValueGreenBg: '#A9D18E',
    sectionTitleBg: '#F2F2F2',
    cellLeftLabelBg: '#FFF9E6',
    borderColor: '#000000',
  },
  sizes: {
    baseFontSize: 11.5,
    headerFontSize: 16,
    titleFontSize: 19,
    borderWidth: 0.75,
  },
  labels: {
    title: '成績通知書',
    academicYearSuffix: '學年度',
    subject: '科目',
    weight: '比重',
    annualTotal: '學年成績',
    academicAverage: '學業平均',
    attendanceSubject: '出缺席',
    conductOverall: '操行成績',
    conductPoliteness: '禮貌',
    conductDress: '衣著',
    conductService: '服務',
    conductDiscipline: '紀律',
    attendanceRecordTitle: '出席記錄',
    disciplineRecordTitle: '懲獎記錄',
    perfectAttendance: '全勤',
    classSize: '全班人數',
    classRank: '全班名次',
    promotionStatus: '升留級',
    parentSignature: '家長簽章及建議',
    homeroomSign: '導師簽章',
    disciplineSign: '訓導簽章',
    academicSign: '教務簽章',
    principalSign: '校長簽章',
    remark: '導師評語',
  },
  layout: {
    logoUrl: '',
    campusPhotoUrl: '',
    showCoverPage: true,
    // 【2026-08-22 修正欄寬比例】照你這次附的樣本.xlsx 反推：內頁表格實際上是
    // 12個等寬欄位組成（科目1欄＋比重1欄＋上學期4欄＋下學期4欄＋全學年2欄），
    // 换成百分比＝每欄 100/12 ≈ 8.33%，全學年是2欄合併＝16.67%。上一輪的預設值
    // （14/7/10.5）跟真正的樣本比例對不太起來，這是「格線沒有對齊」的其中一個
    // 原因，這裡改成跟樣本一致的比例。
    subjectColWidthPercent: 8.33,
    weightColWidthPercent: 8.33,
    annualColWidthPercent: 16.67,
  },
};

function buildStyles(config: ReportCardStyleConfig) {
  const BORDER = `${config.sizes.borderWidth}pt solid ${config.colors.borderColor}`;
  const base = config.sizes.baseFontSize;
  // 【2026-08-22 修正】科目/比重/全學年這三欄的寬度改成可以調整之後（上一輪），
  // 「每個考試類型分數欄」（期中/期末/平時/總分 × 上下學期＝8欄）的寬度原本是
  // 寫死的 9.5%——8欄固定寫死＋另外三欄可調整，加起來很容易超過或低於100%
  // （預設值加起來甚至到107.5%），這正是這次反映「格線沒有對齊」的根本原因：
  // 一整列的寬度總和不等於100%，跟其他列（寬度總和有對齊過的）自然對不齊。
  // 改成「8個分數欄平分剩下的空間」，不管科目/比重/全學年這三欄怎麼調，8個分數
  // 欄的寬度會自動跟著算，整列永遠剛好加總100%，格線就會對齊。
  const scoreColWidth = (100 - config.layout.subjectColWidthPercent - config.layout.weightColWidthPercent - config.layout.annualColWidthPercent) / 8;
  return {
    BORDER,
    sheet: StyleSheet.create({
      page: { padding: 12, fontFamily: 'NotoSansTC', fontSize: base },
      outer: { border: BORDER, flex: 1 },

      headerRow: { flexDirection: 'row', borderBottom: BORDER, alignItems: 'stretch' },
      schoolName: { flex: 3, textAlign: 'center', fontSize: config.sizes.titleFontSize, fontWeight: 700, padding: 10, justifyContent: 'center' },
      yearBox: {
        flex: 1,
        textAlign: 'center',
        fontSize: config.sizes.headerFontSize,
        fontWeight: 700,
        padding: 10,
        backgroundColor: config.colors.yearBoxBg,
        borderLeft: BORDER,
        justifyContent: 'center',
      },
      termBox: {
        flex: 1,
        textAlign: 'center',
        fontSize: config.sizes.headerFontSize,
        fontWeight: 700,
        padding: 10,
        backgroundColor: config.colors.termBoxBg,
        borderLeft: BORDER,
        justifyContent: 'center',
      },
      titleBox: { flex: 1.4, textAlign: 'center', fontSize: config.sizes.titleFontSize, fontWeight: 700, padding: 10, borderLeft: BORDER, justifyContent: 'center' },

      infoRow: { flexDirection: 'row', borderBottom: BORDER },
      infoLabel: { padding: 8, fontSize: base * 1.13, justifyContent: 'center' },
      infoValue: {
        padding: 8,
        fontSize: base * 1.3,
        fontWeight: 700,
        backgroundColor: config.colors.infoValueBg,
        justifyContent: 'center',
        textAlign: 'center',
      },
      infoValueGreen: {
        padding: 8,
        fontSize: base * 1.3,
        fontWeight: 700,
        backgroundColor: config.colors.infoValueGreenBg,
        justifyContent: 'center',
        textAlign: 'center',
      },

      body: { flexDirection: 'row', flex: 1 },
      leftCol: { flex: 1.55, borderRight: BORDER },
      rightCol: { flex: 1 },

      pageInner: { flexDirection: 'row', flex: 1 },
      dateStrip: { width: 26, borderLeft: BORDER, alignItems: 'center', justifyContent: 'center' },
      dateStripText: { fontSize: base * 1.04, transform: 'rotate(90deg)', width: 340 },

      row: { flexDirection: 'row', borderBottom: BORDER, minHeight: 22 },
      sectionTitle: { textAlign: 'center', fontWeight: 700, fontSize: base * 1.04, padding: 5, backgroundColor: config.colors.sectionTitleBg, justifyContent: 'center' },
      cellHead: { textAlign: 'center', fontSize: base * 0.91, fontWeight: 700, padding: 3, justifyContent: 'center', borderLeft: BORDER },
      cellHeadFirst: { textAlign: 'center', fontSize: base * 0.91, fontWeight: 700, padding: 3, justifyContent: 'center' },
      cell: { textAlign: 'center', fontSize: base, padding: 3, justifyContent: 'center', borderLeft: BORDER },
      cellFirst: { textAlign: 'center', fontSize: base, padding: 3, justifyContent: 'center' },
      cellLeftLabel: { textAlign: 'center', fontSize: base, fontWeight: 700, padding: 3, justifyContent: 'center', backgroundColor: config.colors.cellLeftLabelBg },
      redText: { color: '#C00000' },

      subjectCol: { width: `${config.layout.subjectColWidthPercent}%` },
      weightCol: { width: `${config.layout.weightColWidthPercent}%` },
      scoreCol: { width: `${scoreColWidth}%` },
      annualCol: { width: `${config.layout.annualColWidthPercent}%` },

      attnItemCol: { width: '30%' },
      attnValCol: { width: '23.33%' },

      signBox: { flex: 1, borderLeft: BORDER, minHeight: 50, padding: 5 },
      signLabel: { fontSize: base, fontWeight: 700, textAlign: 'center', marginBottom: 3 },

      remarkBox: { minHeight: 70, padding: 6 },
      remarkLabel: { fontSize: base, fontWeight: 700, marginBottom: 3 },
      remarkText: { fontSize: base, lineHeight: 1.5 },
    }),
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// 列印日期（最右邊直式那條）：比照樣本用中文數字（二〇二六年八月十五日），不是阿拉伯數字。
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function cnDigits(n: number): string {
  return String(n)
    .split('')
    .map((d) => CN_DIGITS[Number(d)])
    .join('');
}
function cnDayOrMonth(n: number): string {
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + CN_DIGITS[n - 10];
  if (n % 10 === 0) return CN_DIGITS[Math.floor(n / 10)] + '十';
  return CN_DIGITS[Math.floor(n / 10)] + '十' + CN_DIGITS[n % 10];
}
function formatPrintDate(iso: string): string {
  const d = new Date(iso);
  return `公元${cnDigits(d.getFullYear())}年${cnDayOrMonth(d.getMonth() + 1)}月${cnDayOrMonth(d.getDate())}日`;
}

// 學年成績（左表最右邊那一欄）：目前只有一個學期有資料時，這欄本來就該是空白——
// 要等上/下學期都有資料，才有「一整個學年」可以算。實際合併公式（例如上下學期
// 各佔多少比重）要跟學校確認後再補，這裡先只處理「兩學期都有資料時顯示什麼」
// 這件事還沒發生過（目前資料只到上學期），所以先留空，不在這裡猜一個公式出來。
// 全學年平均：上學期／下學期「這個科目的總分（依比重加權過的期中/期末/平時合併值）」
// 兩者的平均——對照你提供的樣本圖（國文上學期88、下學期74.7左右、全學年顯示81.35，
// 剛好是兩者平均），確認就是簡單平均，不是重新拿原始分數整個再算一次。這支函式
// 原本是空的（只有 return ''，一直沒有真的實作），成績單「全學年」那一欄會一直是
// 空白，這輪一併補上。只有一個學期有資料時（例如下學期還沒開始），直接顯示那個
// 學期的總分，不會因為缺另一半而顯示空白或錯誤數字。
function annualTotal(subject: string, terms: ReportCardData['terms']): string {
  const spring = terms.上學期?.subjects.find((x) => x.subject === subject)?.total;
  const fall = terms.下學期?.subjects.find((x) => x.subject === subject)?.total;
  if (spring == null && fall == null) return '';
  if (spring == null) return fmt(fall!);
  if (fall == null) return fmt(spring);
  return fmt(Math.round(((spring + fall) / 2) * 100) / 100);
}

// 通用版的「兩學期平均」，給學業平均/操行成績這幾列（不是逐科目、是單一數字）用。
function annualAverage(spring: number | null | undefined, fall: number | null | undefined): string {
  if (spring == null && fall == null) return '';
  if (spring == null) return fmt(fall!);
  if (fall == null) return fmt(spring);
  return fmt(Math.round(((spring + fall) / 2) * 100) / 100);
}

function ScoreTable({
  terms,
  styles,
  BORDER,
  labels,
  config,
  scoreColWidth,
}: {
  terms: ReportCardData['terms'];
  styles: ReturnType<typeof buildStyles>['sheet'];
  BORDER: string;
  labels: ReportCardStyleConfig['labels'];
  config: ReportCardStyleConfig;
  scoreColWidth: number;
}) {
  const primary = terms.上學期 ?? terms.下學期;
  const subjects = primary?.subjects ?? [];
  const base = config.sizes.baseFontSize;
  return (
    <View>
      {/* 科目/比重/學期表頭 */}
      <View style={styles.row}>
        <View style={[styles.cellHeadFirst, styles.subjectCol, { justifyContent: 'center' }]}>
          <Text style={{ fontSize: 10, fontWeight: 700 }}>{labels.subject}</Text>
        </View>
        <View style={[styles.cellHead, styles.weightCol]}>
          <Text>{labels.weight}</Text>
        </View>
        <View style={[styles.cellHead, { width: '39%' }]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, { width: '39%' }]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.annualCol]}>
          <Text>{labels.annualTotal}</Text>
        </View>
      </View>
      <View style={styles.row}>
        <View style={[styles.cellFirst, styles.subjectCol]} />
        <View style={[styles.cell, styles.weightCol]} />
        {(['期中', '期末', '平時', '總分'] as const).map((h) => (
          <View key={'s' + h} style={[styles.cellHead, styles.scoreCol]}>
            <Text>{h}</Text>
          </View>
        ))}
        {(['期中', '期末', '平時', '總分'] as const).map((h) => (
          <View key={'f' + h} style={[styles.cellHead, styles.scoreCol]}>
            <Text>{h}</Text>
          </View>
        ))}
        <View style={[styles.cell, styles.annualCol]} />
      </View>
      {/* 期中/期末/平時各佔比重（%）：對應反映事項「曠課/遲到/事假/全勤/考試%這些
          文字說明是否可以直接抓取我們上傳的數據自動修正」——這裡直接讀
          terms.上學期/下學期.stageWeights（來自 grading_rules，見 lib/reportCard.ts），
          不是寫死的35/35/30，之後在後台調整佔比，這裡自動跟著變。上下學期理論上
          用同一套 grading_rules（同一個學年度），只是各自可能還沒有資料，優先顯示
          任一學期查得到的值。 */}
      {(() => {
        const sw = terms.上學期?.stageWeights ?? terms.下學期?.stageWeights;
        if (!sw) return null;
        const pctText = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}%`;
        return (
          <View style={[styles.row, { minHeight: 12 }]}>
            <View style={[styles.cellFirst, styles.subjectCol, { minHeight: 12 }]} />
            <View style={[styles.cell, styles.weightCol, { minHeight: 12 }]} />
            {[sw.midterm, sw.final, sw.daily, sw.midterm + sw.final + sw.daily].map((v, i) => (
              <View key={'sw-s' + i} style={[styles.cell, styles.scoreCol, { minHeight: 12, padding: 1 }]}>
                <Text style={{ fontSize: 6.5 }}>{pctText(v)}</Text>
              </View>
            ))}
            {[sw.midterm, sw.final, sw.daily, sw.midterm + sw.final + sw.daily].map((v, i) => (
              <View key={'sw-f' + i} style={[styles.cell, styles.scoreCol, { minHeight: 12, padding: 1 }]}>
                <Text style={{ fontSize: 6.5 }}>{pctText(v)}</Text>
              </View>
            ))}
            <View style={[styles.cell, styles.annualCol, { minHeight: 12 }]} />
          </View>
        );
      })()}

      {/* 科目列 */}
      {subjects.map((s) => {
        const fall = terms.下學期?.subjects.find((x) => x.subject === s.subject);
        return (
          <View style={styles.row} key={s.subject}>
            <View style={[styles.cellLeftLabel, styles.subjectCol]}>
              <Text>{s.subject}</Text>
            </View>
            <View style={[styles.cell, styles.weightCol]}>
              <Text>{pct(s.weight)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.midterm)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.final)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.daily)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(s.total)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.midterm)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.final)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.daily)}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol]}>
              <Text>{fmt(fall?.total)}</Text>
            </View>
            <View style={[styles.cell, styles.annualCol]}>
              <Text>{annualTotal(s.subject, terms)}</Text>
            </View>
          </View>
        );
      })}

      {/* 【2026-08-17】原本這裡另外寫了一列固定的「出缺席」列（用 labels.attendanceSubject
          + attendanceScore 手動組出來），是 sql/46 時代「出缺席不算一般科目」的殘留——
          sql/48fix_attendance_score_formula.sql 之後，「全勤／出缺席」已經變成
          lib/reportCard.ts 的 visibleSubjects 會正常列出的一個科目（比重％也會正確
          顯示），跟上面科目迴圈的其中一列一模一樣，這裡如果保留會變成印兩次重複的
          「出缺席」列，所以拿掉了。 */}

      {/* 學業平均 */}
      <View style={styles.row}>
        <View style={[styles.cellLeftLabel, styles.subjectCol]}>
          <Text>{labels.academicAverage}</Text>
        </View>
        <View style={[styles.cell, styles.weightCol]} />
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'sa' + k} style={[styles.cell, styles.scoreCol]}>
            <Text>{fmt(terms.上學期?.academicAverage[k])}</Text>
          </View>
        ))}
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'fa' + k} style={[styles.cell, styles.scoreCol]}>
            <Text>{fmt(terms.下學期?.academicAverage[k])}</Text>
          </View>
        ))}
        <View style={[styles.cell, styles.annualCol]}>
          <Text>{annualAverage(terms.上學期?.academicAverage.total, terms.下學期?.academicAverage.total)}</Text>
        </View>
      </View>
      {/* 操行成績 + 禮貌/衣著/服務/紀律：見 components/admin-tabs/ConductScoresTab.tsx
          （導師/管理員輸入的地方）。操行成績＝四個分項的平均，再加減懲獎點數，不是
          另外輸入的。目前上/下學期都各自獨立一組（跟其他科目一樣），哪個學期沒有
          資料就留空白。
          【2026-08-22 依你附的樣本.xlsx 精確重排】原本這裡在「科目」欄左邊多出一個
          空白的比重欄（樣本裡這五列沒有比重、標籤直接從最左邊開始，佔滿「科目＋
          比重」兩欄合起來的寬度，不是只佔科目欄、左邊留一截比重欄空白）；等第
          （優/甲/乙/丙/丁）原本統一放在最右邊（下學期分數的後面，等於「右邊四格」），
          樣本裡其實是放在「每個學期自己的分數右邊兩格」（上學期分數＋等第各佔上學期
          那個區塊寬度的一半，下學期分數＋等第各佔下學期區塊寬度的一半）——換算成
          分數欄(scoreCol)的單位，上學期原本4個分數欄的空間，這裡改成「2個給分數、
          2個給等第」，下學期比照辦理，等第的顯示空間因此也跟著變大（從占全部下學期
          後面的固定17%，改成跟著 scoreCol 的實際寬度走）。最後全學年平均欄維持在
          最右邊不變（跟樣本一致）。 */}
      <View style={{ flexDirection: 'row', borderBottom: BORDER, minHeight: 22 * 5 }}>
        <View style={{ flexDirection: 'column', width: `${config.layout.subjectColWidthPercent + config.layout.weightColWidthPercent}%` }}>
          {(
            [
              { label: labels.conductOverall, key: 'overall' as const },
              { label: labels.conductPoliteness, key: 'politeness' as const },
              { label: labels.conductDress, key: 'dress' as const },
              { label: labels.conductService, key: 'service' as const },
              { label: labels.conductDiscipline, key: 'discipline' as const },
            ]
          ).map(({ label, key }, i) => (
            <View style={[styles.cellLeftLabel, { minHeight: 22, borderBottom: i < 4 ? BORDER : 'none' }]} key={label}>
              <Text>{label}</Text>
            </View>
          ))}
        </View>

        {/* 上學期：分數(2欄寬) + 等第(2欄寬，貫穿五列) */}
        <View style={{ width: `${scoreColWidth * 4}%`, flexDirection: 'row', borderLeft: BORDER }}>
          <View style={{ width: `${scoreColWidth * 2}%` }}>
            {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
              <View key={key} style={{ minHeight: 22, justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
                <Text style={{ fontSize: base }}>{fmt(terms.上學期?.conduct[key])}</Text>
              </View>
            ))}
          </View>
          <View style={{ width: `${scoreColWidth * 2}%`, alignItems: 'center', justifyContent: 'center', borderLeft: BORDER }}>
            <Text style={{ fontSize: base * 2.6, fontWeight: 700 }}>{conductGradeLabel(terms.上學期?.conduct.overall ?? null)}</Text>
          </View>
        </View>

        {/* 下學期：分數(2欄寬) + 等第(2欄寬，貫穿五列) */}
        <View style={{ width: `${scoreColWidth * 4}%`, flexDirection: 'row', borderLeft: BORDER }}>
          <View style={{ width: `${scoreColWidth * 2}%` }}>
            {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
              <View key={key} style={{ minHeight: 22, justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
                <Text style={{ fontSize: base }}>{fmt(terms.下學期?.conduct[key])}</Text>
              </View>
            ))}
          </View>
          <View style={{ width: `${scoreColWidth * 2}%`, alignItems: 'center', justifyContent: 'center', borderLeft: BORDER }}>
            <Text style={{ fontSize: base * 2.6, fontWeight: 700 }}>{conductGradeLabel(terms.下學期?.conduct.overall ?? null)}</Text>
          </View>
        </View>

        {/* 全學年平均：跟其他列一樣，維持在最右邊 */}
        <View style={{ width: `${config.layout.annualColWidthPercent}%`, borderLeft: BORDER }}>
          {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
            <View key={key} style={{ minHeight: 22, justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
              <Text style={{ fontSize: base }}>{annualAverage(terms.上學期?.conduct[key], terms.下學期?.conduct[key])}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// 操行成績等第換算：90以上優、80-89甲、70-79乙、60-69丙、未滿60丁
// （2026-08-18 依學校確認的實際級距更新；上一輪用「65分=丙」反推的級距是錯的）。
function conductGradeLabel(score: number | null): string {
  if (score === null || score === undefined) return '';
  if (score >= 90) return '優';
  if (score >= 80) return '甲';
  if (score >= 70) return '乙';
  if (score >= 60) return '丙';
  return '丁';
}

function AttendanceDisciplinePanel({
  terms,
  styles,
  BORDER,
  labels,
}: {
  terms: ReportCardData['terms'];
  styles: ReturnType<typeof buildStyles>['sheet'];
  BORDER: string;
  labels: ReportCardStyleConfig['labels'];
}) {
  const spring = terms.上學期;
  const fall = terms.下學期;
  const attnKeys = ['曠課', '遲到', '病假', '事假', '公假'] as const;
  const discKeys = ['嘉獎', '小功', '大功', '警告', '小過', '大過'] as const;

  return (
    <View>
      <View style={styles.row}>
        <View style={[styles.sectionTitle, { width: '50%' }]}>
          <Text>{labels.attendanceRecordTitle}</Text>
        </View>
        <View style={[styles.sectionTitle, { width: '50%', borderLeft: BORDER }]}>
          <Text>{labels.disciplineRecordTitle}</Text>
        </View>
      </View>
      <View style={styles.row}>
        <View style={[styles.cellHeadFirst, styles.attnItemCol]}>
          <Text>項目</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>合計</Text>
        </View>
        <View style={[styles.cellHead, styles.attnItemCol, { borderLeft: BORDER }]}>
          <Text>項目</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>下學期</Text>
        </View>
        <View style={[styles.cellHead, styles.attnValCol]}>
          <Text>合計</Text>
        </View>
      </View>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const attnKey = attnKeys[i];
        const discKey = discKeys[i];
        const springV = attnKey ? spring?.attendance[attnKey] : undefined;
        const fallV = attnKey ? fall?.attendance[attnKey] : undefined;
        const total = (springV ?? 0) + (fallV ?? 0);
        const dSpringV = spring?.discipline[discKey];
        const dFallV = fall?.discipline[discKey];
        const dTotal = (dSpringV ?? 0) + (dFallV ?? 0);
        return (
          <View style={styles.row} key={i}>
            <View style={[styles.cellLeftLabel, styles.attnItemCol]}>
              <Text>{attnKey ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? springV ?? '' : ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? fallV ?? '' : ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{attnKey ? total : ''}</Text>
            </View>
            <View style={[styles.cellLeftLabel, styles.attnItemCol, { borderLeft: BORDER }]}>
              <Text>{discKey}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dSpringV ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dFallV ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.attnValCol]}>
              <Text>{dTotal}</Text>
            </View>
          </View>
        );
      })}
      {/* 全勤（獨立一列，跟上面五個假別放在一起看，樣本裡是"是/否"文字，不是次數） */}
      <View style={styles.row}>
        <View style={[styles.cellLeftLabel, styles.attnItemCol]}>
          <Text>{labels.perfectAttendance}</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{spring ? (spring.isPerfectAttendance ? '是' : '否') : ''}</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{fall ? (fall.isPerfectAttendance ? '是' : '否') : ''}</Text>
        </View>
        <View style={[styles.cell, styles.attnValCol]}>
          <Text>{[spring, fall].filter((t) => t?.isPerfectAttendance).length || ''}</Text>
        </View>
        <View style={[styles.cell, { width: '50%' }, { borderLeft: BORDER }]} />
      </View>

      {/* 全班人數／全班名次 */}
      <View style={[styles.row, { minHeight: 22 }]}>
        <View style={[styles.sectionTitle, { width: '25%' }]}>
          <Text>{labels.classSize}</Text>
        </View>
        <View style={{ width: '25%', borderLeft: BORDER }}>
          <View style={{ borderBottom: BORDER, padding: 2 }}>
            <Text style={{ fontSize: 7 }}>上學期 {spring?.classSize ?? ''}</Text>
          </View>
          <View style={{ padding: 2 }}>
            <Text style={{ fontSize: 7 }}>下學期 {fall?.classSize ?? ''}</Text>
          </View>
        </View>
        <View style={[styles.sectionTitle, { width: '25%', borderLeft: BORDER }]}>
          <Text>{labels.classRank}</Text>
        </View>
        <View style={{ width: '25%', borderLeft: BORDER }}>
          <View style={{ borderBottom: BORDER, padding: 2 }}>
            <Text style={{ fontSize: 7 }}>上學期 {spring?.classRank ?? ''}</Text>
          </View>
          <View style={{ padding: 2 }}>
            <Text style={{ fontSize: 7 }}>下學期 {fall?.classRank ?? ''}</Text>
          </View>
        </View>
      </View>

      {/* 升留級／家長簽章及建議：升留級目前無資料來源（先留空）；只有印「下學期／學年
          成績」的成績單（上下學期都有資料，可以算出整年總成績）時這格才會出現，
          上學期單獨列印時整格空白，連標籤都不顯示。 */}
      <View style={[styles.row, { minHeight: 34 }]}>
        <View style={[styles.sectionTitle, { width: '25%' }]}>
          <Text>{spring && fall ? labels.promotionStatus : ''}</Text>
        </View>
        <View style={[styles.sectionTitle, { width: '75%', borderLeft: BORDER }]}>
          <Text>{labels.parentSignature}</Text>
        </View>
      </View>

      {/* 簽章列 */}
      <View style={[styles.row, { minHeight: 30, borderBottom: 'none' }]}>
        {[labels.homeroomSign, labels.disciplineSign, labels.academicSign, labels.principalSign].map((label, i) => (
          <View key={label} style={[styles.signBox, i === 0 ? { borderLeft: 0 } : {}]}>
            <Text style={styles.signLabel}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ------------------------------------------------------------------
// 成績單「外頁」（封面說明頁）：對應反映事項「成績單列印頁目前只有內頁沒有那些
// 文字敘述的外頁」＋「曠課/遲到/事假/全勤/考試%這些文字說明是否可以直接抓取
// 我們上傳的數據自動修正」——這裡的數字全部來自 data.policy（見
// lib/reportCard.ts 的 buildPolicySummary()：讀 conduct_point_defaults／
// grading_rules／curriculum 現有設定算出來的），不是寫死在這個檔案裡的文字；
// 之後在後台調整這些設定，成績單封面會自動跟著更新，不用另外改版型。
// 操行等第（優/甲/乙/丙/丁）的分數級距目前系統裡沒有對應的可調整設定（是寫死在
// conductGradeLabel() 這支函式裡的邏輯），這裡照抄同一套級距純文字說明，兩邊
// 不會對不上；如果之後級距要改成可調整，這裡也要一併更新。
// ------------------------------------------------------------------
function CoverPage({
  data,
  styles,
  BORDER,
  labels,
  layout,
}: {
  data: ReportCardData;
  styles: ReturnType<typeof buildStyles>['sheet'];
  BORDER: string;
  labels: ReportCardStyleConfig['labels'];
  layout: ReportCardStyleConfig['layout'];
}) {
  const p = data.policy;
  const fmtPct = (n: number | null) => (n === null ? '－' : `${n % 1 === 0 ? n : n.toFixed(1)}%`);
  const fmtScore = (n: number | null) => (n === null ? '－' : n % 1 === 0 ? String(n) : n.toFixed(2));
  // 病假／公假這兩項數值通常是0，但比照你附的「成績單外頁說明.txt」原文的寫法
  // （病假 -0.00分 (-0.00%)、公假 -0.00分 (-0.00%)），0的時候也印成「-0.00%」
  // （用減號），不是「+0.00%」——只有真的是正數（目前只有「全勤」）才印加號。
  const fmtImpact = (n: number | null) => (n === null ? '' : `(${n > 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}%)`);

  // 【2026-08-21 依你提供的實際樣本圖重新排版】直式（portrait，不是內頁那張橫式），
  // 版面分三個橫向區塊：
  //   上半：左＝標題（泰文+中文）、中＝操行成績評量標準、右＝校徽
  //   中半：左＝校園照片＋標語、中＝獎懲/學業佔比計算方式、右＝泰文+中文校名
  //   下半：左＝班級/姓名/座號/學號欄位、右＝全勤加分及扣分說明
  // 校徽跟校園照片目前沒有拿到圖檔，先用色塊＋文字佔位；圖檔給我之後可以直接換成
  // 真的圖片（<Image src=... />），不用再調整版面結構。
  return (
    <Page size="A4" orientation="landscape" style={{ padding: 20, fontFamily: 'NotoSansTC', fontSize: 9 }}>
      <View style={{ flexDirection: 'row', marginBottom: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 9, marginBottom: 2, fontFamily: 'NotoSansThai' }}>หนังสือแจ้งผลการเรียน</Text>
          <Text style={{ fontSize: 18, fontWeight: 700 }}>學生成績通知書</Text>
        </View>
        <View style={{ flex: 1.6, textAlign: 'center' }}>
          <Text style={{ fontSize: 10, fontWeight: 700, marginBottom: 4 }}>學生操行成績之評量標準</Text>
          <Text style={{ fontSize: 8, lineHeight: 1.7 }}>
            一、九十分以上至一百分者為優等。{'\n'}
            二、八十分以上不滿九十分者為甲等。{'\n'}
            三、七十分以上不滿八十分者為乙等。{'\n'}
            四、六十分以上不滿七十分者為丙等。{'\n'}
            五、不滿六十分者為丁等（不及格）。
          </Text>
        </View>
        <View style={{ flex: 0.6, alignItems: 'center', justifyContent: 'flex-start' }}>
          {layout.logoUrl ? (
            <Image src={layout.logoUrl} style={{ width: 44, height: 44 }} />
          ) : (
            // 校徽圖檔還沒設定，先用色塊佔位——去【成績單樣式設定】頁上傳圖片後，
            // 這裡會自動換成真的圖片，不用改程式碼。
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#E8B4B8', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 6, textAlign: 'center' }}>校徽</Text>
            </View>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', marginBottom: 14, minHeight: 150 }}>
        <View style={{ flex: 1, alignItems: 'center' }}>
          {layout.campusPhotoUrl ? (
            <Image src={layout.campusPhotoUrl} style={{ width: '100%', height: 100, marginBottom: 6 }} />
          ) : (
            // 校園照片還沒設定，先用色塊佔位，同上，上傳後自動換成真的照片。
            <View style={{ width: '100%', height: 100, backgroundColor: '#BFD7EA', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 7, color: '#556' }}>（校園照片）</Text>
            </View>
          )}
          <Text style={{ fontSize: 11, fontWeight: 700, textAlign: 'center' }}>敦品勵學　崇德養志</Text>
        </View>

        <View style={{ flex: 1.6, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 9, marginBottom: 4 }}>學生特殊表現經訓導簽核，計算方式如下：</Text>
          <View style={{ flexDirection: 'row', marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 9, lineHeight: 1.8 }}>
                嘉獎 {p.conduct.merit1 !== null ? `+${p.conduct.merit1}` : '－'} 分{'\n'}
                小功 {p.conduct.merit3 !== null ? `+${p.conduct.merit3}` : '－'} 分{'\n'}
                大功 {p.conduct.merit9 !== null ? `+${p.conduct.merit9}` : '－'} 分
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 9, lineHeight: 1.8 }}>
                警告 {p.conduct.demerit1 ?? '－'} 分{'\n'}
                小過 {p.conduct.demerit3 ?? '－'} 分{'\n'}
                大過 {p.conduct.demerit9 ?? '－'} 分
              </Text>
            </View>
          </View>
          <Text style={{ fontSize: 9, marginBottom: 4 }}>學業成績計算方式如下：</Text>
          <Text style={{ fontSize: 9, lineHeight: 1.8 }}>
            期中考 {fmtPct(p.academicWeights.midterm)}{'\n'}
            期末考 {fmtPct(p.academicWeights.final)}{'\n'}
            平時分 {fmtPct(p.academicWeights.daily)}
          </Text>
        </View>

        <View style={{ flex: 1, alignItems: 'flex-end', paddingLeft: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: 700, textAlign: 'right', fontFamily: 'NotoSansThai' }}>โรงเรียนหัวหยุน</Text>
          <Text style={{ fontSize: 8, textAlign: 'right', marginBottom: 2, fontFamily: 'NotoSansThai' }}>โดย</Text>
          <Text style={{ fontSize: 8, textAlign: 'right', marginBottom: 8, fontFamily: 'NotoSansThai' }}>สมาคมยูนนาน จังหวัดเชียงราย</Text>
          <Text style={{ fontSize: 14, fontWeight: 700, textAlign: 'right' }}>清萊雲南會館附屬</Text>
          <Text style={{ fontSize: 14, fontWeight: 700, textAlign: 'right' }}>華雲學校</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 10, lineHeight: 2.4 }}>
            班級：　{data.gradeLevel}{data.className}班{'\n'}
            姓名：　{data.studentName}{'\n'}
            座號：　{String(data.seatNo).padStart(2, '0')}{'\n'}
            學號：　{data.studentNo}
          </Text>
        </View>
        <View style={{ flex: 1.6, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 9, marginBottom: 4 }}>
            全勤加分及缺曠病事假扣分如下
            {p.attendanceWeightPercent !== null ? `（出缺席佔學業成績比重 ${fmtPct(p.attendanceWeightPercent)}）` : ''}：
          </Text>
          <Text style={{ fontSize: 9, lineHeight: 1.9 }}>
            {p.attendance.map((a) => `${a.name} ${fmtScore(a.rawScore)} 分 ${fmtImpact(a.percentOfTotal)}`).join('\n')}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
      </View>

      <View style={{ position: 'absolute', bottom: 20, right: 26 }}>
        <Text style={{ fontSize: 8, color: '#666' }}>{formatPrintDate(data.printedAt)}</Text>
      </View>
    </Page>
  );
}

export function ReportCardDocument({ data, styleConfig }: { data: ReportCardData; styleConfig?: ReportCardStyleConfig }) {
  const config = styleConfig ?? DEFAULT_REPORT_CARD_STYLE;
  const { sheet: styles, BORDER } = buildStyles(config);
  const labels = config.labels;
  // ScoreTable 內的操行成績區塊需要跟其他列一樣的「分數欄寬度」才能對齊格線
  // （見 buildStyles() 裡的說明），這裡用同一條公式算一次，往下傳給 ScoreTable。
  const scoreColWidth = (100 - config.layout.subjectColWidthPercent - config.layout.weightColWidthPercent - config.layout.annualColWidthPercent) / 8;
  return (
    <Document>
      {config.layout.showCoverPage && <CoverPage data={data} styles={styles} BORDER={BORDER} labels={labels} layout={config.layout} />}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.pageInner}>
          <View style={styles.outer}>
            <View style={styles.headerRow}>
              <View style={styles.schoolName}>
                <Text>{data.school}</Text>
              </View>
              <View style={styles.yearBox}>
                <Text>
                  {data.academicYear} {labels.academicYearSuffix}
                </Text>
              </View>
              <View style={styles.termBox}>
                <Text>{data.currentTerm}</Text>
              </View>
              <View style={styles.titleBox}>
                <Text>{labels.title}</Text>
              </View>
            </View>
            <View style={styles.infoRow}>
              <View style={[styles.infoLabel, { width: '6%' }]}>
                <Text>學號：</Text>
              </View>
              <View style={[styles.infoValue, { width: '12%' }]}>
                <Text>{data.studentNo}</Text>
              </View>
              <View style={[styles.infoLabel, { width: '38%' }]} />
              <View style={[styles.infoLabel, { width: '8%' }]}>
                <Text>學生姓名：</Text>
              </View>
              <View style={[styles.infoValue, { width: '10%' }]}>
                <Text>{data.studentName}</Text>
              </View>
              <View style={[styles.infoValue, { width: '9%' }]}>
                <Text>{data.gradeLevel}</Text>
              </View>
              <View style={[styles.infoValue, { width: '9%' }]}>
                <Text>{data.className}班</Text>
              </View>
              <View style={[styles.infoValueGreen, { width: '8%' }]}>
                <Text>{String(data.seatNo).padStart(2, '0')}號</Text>
              </View>
            </View>

            <View style={styles.body}>
              <View style={styles.leftCol}>
                <ScoreTable terms={data.terms} styles={styles} BORDER={BORDER} labels={labels} config={config} scoreColWidth={scoreColWidth} />
              </View>
              <View style={styles.rightCol}>
                <AttendanceDisciplinePanel terms={data.terms} styles={styles} BORDER={BORDER} labels={labels} />
              </View>
            </View>

            <View style={[styles.remarkBox, { borderTop: BORDER }]}>
              <Text style={styles.remarkLabel}>{labels.remark}</Text>
              <Text style={styles.remarkText}>{data.remark}</Text>
            </View>
          </View>

          {/* 列印日期：最右邊直式，比照樣本用中文數字 */}
          <View style={styles.dateStrip}>
            <Text style={styles.dateStripText}>{formatPrintDate(data.printedAt)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
