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

// 【2026-08-28 新增】反映事項「不同科目的年級…用最大科目的格數去排」：不同班級/
// 年級的實際科目數不一樣，改成不管哪個班，成績單一律照本校最大科目數固定排出
// 這麼多列（科目不夠的班級，多出來的列留空白），不再逐班動態縮放字級/列高去
// 剛好塞滿——比原本「依實際科目數縮放」單純、版面也不會因為班級科目多寡而跳動。
// 「出缺席」固定另外排最後1列，不算在10科的科目格數裡面（跟前面確認過的
// 「本校科目最多10科，加入出缺席共11科不會改變」一致）。
export const ATTENDANCE_SUBJECT_NAMES = ['全勤', '出缺席'];
export const MAX_REAL_SUBJECT_SLOTS = 10;
export const TOTAL_SUBJECT_SLOTS = MAX_REAL_SUBJECT_SLOTS + 1;

export type TermBlock = {
  ready: boolean;
  subjects: SubjectScoreRow[];
  academicAverage: { midterm: number | null; final: number | null; daily: number | null; total: number | null };
  attendance: Record<'曠課' | '遲到' | '病假' | '事假' | '公假', number>;
  isPerfectAttendance: boolean;
  attendanceScore: number;
  discipline: Record<'嘉獎' | '小功' | '大功' | '警告' | '小過' | '大過', number>;
  conduct: { politeness: number | null; dress: number | null; service: number | null; discipline: number | null; overall: number | null };
  // 這學期各項獎懲（嘉獎/小功/大功/警告/小過/大過）依後台設定的加扣分點數換算後的
  // 總和（例如嘉獎x1 + 警告x1 = +1-1 = 0），操行成績（conduct.overall）已經把這個
  // 數字加進去了，這裡另外存一份原始值只是為了能在成績單上（不管 PDF 或 Word 合併
  // 列印）「秀出這個中間值」，讓人看得出操行總分是怎麼算出來的，不用改到
  // conduct.overall 本身的算法。
  disciplineAdjustment: number | null;
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
    // 【2026-08-23 依「成績單正反.xlsx」實際儲存格底色/字色核對後修正】原本
    // yearBoxBg是藍色、termBoxBg是另一種偏灰的綠色，但樣本檔案裡「2862學年度」
    // 跟「下學期」這兩格其實是同一種鮮綠色（Excel色碼 92D050），不是一藍一綠、
    // 也不是這裡原本用的偏灰綠——這裡兩個都改成 92D050。同一批也發現「99號」
    // 那格（infoValueGreenBg）原本用的也是那個偏灰綠，樣本其實也是同一種92D050，
    // 一併修正；另外樣本這幾格字的顏色也跟原本預設的黑色不同：「2862學年度下學期」
    // 是藍字、「99號」是紅字、「高三／忠班」也是藍字，這幾個顏色會在下面 JSX
    // 那幾個 <Text> 直接加 color，不放在這個共用色票裡（因為只有這幾個字要上色，
    // 其他大部分文字還是黑色，放共用色票反而不好對應）。
    yearBoxBg: '#92D050',
    termBoxBg: '#92D050',
    infoValueBg: '#FFF2CC',
    infoValueGreenBg: '#92D050',
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

// 內頁左表（科目成績）跟右側面板（出席/懲獎記錄）的寬度比例，依「成績單正反.xlsx」
// 樣本核對出來的常數（見下面 buildStyles() 裡 leftCol/rightCol 的說明）。獨立拉出來
// 是因為「導師評語」框（remarkBox）的寬度要跟左表對齊到同一條格線，兩個地方共用
// 同一組常數，之後如果比例要再調整，只需要改這裡一個地方。
const LEFT_COL_FLEX = 1.362;
const RIGHT_COL_FLEX = 1;

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
      // 【2026-08-23 依「成績單正反.xlsx」欄寬逐格核對後修正】原本 schoolName:yearBox:
      // termBox:titleBox 的比例是 3:1:1:1.4，跟樣本檔案實際合併儲存格的欄寬比例
      // （3.75:1:0.83:1.25）對不太起來——尤其 termBox（下學期）樣本其實比 yearBox
      // （學年度）窄一些，不是原本以為的一樣寬。這裡照樣本比例調整。
      schoolName: { flex: 3.75, textAlign: 'center', fontSize: config.sizes.titleFontSize, fontWeight: 700, padding: 10, justifyContent: 'center' },
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
        flex: 0.83,
        textAlign: 'center',
        fontSize: config.sizes.headerFontSize,
        fontWeight: 700,
        padding: 10,
        backgroundColor: config.colors.termBoxBg,
        borderLeft: BORDER,
        justifyContent: 'center',
      },
      titleBox: { flex: 1.25, textAlign: 'center', fontSize: config.sizes.titleFontSize, fontWeight: 700, padding: 10, borderLeft: BORDER, justifyContent: 'center' },

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
        // padding 比 infoValue 小一點：「99號」三個字在這麼窄的欄位（6%）裡，
        // 原本沿用 infoValue 的 padding: 8 會擠到自動換行變成「99-\n號」，樣本
        // 檔案裡這格其實是一行顯示完，這裡把左右內距縮小讓它塞得下一行。
        padding: 4,
        fontSize: base * 1.3,
        fontWeight: 700,
        backgroundColor: config.colors.infoValueGreenBg,
        justifyContent: 'center',
        textAlign: 'center',
      },

      body: { flexDirection: 'row', flex: 1 },
      // 【2026-08-23 依「成績單正反.xlsx」欄寬逐格核對後修正】左表（科目成績）：右側面板
      // （出席／懲獎記錄）原本的比例是 1.55:1，跟樣本檔案實際欄寬比例（1.362:1）有落差，
      // 這裡照樣本調整，右側面板變得比原本略寬一些。
      leftCol: { flex: LEFT_COL_FLEX, borderRight: BORDER },
      rightCol: { flex: RIGHT_COL_FLEX },

      pageInner: { flexDirection: 'row', flex: 1 },
      // 【2026-09-03 修正】反映事項「最右側的日期字體請左轉90度並放大分散對齊」：
      // 原本用單一個 Text（寬340、字級只有 base*1.04）整串轉90度，結果那一串文字
      // 只集中在整個直式色帶的中段一小塊，字也偏小。現在：
      // 1. dateStrip 加寬（26→36），讓放大後的字轉90度不會被裁掉。
      // 2. dateStripRotated 改成「先在轉90度以前排成一列（寬度＝色帶實際可用高度
      //    DATE_STRIP_ROTATED_LENGTH）、每個字用 justifyContent:'space-between'
      //    平均撐開」，轉90度以後才會是「文字放大、而且整條色帶從上到下平均分散
      //    對齊」，不是只集中一小段。
      dateStrip: { width: 36, borderLeft: BORDER, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
      dateStripRotated: {
        width: DATE_STRIP_ROTATED_LENGTH,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        // 【2026-09-03 修正・二】反映事項「【公元二〇二六年九月三日】逐字向左旋轉
        // 90度,變成直書」：user 兩次都明確指定「向左」，從 rotate(90deg)（順時針）
        // 改成 rotate(-90deg)（逆時針／向左）。逐字＝每個字各自的字元都會跟著整個
        // 容器一起轉90度（每個字都是獨立的 <Text>，見下面 dateStripChar 的用法），
        // 變成直書＝仍然用 flexDirection:'row'+justifyContent:'space-between' 讓
        // 轉90度以後文字沿著色帶由上到下分散對齊。
        transform: 'rotate(-90deg)',
      },
      dateStripChar: { fontSize: base * 1.75, fontWeight: 700 },

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

      attnItemCol: { width: '21.17%' },
      attnValCol: { width: '26.28%' },
      // 【2026-08-23 新增】給「全班人數／全班名次」那一列合併用：這一列的標籤
      // 「全班人數」「全班名次」是4個中文字，如果只用跟「項目」欄一樣寬的
      // attnItemCol（本來是給「曠課」這種2個字的標籤用），會塞不下、跟旁邊的
      // 數值文字疊在一起。改成標籤格併「項目＋上學期」兩欄的寬度（給4個字
      // 足夠空間），數值格併「下學期＋合計」兩欄的寬度——併的還是同一組格線
      // 上的欄位，只是併法不同，最終這一列的左緣/中線/右緣還是精準對在
      // 「項目/上學期/下學期/合計」表頭同樣的格線上，不會跟上面的格線對不齊。
      attnLabelWideCol: { width: `${21.17 + 26.28}%` },
      attnValGroupCol: { width: `${26.28 * 2}%` },

      // 【2026-09-03 修正】反映事項「導師/訓導/教務/校長簽章下面現在都分別有兩列，
      // 請合併成一列」：上一輪為了讓簽章欄中間的垂直分隔線「延伸到下一格」，在簽章
      // 標籤格下面另外接了一個延伸格，兩個各自有邊框的格子疊在一起，看起來變成
      // 兩列。這裡把 signBox 自己的 borderBottom 拿掉（下面延伸格改成不畫
      // borderTop，見 AttendanceDisciplinePanel／ReportCardDocument 主體），兩塊
      // 中間就不會再有一條橫線把它們切成兩列，垂直分隔線還是照樣整條貫穿到底，
      // 視覺上合併成一列。
      // 【2026-09-03 修正・二】反映事項「導師/訓導/教務/校長簽章也向下擴大成兩列」：
      // 上一輪拿掉了 signBox 的 borderBottom，讓簽章標籤格跟下面的簽名延伸格合併成
      // 一個沒有分隔線的長方格；這次改回來，把 borderBottom 加回來，簽章格重新變回
      // 「上面是標籤列、下面是簽名留白列」兩個有分隔線的列，延伸格那邊同步補回
      // borderTop（見下面 sign-ext 那個 View），兩條線加起來剛好是同一條分隔線。
      signBox: { flex: 1, borderLeft: BORDER, borderTop: BORDER, borderBottom: BORDER, minHeight: 50, padding: 5, justifyContent: 'flex-start' },
      signLabel: { fontSize: base, fontWeight: 700, textAlign: 'center' },

      // 【2026-08-23 修正】原本 minHeight:70，評語文字一長就會把框「撐高」，進而把
      // 整張內頁撐過一頁（見上面 fitRemarkFontSize 的說明）。改成固定 height（不是
      // minHeight）+ overflow:'hidden'，框本身永遠是這個高度，不會再被內容撐大，
      // 配合文字自動縮字級/必要時截斷，保證內頁永遠剛好一頁。
      // 【2026-08-25 依回饋修正】原本這裡沒有設定寬度，預設吃滿整列（跟左表+右側
      // 出席/懲獎面板加起來一樣寬），評語框看起來像是延伸到「出席記錄」欄位底下。
      // 改成只到「學年成績」欄（左表最右一欄）跟「出席記錄」（右側面板最左欄）
      // 中間那條格線為止，寬度比例跟 leftCol/rightCol 用同一組常數換算，兩邊改
      // 版面比例時（例如以後樣本欄寬再調整）這裡會自動跟著對齊，不用另外維護
      // 一個寫死的百分比。右邊（原本 rightCol 底下）留白，不畫格線也不放文字。
      remarkBox: { width: `${(LEFT_COL_FLEX / (LEFT_COL_FLEX + RIGHT_COL_FLEX)) * 100}%`, height: REMARK_BOX_HEIGHT, padding: 6, overflow: 'hidden', borderRight: BORDER },
      remarkLabel: { fontSize: base, fontWeight: 700, marginBottom: 3 },
      remarkText: { fontSize: base, lineHeight: 1.5 },
    }),
  };
}

// 【2026-08-23 依你附的「成績單正反.xlsx」逐格核對數字格式後修正】原本左表所有分數
// 欄位（不管是「上/下學期各自的期中/期末/平時/總分」還是「全學年」那一欄）通通共用
// 同一支函式：整數就印整數，不是整數就印到小數點後兩位。實際跟樣本檔案逐格核對
// 儲存格格式後發現，這其實是兩種不同的格式，樣本裡沒有混用：
// - 上/下學期各自的「期中/期末/平時/總分」八欄，儲存格格式都是「0」（無條件四捨五入
//   到整數，不顯示小數）——例如才藝總分 81.95 其實印出來是「82」、常識平時 51.5
//   印出來是「52」，不是原始小數。
// - 「全學年」那一欄（含操行成績/禮貌/衣著/服務/紀律的全學年平均）儲存格格式固定是
//   小數兩位（例如 85 印成「85.00」、75 印成「75.00」），不會因為剛好是整數就省略
//   小數點，跟上面「不是整數才印小數」的判斷剛好相反。
// 這裡拆成兩支函式：fmtRounded()用在前者（四捨五入到整數），annualTotal()／
// annualAverage()（下面兩支，专門給「全學年」欄用）改成固定 toFixed(2)。
function fmtRounded(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return String(Math.round(n));
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

// 【2026-08-23 用實際樣本數字核對出來的浮點數誤差修正】上面 Math.round(x*100)/100 這種
// 寫法在「剛好卡在0.5」的情況下，會因為 JavaScript 浮點數表示誤差而四捨五入錯方向——
// 例如才藝科目全學年平均應該是 (81.95+66.5)/2=74.225，正常四捨五入到小數兩位是
// 74.23，但 74.225 在電腦裡實際存成 74.224999999999994，乘以100取整反而變成74.22，
// 差了0.01分，跟樣本檔案（74.23）對不起來；同樣的問題也出現在華測科目
// （64.725 應為64.73，卻算成64.72）。這裡改用一個能修正這種浮點誤差的四捨五入
// 寫法：先用 toPrecision(15) 把乘以100之後多出來的浮點誤差「修圓」掉，再取整數。
function round2(n: number): number {
  return Math.round(Number((n * 100).toPrecision(15))) / 100;
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
// 【2026-08-25 依回饋修正】原本只要上/下學期任一學期有資料就會顯示那個學期的
// 總分/平均（缺另一半時直接顯示現有那學期的數字），這次回饋改成：只要下學期
// 還沒有資料，學年成績欄一律顯示空白，不要顯示「只有上學期」的數字——避免
// 看起來像是「這就是學年成績」造成誤會，等下學期資料真的登錄了，兩學期都有
// 資料的時候才計算並顯示學年成績（上下學期簡單平均）。
function annualTotal(subject: string, terms: ReportCardData['terms']): string {
  const spring = terms.上學期?.subjects.find((x) => x.subject === subject)?.total;
  const fall = terms.下學期?.subjects.find((x) => x.subject === subject)?.total;
  if (spring == null || fall == null) return '';
  return round2((spring + fall) / 2).toFixed(2);
}

// 通用版的「兩學期平均」，給學業平均/操行成績這幾列（不是逐科目、是單一數字）用。
// 【2026-08-25 依回饋修正】同上，兩學期都有資料才顯示，否則空白。
function annualAverage(spring: number | null | undefined, fall: number | null | undefined): string {
  if (spring == null || fall == null) return '';
  return round2((spring + fall) / 2).toFixed(2);
}

// 【2026-08-23 新增】導師評語自動縮字：對應「請控制好大小，讓正、反面永遠維持
// 一頁」——這個框本來是 minHeight:70（內容多了就自動長高），內頁其他部分
// （科目成績表/出缺席懲獎表）已經是固定版面，評語框一旦被長文字撐高，就會把
// 整張內頁的總高度撐過一張 A4，react-pdf 偵測到放不下時會自動另開一頁接著印，
// 變成「內頁變兩頁」，跟外頁（永遠剛好一頁）合起來就不是「正反面各一頁」了。
// 改成把框高度固定住（見下面 ReportCardDocument 裡 remarkBox 的 height + 
// overflow:'hidden'），配合這裡依字數換算出的字級，讓文字自動縮小去塞進固定
// 高度的框裡；真的多到縮到最小字級還放不下，直接截斷加「…」，寧可看不到
// 導師評語的最後幾句，也不要讓整份成績單多印出一頁。這幾個字數級距是實際用
// pdftoppm 把渲染結果轉成圖片、逐一核對排版後校準出來的，不是憑感覺猜的門檻。
// 【2026-08-23 新增】科目名稱字級：現在中文字可以正常逐字換行了（見 pdfFonts.ts
// 的修正說明），連帶讓「出缺席」這種3個字的科目名稱，在原本只給2個字寬度設計
// 的科目欄（跟「國文」「英文」這些2字科目共用同一欄寬）裡，從「勉強塞好」
// 變成「真的換行成出缺／席兩行」——換行本身沒有錯（是文字排版引擎修好之後
// 的正常行為），但2個字硬被拆成兩行看起來很怪。科目欄寬度是照學校 Excel
// 範本比例校準過的，不能因為單一科目名稱而任意加寬，所以改成：3個字以上的
// 科目名稱字級稍微縮小一點，讓它塞在原本的欄寬內還是維持一行，2個字的科目
// 名稱不受影響、字級跟以前一樣。
function subjectLabelFontSize(name: string, base: number): number {
  if (name.length >= 4) return base * 0.72;
  if (name.length >= 3) return base * 0.82;
  return base;
}

// 【2026-08-25 依「導師評語欄位只到學年成績/出席紀錄中間格線」的回饋修正】
// remarkBox 寬度從原本「跟外層一樣寬（100%）」改成只到左表（leftCol）右緣
// 為止（見上面 remarkBox 樣式），寬度縮成原本的 LEFT_COL_FLEX/(LEFT_COL_FLEX+
// RIGHT_COL_FLEX) ≈ 57.7%。同一個字級在變窄的框裡，一行能放的字數會等比例
//變少，原本用「整個外層寬度」校準出來的字數級距（60/100/150/210/260）如果
// 照舊沿用，長一點的評語會在變窄的框裡換行換更多行，超出固定高度（66pt）、
// 又撐出下一頁——已經實際用 pdftoppm 渲染驗證過這個回歸（評語變成印到第3頁）。
// 這裡把每個字級距，跟著寬度縮小的同一個比例（REMARK_WIDTH_RATIO）等比例
// 縮小，讓「這個字數大概能在一行放幾個字」的假設跟新的框寬重新對上。
const REMARK_WIDTH_RATIO = LEFT_COL_FLEX / (LEFT_COL_FLEX + RIGHT_COL_FLEX);
// 導師評語框（remarkBox）固定高度，跟 styles.remarkBox 的 height 共用同一個值
// （見下面 buildStyles 內的 remarkBox 樣式）。右側面板「導師/訓導/教務/校長簽章」
// 那一列下面延伸的分隔線（AttendanceDisciplinePanel 裡的簽章延伸列）也要對到
// 同一個高度，兩處共用這個常數才不會各自寫死、之後改高度時漏改其中一處。
const REMARK_BOX_HEIGHT = 66;
// 最右側直式日期色帶：文字轉90度前的「列寬」，決定轉90度後文字實際撐開的高度。
// 頁面是 A4 橫向（595.28pt 高）、styles.page 的 padding 是 12（見 buildStyles），
// 可用高度約 595.28-12*2≈571；這裡抓 520，讓文字幾乎撐滿整條色帶又留一點邊界，
// 不會頂到頁面上下邊。
const DATE_STRIP_ROTATED_LENGTH = 520;
function fitRemarkFontSize(text: string): number {
  const len = text.length;
  if (len <= 60 * REMARK_WIDTH_RATIO) return 11;
  if (len <= 100 * REMARK_WIDTH_RATIO) return 9.5;
  if (len <= 150 * REMARK_WIDTH_RATIO) return 8.5;
  if (len <= 210 * REMARK_WIDTH_RATIO) return 7.5;
  return 6.5;
}
// 字級縮到最小（6.5）大概還能塞下的字數上限，超過就直接截斷——避免評語真的
// 異常長（例如貼了一整段文章）時，就算用最小字級還是會溢出固定高度的框。
// 跟上面同理，也依 REMARK_WIDTH_RATIO 等比例縮小。
const REMARK_MAX_CHARS = Math.round(260 * REMARK_WIDTH_RATIO);
function truncateRemark(text: string): string {
  if (text.length <= REMARK_MAX_CHARS) return text;
  return text.slice(0, REMARK_MAX_CHARS - 1) + '…';
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
  const allSubjects = primary?.subjects ?? [];
  const base = config.sizes.baseFontSize;
  // 【2026-08-28 依回饋改為固定列數，取代原本逐班動態縮放（denseScale）那套】
  // 不再依「這個班實際有幾科」去決定要不要縮放/縮放多少——固定照本校最大
  // 科目數（10科，不含出缺席）排出10個科目列位置，科目數不足的班級後面幾列
  // 留空白；出缺席永遠固定排在第11列（不管這個班實際有幾科真實科目）。
  // 【2026-08-29 修正】字級縮放本身還是需要的（見下面 FIXED_DENSE_SCALE），
  // 只是从「依每班科目數各自變動」改成「所有班級固定用同一個倍率」——因為
  // 現在科目格數固定是11格，不會再逐班變動，縮放倍率自然也就變成一個固定
  // 常數，不需要每次重新計算，這才是「單純、不會因班級而跳動」這個目標
  // 真正該做的事；完全不縮放反而會讓固定11列擠不進一頁（見下方說明）。
  // 萬一真的有班級科目數超過10科（正常情況下不會），不裁掉真實資料，超出的
  // 部分照樣往下多印，只是版面不保證剛好塞滿一頁——以「不遺漏資料」為優先。
  const realSubjects = allSubjects.filter((s) => !ATTENDANCE_SUBJECT_NAMES.includes(s.subject));
  const attendanceSubject = allSubjects.find((s) => ATTENDANCE_SUBJECT_NAMES.includes(s.subject)) ?? null;
  const realSlotCount = Math.max(MAX_REAL_SUBJECT_SLOTS, realSubjects.length);
  const subjectRows: (SubjectScoreRow | null)[] = [
    ...realSubjects,
    ...Array(Math.max(0, realSlotCount - realSubjects.length)).fill(null),
    attendanceSubject,
  ];
  // 【2026-08-28 改為固定列數，2026-08-29 修正：固定列數不代表可以不縮字級】
  // 上一輪誤判「11列不縮字級也能塞進一頁」，實際上一整頁（含反面）因此多印出
  // 第三頁、右側面板一些欄位（升留級/簽章/曠課...等）也跟著被擠到看不到——
  // 根因是 react-pdf 底層 Yoga 排版引擎不會把列高縮到比文字本身單行自然高度
  // 更矮，11列用「原始字級」的自然高度總和還是會超過可用高度。
  // 現在科目格數固定＝TOTAL_SUBJECT_SLOTS（11），不再逐班變動，所以這裡改成
  // 一個「固定的」縮小倍率常數（不是像舊版那樣依每班科目數即時計算），數值沿用
  // 舊版公式在 11 格時算出來的結果（9/11），每個班級都套用同一個倍率——這樣
  // 版面（字級、列高）在所有班級之間還是完全一致，只是這個「一致的字級」比
  // 後台設定的原始字級略小一點，用來確保固定11列一定塞得進一頁。
  const FIXED_DENSE_SCALE = TOTAL_SUBJECT_SLOTS <= 9 ? 1 : Math.max(0.5, 9 / TOTAL_SUBJECT_SLOTS);
  const denseFontSize = base * FIXED_DENSE_SCALE;
  const densePadding = Math.max(1, Math.round(3 * FIXED_DENSE_SCALE));
  return (
    // 【2026-08-24 修正，2026-08-28 改為固定11列】原本這裡是普通 <View>（不會撐滿
    // leftCol 拉伸後的高度，只會長到「內容自然高度」）。現在科目列表格固定就是
    // TOTAL_SUBJECT_SLOTS（11）列，外層包 flex:1，「科目列＋學業平均＋操行成績」
    // 這個固定11+1+5=17列的區塊用 flex 依比例分配 leftCol 可用高度（操行成績
    // 本身是5列，給 flex:5，其他每列 flex:1）——不管這個班實際有幾科真實科目，
    // 這個區塊永遠精準撐滿 leftCol 可用高度的100%，「紀律」的底線永遠等於
    // leftCol／rightCol 共用的那個容器底部，rightCol 用 flex:1 撐到底部的簽章列
    // 也就永遠精準對齊紀律。表頭兩列（科目/比重/上下學期/學年成績、期中/期末/
    // 平時/總分）跟期中期末平時比重列維持固定高度不參與縮放。
    <View style={{ flex: 1 }}>
      {/* 科目/比重/學期表頭 */}
      <View style={styles.row}>
        <View style={[styles.cellHeadFirst, styles.subjectCol, { justifyContent: 'center' }]}>
          <Text style={{ fontSize: 10, fontWeight: 700 }}>{labels.subject}</Text>
        </View>
        <View style={[styles.cellHead, styles.weightCol]}>
          <Text>{labels.weight}</Text>
        </View>
        {/* 【2026-08-23 修正格線對齊】這兩格原本寫死 39%，跟下面「期中/期末/平時/
            總分」四個小格實際寬度（scoreColWidth，依科目/比重/全學年欄位可調整後
            自動算出來的剩餘寬度平分）對不起來——兩者沒有用同一個數字來源，
            8.33+8.33+39+39+16.67 加起來甚至超過100%，導致這一列（連同同一列裡的
            科目/比重/學年成績）被引擎整列等比例縮小，跟下面所有列的格線對不齊。
            改成跟下面一樣用 scoreColWidth*4 計算，兩者永遠是同一個數字，格線永遠對齊。 */}
        <View style={[styles.cellHead, { width: `${scoreColWidth * 4}%` }]}>
          <Text>上學期</Text>
        </View>
        <View style={[styles.cellHead, { width: `${scoreColWidth * 4}%` }]}>
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

      {/* 科目列：固定 TOTAL_SUBJECT_SLOTS(11)列——前 MAX_REAL_SUBJECT_SLOTS(10)列是
          真實科目（不夠10科的班級後面補空白列），最後1列固定是出缺席（沒有資料
          時也是空白列，不會整列消失，版面不會因此跳動）。 */}
      {subjectRows.map((s, idx) => {
        const fall = s ? terms.下學期?.subjects.find((x) => x.subject === s.subject) : undefined;
        return (
          <View style={[styles.row, { flex: 1, minHeight: 0, overflow: 'hidden' }]} key={s?.subject ?? `blank-${idx}`}>
            <View style={[styles.cellLeftLabel, styles.subjectCol, { padding: densePadding }]}>
              <Text style={{ fontSize: subjectLabelFontSize(s?.subject ?? '', denseFontSize) }}>{s?.subject ?? ''}</Text>
            </View>
            <View style={[styles.cell, styles.weightCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? pct(s.weight) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(s.midterm) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(s.final) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(s.daily) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(s.total) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(fall?.midterm) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(fall?.final) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(fall?.daily) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? fmtRounded(fall?.total) : ''}</Text>
            </View>
            <View style={[styles.cell, styles.annualCol, { fontSize: denseFontSize, padding: densePadding }]}>
              <Text>{s ? annualTotal(s.subject, terms) : ''}</Text>
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
      <View style={[styles.row, { flex: 1, minHeight: 0, overflow: 'hidden' }]}>
        <View style={[styles.cellLeftLabel, { width: `${config.layout.subjectColWidthPercent + config.layout.weightColWidthPercent}%`, fontSize: denseFontSize, padding: densePadding }]}>
          <Text>{labels.academicAverage}</Text>
        </View>
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'sa' + k} style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
            <Text>{fmtRounded(terms.上學期?.academicAverage[k])}</Text>
          </View>
        ))}
        {(['midterm', 'final', 'daily', 'total'] as const).map((k) => (
          <View key={'fa' + k} style={[styles.cell, styles.scoreCol, { fontSize: denseFontSize, padding: densePadding }]}>
            <Text>{fmtRounded(terms.下學期?.academicAverage[k])}</Text>
          </View>
        ))}
        <View style={[styles.cell, styles.annualCol, { fontSize: denseFontSize, padding: densePadding }]}>
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
      <View style={{ flexDirection: 'row', borderBottom: BORDER, flex: 5, minHeight: 0, overflow: 'hidden' }}>
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
            <View style={[styles.cellLeftLabel, { flex: 1, minHeight: 0, overflow: 'hidden', padding: densePadding, fontSize: denseFontSize, borderBottom: i < 4 ? BORDER : 'none' }]} key={label}>
              <Text>{label}</Text>
            </View>
          ))}
        </View>

        {/* 上學期：分數(2欄寬) + 等第(2欄寬，貫穿五列)。
            【2026-08-25】這裡原本用 width 百分比分兩欄，但巢狀百分比寬度在
            react-pdf 沒有正確算出來，分數/等第中間的格線其實整條都沒畫出來
            （已用 pdftoppm 實際渲染確認過），改用 flex 分兩欄解決。
            【2026-08-26 依回饋修正】等第（丙/甲/乙...）格線要對齊「平時分」左緣，
            也就是分數格只佔「期中+期末」兩欄寬、等第格佔「平時+總分」兩欄寬，
            兩邊各半（flex:2 / flex:2）——不是之前那版對齊「平時分」右緣用的
            flex:3/flex:1。 */}
        <View style={{ width: `${scoreColWidth * 4}%`, flexDirection: 'row', borderLeft: BORDER }}>
          <View style={{ flex: 2, flexDirection: 'column' }}>
            {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
              <View key={key} style={{ flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
                <Text style={{ fontSize: denseFontSize }}>{fmtRounded(terms.上學期?.conduct[key])}</Text>
              </View>
            ))}
          </View>
          <View style={{ flex: 2, alignItems: 'center', justifyContent: 'center', borderLeft: BORDER }}>
            <Text style={{ fontSize: denseFontSize * 2.6, fontWeight: 700 }}>{conductGradeLabel(terms.上學期?.conduct.overall ?? null)}</Text>
          </View>
        </View>

        {/* 下學期：分數(2欄寬) + 等第(2欄寬，貫穿五列)，理由同上學期那一塊。 */}
        <View style={{ width: `${scoreColWidth * 4}%`, flexDirection: 'row', borderLeft: BORDER }}>
          <View style={{ flex: 2, flexDirection: 'column' }}>
            {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
              <View key={key} style={{ flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
                <Text style={{ fontSize: denseFontSize }}>{fmtRounded(terms.下學期?.conduct[key])}</Text>
              </View>
            ))}
          </View>
          <View style={{ flex: 2, alignItems: 'center', justifyContent: 'center', borderLeft: BORDER }}>
            <Text style={{ fontSize: denseFontSize * 2.6, fontWeight: 700 }}>{conductGradeLabel(terms.下學期?.conduct.overall ?? null)}</Text>
          </View>
        </View>

        {/* 全學年平均：跟其他列一樣，維持在最右邊 */}
        <View style={{ width: `${config.layout.annualColWidthPercent}%`, borderLeft: BORDER, flexDirection: 'column' }}>
          {(['overall', 'politeness', 'dress', 'service', 'discipline'] as const).map((key, i) => (
            <View key={key} style={{ flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderBottom: i < 4 ? BORDER : 'none' }}>
              <Text style={{ fontSize: denseFontSize }}>{annualAverage(terms.上學期?.conduct[key], terms.下學期?.conduct[key])}</Text>
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

// 【2026-08-27 依回饋改為「以科目序位對齊」，2026-08-28 改用固定科目格數】
// 右側面板（出席記錄／懲獎記錄／全班人數／升留級／簽章）用「第幾科」這種序位
// 直接對齊左表。因為左表現在已經改成固定 TOTAL_SUBJECT_SLOTS(11) 列（見
// ScoreTable／MAX_REAL_SUBJECT_SLOTS 的說明），這裡的「n+6 個等高單位」不再需要
// 依這個班實際科目數動態計算，n 直接固定＝TOTAL_SUBJECT_SLOTS：
//   曠課／遲到／病假／事假／公假／全勤　→ 對齊第1~6科（idx0＝0~5，共6格）
//   全班人數／全班名次　　　　　　　　　→ 對齊第7科起、占2格（idx0＝6~7）
//   升留級／家長簽章及建議　　　　　　　→ 對齊第9科（idx0＝8，占1格）
//   導師/訓導/教務/校長簽章　　　　　　→ 從「服務」列上緣開始（idx0＝n+4，服務排在
//     操行成績區塊第4列：操行成績(整體)/禮貌/衣著/服務/紀律 = idx0 n+1~n+5）
// 6+2+1＝9 格剛好無縫銜接（曠課~全勤6格、全班人數2格、升留級1格中間完全不用留空
// 隙），所以升留級列前面不用再算間隔；只有「簽章列」前面因為要跳過學業平均／
// 操行成績(整體)／禮貌／衣著這幾格才需要補一段間隔。
// 為了讓「曠課~全勤」這6格能從 idx0=0（跟左表科目第1列同一個起點）開始對齊，右側面板
// 自己的表頭（標題列＋項目/上學期/下學期/合計表頭列）也強制用跟左表一樣的
// LEFT_HEADER_FIXED_PT 固定高度（內部兩列各自 flex:1 均分），不再讓它們用內容自然高度，
// 這樣兩邊「科目列/曠課列」的上緣才會是同一個高度基準點。
// 【2026-08-30 修正】原本下面「曠課~全勤／全班人數／升留級／簽章」這幾個區塊
// 是各自用「絕對pt高度」（H_BODY_PT / LEFT_HEADER_FIXED_PT 這兩個常數換算出來）
// 排列，這批常數是先前用 pdftoppm 在「當時那個版面」下實際量出來的固定值——
// 只要頁面上其他任何地方的高度稍微變一點（例如這輪固定科目格數、字級縮放倍率
// 的調整），這批常數就會跟著失準，而且用 pdftoppm 實際渲染測試後發現，好幾個
// 各自獨立設定「絕對高度」的 View 疊在一起（曠課區塊/全班人數區塊/升留級區塊/
// 簽章列，四個各自寫死 height 的區塊）在 react-pdf 底層的排版引擎裡會出現版面
// 跟左表對不上、右側面板整批文字不畫出來的問題——不是內容真的不見，是量測用的
// 固定pt值跟頁面實際可用高度兜不起來所導致的排版錯誤。
// 改成完全不用絕對pt值：跟左表「科目列＋學業平均＋操行成績」那個區塊同一個
// 寫法——外層包一個 flex:1，裡面每個區塊各自用「flex 比例」（不是 height）分配
// 空間，比例直接對應「占幾格」（曠課~全勤6格→flex:6、全班人數2格→flex:2、
// 升留級1格→flex:1、間隔→flex:gapUnits、簽章→flex:signatureUnits）。因為
// leftCol／rightCol 是同一個 body 列（flexDirection:'row'）底下的兩個直欄，
// react-pdf 預設 alignItems:'stretch' 一定會把兩欄拉成同一個實際高度，所以
// 兩邊只要用「同一組17等分」的 flex 比例去切，不管實際可用高度是多少，切出來
// 的每一小格高度永遠會自動保持一致、精準對齊，不用再靠量測固定pt值去猜。
const LEFT_HEADER_FIXED_PT = 56.88;

function rightPanelLayout() {
  const n = TOTAL_SUBJECT_SLOTS; // 固定11（10科+出缺席），不再依班級實際科目數變動
  const units = n + 6; // 科目列(N) + 學業平均(1) + 操行成績區塊(5，含服務/紀律)
  const attendanceFlex = 6; // 曠課~全勤，對齊第1~6科
  const classSizeFlex = 2; // 全班人數/全班名次，對齊第7~8科（占2格）
  // 【2026-09-03 修正】反映事項「升留級/家長簽章及建議擴大成兩列(對齊第9.10科)」：
  // 從占1格（只對齊第9科）改成占2格，對齊第9~10科（化學/體育，實際科目視班級
  // 設定而定，這裡固定用「科目列裡的第9、10格」）。
  const promotionFlex = 2;
  const consumedBeforeSignature = attendanceFlex + classSizeFlex + promotionFlex; // 10
  // 「服務」在左表 n+6 個單位裡的序位（0-indexed）＝科目(n) + 學業平均(1) +
  // 操行成績(整體,1) + 禮貌(1) + 衣著(1) ＝ n+4；固定11格時這個序位一定大於
  // consumedBeforeSignature，Math.max(...,0) 當保險，避免萬一以後
  // TOTAL_SUBJECT_SLOTS 改小時算出負值。
  const serviceIdx0 = n + 4;
  const gapFlex = Math.max(serviceIdx0 - consumedBeforeSignature, 0);
  const signatureFlex = Math.max(units - consumedBeforeSignature - gapFlex, 1);
  return { attendanceFlex, classSizeFlex, promotionFlex, gapFlex, signatureFlex };
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
  // 【2026-08-22】全勤原本是獨立另外一列，排在曠課/遲到/病假/事假/公假這五列的
  // 後面、還隔了一個空白列（因為原本的迴圈跑6次但 attnKeys 只有5項，第6次是空的，
  // 全勤是另外加的第7列）。照你附的樣本檔案，全勤其實是跟其他五項同一欄、緊接在
  // 公假下面的第6項，不是另外分開的一列——這裡把 attnKeys 補上「全勤」變成6項，
  // 跟懲獎那邊剛好6項（嘉獎/小功/大功/警告/小過/大過）對齊，迴圈跑到第6次時改成
  // 顯示「是/否」文字而不是次數，下面原本另外寫的那一整塊全勤列就拿掉了。
  const attnKeys = ['曠課', '遲到', '病假', '事假', '公假', '全勤'] as const;
  const discKeys = ['嘉獎', '小功', '大功', '警告', '小過', '大過'] as const;
  const layout = rightPanelLayout();

  return (
    // 【2026-08-23 修正】原本這個 View 沒有 flex:1，本身只會長到「內容自然高度」，
    // 但外層 rightCol（body 這個 row 的 alignItems 預設 stretch）會被拉伸到跟
    // leftCol（科目成績表，內容通常比較高）一樣高，兩者高度對不上時，rightCol
    // 底下就會多出一截空白，導師/訓導/教務/校長簽章那一列因此没有跟著往下延伸到
    // 跟左邊「操行成績」那個區塊（科目成績表最後一列）齊平，最後一條橫線也就對不齊。
    // 加上 flex:1 讓這個 View 真的撐滿 rightCol 拉伸後的高度，多出來的空間交給
    // 下面「簽章列」（也加了 flex:1）去吸收——簽章格本來就需要留白給人簽名，
    // 這樣同時解決「格線對齊」跟「簽名空間太小」兩件事。
    <View style={{ flex: 1 }}>
      {/* 【2026-08-27】表頭（標題列＋項目/上學期/下學期/合計列）強制跟左表表頭
          用同一個 LEFT_HEADER_FIXED_PT 高度，內部兩列各自 flex:1 均分——這樣
          底下「曠課」那一列的上緣，才會跟左表「科目1」列的上緣切齊在同一個高度。 */}
      <View style={{ height: LEFT_HEADER_FIXED_PT }}>
        <View style={[styles.row, { flex: 1 }]}>
          <View style={[styles.sectionTitle, { width: '50%' }]}>
            <Text>{labels.attendanceRecordTitle}</Text>
          </View>
          <View style={[styles.sectionTitle, { width: '50%', borderLeft: BORDER }]}>
            <Text>{labels.disciplineRecordTitle}</Text>
          </View>
        </View>
        <View style={[styles.row, { flex: 1 }]}>
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
      </View>

      {/* 【2026-08-30】曠課~簽章這一整塊，改成跟左表「科目列＋學業平均＋操行成績」
          同一個寫法：外層包一個 flex:1，裡面每個區塊各自用 flex 比例（不是絕對pt高度）
          分配空間——比例直接對應「占幾格」，理由見上面 rightPanelLayout() 的說明。 */}
      <View style={{ flex: 1 }}>
        {/* 曠課／遲到／病假／事假／公假／全勤：對齊左表第1~6科（idx0＝0~5），
            flex:6，內部6列各自flex:1均分。 */}
        <View style={{ flex: layout.attendanceFlex }}>
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const attnKey = attnKeys[i];
            const discKey = discKeys[i];
            const isPerfectRow = attnKey === '全勤';
            const springV = isPerfectRow ? undefined : attnKey ? spring?.attendance[attnKey as '曠課' | '遲到' | '病假' | '事假' | '公假'] : undefined;
            const fallV = isPerfectRow ? undefined : attnKey ? fall?.attendance[attnKey as '曠課' | '遲到' | '病假' | '事假' | '公假'] : undefined;
            const total = (springV ?? 0) + (fallV ?? 0);
            const dSpringV = spring?.discipline[discKey];
            const dFallV = fall?.discipline[discKey];
            const dTotal = (dSpringV ?? 0) + (dFallV ?? 0);
            return (
              <View style={[styles.row, { flex: 1, minHeight: 0 }]} key={i}>
                <View style={[styles.cellLeftLabel, styles.attnItemCol]}>
                  <Text style={{ fontSize: styles.cellLeftLabel.fontSize }}>{attnKey ?? ''}</Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>
                    {isPerfectRow ? (spring ? (spring.isPerfectAttendance ? '是' : '否') : '') : attnKey ? springV ?? '' : ''}
                  </Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>
                    {isPerfectRow ? (fall ? (fall.isPerfectAttendance ? '是' : '否') : '') : attnKey ? fallV ?? '' : ''}
                  </Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>
                    {isPerfectRow ? [spring, fall].filter((t) => t?.isPerfectAttendance).length || '' : attnKey ? total : ''}
                  </Text>
                </View>
                <View style={[styles.cellLeftLabel, styles.attnItemCol, { borderLeft: BORDER }]}>
                  <Text style={{ fontSize: styles.cellLeftLabel.fontSize }}>{discKey}</Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>{dSpringV ?? ''}</Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>{dFallV ?? ''}</Text>
                </View>
                <View style={[styles.cell, styles.attnValCol]}>
                  <Text style={{ fontSize: styles.cell.fontSize }}>{dTotal}</Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* 全班人數／全班名次：對齊左表第7~8科（idx0＝6~7），flex:2（占2格），細項
            「上學期」「下學期」各自對齊第7科／第8科（各佔內部flex:1，即1格）。
            【2026-09-02 修正】這個 row 跟底下巢狀的 attnValGroupCol／內部兩個
            上下學期小格，原本都沒有 minHeight:0——跟 ScoreTable 科目列（line 610）
            同一個 react-pdf/Yoga「flex 子項預設 minHeight:auto（＝内容自然高度）
            不會真的縮到 flex 比例算出來的高度」的已知問題，沒補 minHeight:0 的
            這幾層在只有短短一兩行文字內容時，量測階段量到的「內容自然高度」還
            看不出明顯異常，但只要跟下面「升留級」列同一種寫法放在一起比對，
            或字級/欄寬設定一變動，一樣會出現跟左表對不齊的情形；這裡統一加
            minHeight:0，確保永遠精準吃到 flex 比例分配到的高度，不受內容自然
            高度影響。 */}
        <View style={{ flex: layout.classSizeFlex, flexDirection: 'row', minHeight: 0 }}>
          <View style={[styles.sectionTitle, styles.attnLabelWideCol, { minHeight: 0 }]}>
            <Text style={{ fontSize: styles.sectionTitle.fontSize }}>{labels.classSize}</Text>
          </View>
          <View style={[styles.attnValGroupCol, { borderLeft: BORDER, minHeight: 0 }]}>
            <View style={{ borderBottom: BORDER, padding: 2, flex: 1, minHeight: 0, justifyContent: 'center' }}>
              <Text style={{ fontSize: 7 }}>上學期 {spring?.classSize ?? ''}</Text>
            </View>
            <View style={{ padding: 2, flex: 1, minHeight: 0, justifyContent: 'center' }}>
              <Text style={{ fontSize: 7 }}>下學期 {fall?.classSize ?? ''}</Text>
            </View>
          </View>
          <View style={[styles.sectionTitle, styles.attnLabelWideCol, { borderLeft: BORDER, minHeight: 0 }]}>
            <Text style={{ fontSize: styles.sectionTitle.fontSize }}>{labels.classRank}</Text>
          </View>
          <View style={[styles.attnValGroupCol, { borderLeft: BORDER, minHeight: 0 }]}>
            <View style={{ borderBottom: BORDER, padding: 2, flex: 1, minHeight: 0, justifyContent: 'center' }}>
              <Text style={{ fontSize: 7 }}>上學期 {spring?.classRank ?? ''}</Text>
            </View>
            <View style={{ padding: 2, flex: 1, minHeight: 0, justifyContent: 'center' }}>
              <Text style={{ fontSize: 7 }}>下學期 {fall?.classRank ?? ''}</Text>
            </View>
          </View>
        </View>

        {/* 升留級／家長簽章及建議：對齊左表第9~10科（idx0＝8~9），flex:2（占2格）——
            緊接在「全班人數/全班名次」後面，6(曠課~全勤)+2(全班人數)+2(升留級)＝10格
            剛好無縫接到「服務」列前面，不用再另外補間隔列。升留級目前無資料來源，
            「值」先留空白，標籤永遠顯示。
            【2026-09-03 修正】反映事項「升留級/家長簽章及建議擴大成兩列(對齊第9.10
            科),且上下方橫線補上,中間垂直線也補上。字體請跟【全班人數】相同」：
            從占1格（只對齊第9科）改成占2格（對齊第9~10科，用法跟上面 layout.
            promotionFlex 的修法一致）；外層這一列補上 borderTop／borderBottom
            （原本跟上面「全班人數」列、下面服務列之間都沒有實體邊框線，只是顏色
            交界看起來像線，這裡直接補真正的邊框）；「升留級」跟「家長簽章及建議」
            中間的垂直分隔線（borderLeft）維持，格子變高後這條線自然貫穿新的兩格
            高度；字體從原本自訂的 fontSize:8 改成跟「全班人數」同一個
            styles.sectionTitle（含灰底、粗體、置中），並排的「升留級」欄外觀
            (灰底＋sectionTitle 字體) 也跟著改成跟「家長簽章及建議」一致，兩欄
            風格統一、也符合「字體請跟全班人數相同」的要求。 */}
        <View style={{ flex: layout.promotionFlex, flexDirection: 'row', minHeight: 0, borderTop: BORDER, borderBottom: BORDER }}>
          <View style={[styles.sectionTitle, { flex: 1, minHeight: 0 }]}>
            <Text style={{ fontSize: styles.sectionTitle.fontSize }}>{labels.promotionStatus}</Text>
          </View>
          <View style={[styles.sectionTitle, { flex: 3, minHeight: 0, borderLeft: BORDER }]}>
            <Text style={{ fontSize: styles.sectionTitle.fontSize }}>{labels.parentSignature}</Text>
          </View>
        </View>


        {/* 簽章列：從左表「服務」列上緣開始（前面補 flex:gapFlex 的空白間隔），
            flex:signatureFlex 精準對齊左表最後一列（紀律）的底線。「垂直線延伸到
            下一格」（導師/訓導/教務/校長簽章中間3條分隔線，延伸進下面「導師評語」
            那一列的簽名留白欄）的部分，見下面 ReportCardDocument 主體、跟 remarkBox
            並排的 SignatureExtension——不能寫在這個 flex:1 的 body 區塊內，因為
            body 的總高度是跟 leftCol（ScoreTable，固定17格）精算過剛好對齊分配的，
            這裡再塞一個額外的固定高度區塊會把 body 撐高、擠出 leftCol／rightCol
            精準對齊的比例，甚至把整份成績單擠出第二頁——延伸線必須放在 body
            外面、跟 remarkBox 同一層、高度共用 REMARK_BOX_HEIGHT，才不會動到
            body 內部本來就已經精準對齊的比例。 */}
        {layout.gapFlex > 0 && <View style={{ flex: layout.gapFlex, minHeight: 0 }} />}
        <View style={[styles.row, { flex: layout.signatureFlex, minHeight: 0, borderBottom: 'none' }]}>
          {[labels.homeroomSign, labels.disciplineSign, labels.academicSign, labels.principalSign].map((label, i) => (
            <View key={label} style={[styles.signBox, i === 0 ? { borderLeft: 0 } : {}]}>
              <Text style={styles.signLabel}>{label}</Text>
            </View>
          ))}
        </View>
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

  // 【2026-08-22 依你附的「外頁修正.xlsx」逐格重排】這份檔案你已經精簡過表格結構，
  // 這次直接讀了合併儲存格範圍＋兩張內嵌圖片（校徽、校園照片，之前都是色塊佔位，
  // 這次直接把真正的圖檔抽出來放進來了：public/images/school-logo.png／
  // campus-photo.jpg）。對照樣本，版面分三個橫向區塊：
  //   上：左＝標題（泰文+中文）、中＝操行成績評量標準（標籤+5行級距）、右＝校徽
  //   中：左＝校園照片＋「敦品勵學／崇德養志」、中＝出缺席加扣分、右＝泰文+中文校名
  //   下：左＝班級/姓名/座號/學號、中＝學業成績計算方式→特殊表現計算方式（依序，
  //       這次的順序跟上一版不一樣：樣本裡是先出缺席、再學業佔比、最後才是獎懲，
  //       不是我上一輪猜的順序）
  // 校徽/校園照片如果你在【成績單樣式設定】頁另外上傳了圖片，會優先使用你上傳的，
  // 沒有上傳的話用這裡內建的真實校徽/校園照片（不再是色塊佔位）。
  // logoSrc／photoSrc：優先用管理員在【成績單樣式設定】頁上傳的圖片
  // （layout.logoUrl／campusPhotoUrl），沒有上傳的話，lib/reportCard.ts 的
  // getActiveReportCardStyle() 會自動補上系統內建的真實校徽/校園照片路徑
  // （public/images/school-logo.png／campus-photo.jpg）——這裡刻意不直接用
  // path.join(process.cwd(),...) 組路徑，是因為這個檔案會被 ReportCardStyleTab.tsx
  // （瀏覽器端的管理頁面）引用到型別定義，'path' 是 Node.js 專用模組，如果這裡
  // import 'path'，瀏覽器端的頁面會直接建置失敗——把「組路徑」這件事移到
  // lib/reportCard.ts（本來就是純伺服器端專用的檔案）處理，這裡只負責「有給圖就用，
  // 沒有就顯示色塊佔位」。
  const logoSrc = layout.logoUrl;
  const photoSrc = layout.campusPhotoUrl;

  return (
    <Page size="A4" orientation="landscape" style={{ padding: 20, fontFamily: 'NotoSansTC', fontSize: 9 }}>
      {/* 【2026-08-23 修正】原本是三個橫向色塊（18%/46%/36% 高），每個色塊裡面又
          各自切三欄，但三欄的寬度比例三個橫向色塊還兜不起來（第一個色塊是
          1:1.6:0.6，另外兩個是1:1.6:1），沒有一個是「三等分」。改成外頁就是三個
          等寬（各自 flex:1，剛好各佔1/3寬度）的直式欄位——即符合「正面三大區塊
          各1/3」的要求，也才是真正的「三折頁」（實際列印後沿兩條欄位分隔線對摺，
          會摺成三等分的折頁小冊子，不是單純的排版分區）。原本每個色塊內部「上
          （18%）／中（46%）／下（36%）」的高度比例維持不變，只是改成在每一欄
          內部各自往下堆疊，不是橫向切三塊。 */}
      {/* 【2026-08-24 依回饋修正】外頁文字全部放大、並統一改成置中對齊——原本標題／
          校名等少數幾處是置中，其餘（操行標準、出缺席加扣分、學業計算方式、班級
          姓名等資訊、校名區塊）都還是預設靠左（右折頁的校名區塊則是靠右
          alignItems:'flex-end'/textAlign:'right'），這次統一：每個區塊的容器都
          加上 alignItems:'center'，文字統一 textAlign:'center'，字級整體調大
          （約放大20~50%，依原本字級大小分別微調，優先保留原本的相對層級關係——
          標題還是最大、內文列表次之），並用這次同一份 pdftoppm 渲染流程確認在
          三個區塊各自的高度（18%／46%／36%）裡都還放得下、沒有溢出。 */}
      <View style={{ flexDirection: 'row', flex: 1 }}>
        {/* 左折頁：標題 → 校園照片 → 班級/姓名/座號/學號 */}
        <View style={{ flex: 1, paddingRight: 10 }}>
          <View style={{ height: '18%', alignItems: 'center' }}>
            <Text style={{ fontSize: 12, marginBottom: 3, fontFamily: 'NotoSansThai', textAlign: 'center' }}>หนังสือแจ้งผลการเรียน</Text>
            <Text style={{ fontSize: 23, fontWeight: 700, textAlign: 'center' }}>學生成績通知書</Text>
          </View>
          <View style={{ height: '46%', alignItems: 'center' }}>
            {photoSrc ? (
              <Image src={photoSrc} style={{ width: '100%', height: '82%', objectFit: 'cover', marginBottom: 4 }} />
            ) : (
              <View style={{ width: '100%', height: '82%', backgroundColor: '#BFD7EA', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <Text style={{ fontSize: 7, color: '#556' }}>（校園照片）</Text>
              </View>
            )}
            <Text style={{ fontSize: 15, fontWeight: 700, textAlign: 'center' }}>敦品勵學　崇德養志</Text>
          </View>
          <View style={{ height: '36%', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, lineHeight: 2.4, textAlign: 'center' }}>
              班級：　{data.gradeLevel}{data.className}{'\n'}
              姓名：　{data.studentName}{'\n'}
              座號：　{String(data.seatNo).padStart(2, '0')}{'\n'}
              學號：　{data.studentNo}
            </Text>
          </View>
        </View>

        {/* 中折頁：操行成績標準 → 出缺席加扣分 → 學業成績計算方式／特殊表現計算方式 */}
        <View style={{ flex: 1, paddingHorizontal: 10 }}>
          <View style={{ height: '18%', alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, textAlign: 'center' }}>操行成績標準：</Text>
            <Text style={{ fontSize: 10.5, lineHeight: 1.6, textAlign: 'center' }}>
              90分以上至100分者為優等{'\n'}
              80分以上不滿90分者為甲等{'\n'}
              70分以上不滿80分者為乙等{'\n'}
              60分以上不滿70分者為丙等{'\n'}
              不滿60分者為丁等（不及格）
            </Text>
          </View>
          <View style={{ height: '46%', alignItems: 'center' }}>
            <Text style={{ fontSize: 11.5, marginBottom: 4, textAlign: 'center' }}>
              出缺席加分及扣分{p.attendanceWeightPercent !== null ? `（佔學業成績比重 ${fmtPct(p.attendanceWeightPercent)}）` : ''}：
            </Text>
            <Text style={{ fontSize: 11.5, lineHeight: 1.9, textAlign: 'center' }}>
              {p.attendance.map((a) => `${a.name}\u3000${fmtScore(a.rawScore)} 分\u3000${fmtImpact(a.percentOfTotal)}`).join('\n')}
            </Text>
          </View>
          <View style={{ height: '36%', alignItems: 'center' }}>
            <Text style={{ fontSize: 10.5, marginBottom: 2, textAlign: 'center' }}>學業成績計算方式：</Text>
            <Text style={{ fontSize: 10.5, lineHeight: 1.5, marginBottom: 5, textAlign: 'center' }}>
              期中考 {fmtPct(p.academicWeights.midterm)}{'\n'}
              期末考 {fmtPct(p.academicWeights.final)}{'\n'}
              平時分 {fmtPct(p.academicWeights.daily)}
            </Text>
            <Text style={{ fontSize: 10.5, marginBottom: 2, textAlign: 'center' }}>特殊表現計算方式：</Text>
            <View style={{ flexDirection: 'row', width: '100%' }}>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 10.5, lineHeight: 1.5, textAlign: 'center' }}>
                  嘉獎 {p.conduct.merit1 !== null ? `+${p.conduct.merit1}` : '－'} 分{'\n'}
                  小功 {p.conduct.merit3 !== null ? `+${p.conduct.merit3}` : '－'} 分{'\n'}
                  大功 {p.conduct.merit9 !== null ? `+${p.conduct.merit9}` : '－'} 分
                </Text>
              </View>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 10.5, lineHeight: 1.5, textAlign: 'center' }}>
                  警告 {p.conduct.demerit1 ?? '－'} 分{'\n'}
                  小過 {p.conduct.demerit3 ?? '－'} 分{'\n'}
                  大過 {p.conduct.demerit9 ?? '－'} 分
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* 右折頁：校徽 → 泰文/中文校名 → （留白） */}
        <View style={{ flex: 1, paddingLeft: 10 }}>
          <View style={{ height: '18%', alignItems: 'center', justifyContent: 'flex-start' }}>
            {logoSrc ? (
              <Image src={logoSrc} style={{ width: 60, height: 60 }} />
            ) : (
              // logoSrc 沒有值（理論上 lib/reportCard.ts 的 getActiveReportCardStyle()
              // 已經會補上內建的真實校徽圖檔路徑，這裡的色塊只是最後一層保險，
              // 例如直接呼叫這個元件、沒有經過 getActiveReportCardStyle() 的情境）。
              <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#E8B4B8', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 6, textAlign: 'center' }}>校徽</Text>
              </View>
            )}
          </View>
          <View style={{ height: '46%', alignItems: 'center' }}>
            <Text style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', fontFamily: 'NotoSansThai' }}>โรงเรียนหัวหยุน</Text>
            <Text style={{ fontSize: 10, textAlign: 'center', marginBottom: 2, fontFamily: 'NotoSansThai' }}>โดย</Text>
            <Text style={{ fontSize: 10, textAlign: 'center', marginBottom: 8, fontFamily: 'NotoSansThai' }}>สมาคมยูนนาน จังหวัดเชียงราย</Text>
            <Text style={{ fontSize: 17, fontWeight: 700, textAlign: 'center' }}>清萊雲南會館附屬</Text>
            <Text style={{ fontSize: 17, fontWeight: 700, textAlign: 'center' }}>華雲學校</Text>
          </View>
          <View style={{ height: '36%' }} />
        </View>
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
  // 導師評語：依字數自動決定字級，並在極端情況下截斷，確保 remarkBox 固定高度
  // 塞得下（見 fitRemarkFontSize／truncateRemark 的說明）。
  const remarkDisplay = truncateRemark(data.remark ?? '');
  const remarkFontSize = fitRemarkFontSize(remarkDisplay);
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
                <Text style={{ color: '#0000FF' }}>
                  {data.academicYear} {labels.academicYearSuffix}
                </Text>
              </View>
              <View style={styles.termBox}>
                <Text style={{ color: '#0000FF' }}>{data.currentTerm}</Text>
              </View>
              <View style={styles.titleBox}>
                <Text>{labels.title}</Text>
              </View>
            </View>
            <View style={styles.infoRow}>
              {/* 【2026-08-23 依「成績單正反.xlsx」欄寬逐格核對後修正】原本這一列（學號／
                  學生姓名／班級座號）的欄寬比例是估算的，跟樣本檔案實際的欄寬不太一樣，
                  尤其「學生姓名：」那格明顯偏窄（原本8%，樣本其實是14.65%）、後面「高三／
                  忠班／99號」三格明顯偏寬（原本9%/9%/8%，樣本其實三格一樣寬、都是6.08%）。
                  這裡照樣本欄位的實際寬度比例重新對齊。 */}
              <View style={[styles.infoLabel, { width: '8%' }]}>
                <Text>學號：</Text>
              </View>
              <View style={[styles.infoValue, { width: '10%' }]}>
                <Text>{data.studentNo}</Text>
              </View>
              <View style={[styles.infoLabel, { width: '37%' }]} />
              <View style={[styles.infoLabel, { width: '15%' }]}>
                <Text>學生姓名：</Text>
              </View>
              <View style={[styles.infoValue, { width: '12%' }]}>
                <Text>{data.studentName}</Text>
              </View>
              <View style={[styles.infoValue, { width: '6%' }]}>
                <Text style={{ color: '#0000FF' }}>{data.gradeLevel}</Text>
              </View>
              <View style={[styles.infoValue, { width: '6%' }]}>
                <Text style={{ color: '#0000FF' }}>{data.className}</Text>
              </View>
              <View style={[styles.infoValueGreen, { width: '6%' }]}>
                <Text style={{ color: '#FF0000' }}>{String(data.seatNo).padStart(2, '0')}號</Text>
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

            {/* 導師評語（remarkBox，只跟 leftCol 同寬）＋簽章延伸列（只跟 rightCol
                同寬）並排成一整列，兩者共用 REMARK_BOX_HEIGHT 高度、底部對齊，讓
                「導師/訓導/教務/校長簽章」中間的垂直分隔線可以整條往下貫穿到底
                （簽章格所在那一列的說明見上面 AttendanceDisciplinePanel）。
                【2026-09-03 修正・二】反映事項「導師/訓導/教務/校長簽章也向下擴大
                成兩列」：上一輪把這裡跟上面簽章標籤格之間的橫線拿掉、合併成一個
                長方格；這次改回來，這一列補上 borderTop（跟 signBox 補回的
                borderBottom 是同一條線，兩層邊框疊在一起沒關係，PDF 畫出來還是
                一條線），簽章區重新變回「標籤列＋簽名留白列」上下兩列、中間有
                分隔線的樣子，垂直分隔線一樣整條貫穿兩列到底。 */}
            <View style={{ flexDirection: 'row', height: REMARK_BOX_HEIGHT }}>
              <View style={[styles.remarkBox, { borderTop: BORDER }]}>
                <Text style={styles.remarkLabel}>{labels.remark}</Text>
                <Text style={[styles.remarkText, { fontSize: remarkFontSize, lineHeight: 1.4 }]}>{remarkDisplay}</Text>
              </View>
              <View style={{ flex: RIGHT_COL_FLEX, flexDirection: 'row', borderTop: BORDER, borderBottom: BORDER }}>
                {[0, 1, 2, 3].map((i) => (
                  <View key={`sign-ext-${i}`} style={{ flex: 1, borderLeft: i === 0 ? 'none' : BORDER }} />
                ))}
              </View>
            </View>
          </View>

          {/* 列印日期：最右邊直式，比照樣本用中文數字。
              【2026-09-03 修正】改成逐字拆開排版＋轉90度＋分散對齊，見上面
              styles.dateStripRotated／dateStripChar 的說明。 */}
          <View style={styles.dateStrip}>
            <View style={styles.dateStripRotated}>
              {formatPrintDate(data.printedAt)
                .split('')
                .map((ch, i) => (
                  <Text key={i} style={styles.dateStripChar}>
                    {ch}
                  </Text>
                ))}
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
