import type * as XLSXNS from 'xlsx';
import { SPECIFIC_GRADE_LEVELS } from './gradeMapping';

// ⚠️ 這裡刻意不在檔案最上層直接 `import * as XLSX from 'xlsx'`。
// 'xlsx' 這個套件在 Node.js 環境（Next.js 產生靜態頁面/伺服器端渲染時）執行到它的模組載入程式碼
// 會直接丟出 `ReferenceError: self is not defined`，這是瀏覽器專用套件常見的問題。
// 只有在使用者實際按下「下載範本」按鈕時才需要用到這個套件，所以改成當下才動態 import，
// 確保它只會在瀏覽器裡執行，不會在建置(build)或伺服器端渲染時被載入。
let _xlsx: typeof XLSXNS | null = null;
async function loadXLSX(): Promise<typeof XLSXNS> {
  if (_xlsx) return _xlsx;
  try {
    _xlsx = await import('xlsx');
    return _xlsx;
  } catch (err: any) {
    // ChunkLoadError：瀏覽器要載入 'xlsx' 這個套件對應的 JS 檔案（webpack chunk）
    // 時失敗，最常見的原因是「網站剛部署過新版本，瀏覽器頁面還停留在舊版本」——
    // 新版本的 chunk 檔名（含 hash）跟瀏覽器記憶體裡的舊版本頁面所預期的不一樣，
    // 導致要下載的檔案在伺服器上已經不存在了。這種情況通常重新整理網頁（讀取最新
    // 版本的頁面）就能解決，不是每次都要清瀏覽器快取那麼麻煩，這裡幫使用者自動
    // 確認要不要重新整理，而不是讓他們看到一串英文錯誤訊息不知道要做什麼。
    const isChunkError = err?.name === 'ChunkLoadError' || /loading chunk/i.test(String(err?.message ?? ''));
    if (isChunkError && typeof window !== 'undefined') {
      const shouldReload = window.confirm(
        '下載功能需要的元件載入失敗，這通常是因為網站剛更新過版本、頁面還停留在舊版本造成的。\n\n是否要重新整理網頁後再試一次？'
      );
      if (shouldReload) {
        window.location.reload();
      }
    }
    throw err;
  }
}

function aoa(XLSX: typeof XLSXNS, rows: any[][]): XLSXNS.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}

function download(XLSX: typeof XLSXNS, wb: XLSXNS.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename);
}

/* ------------------------------------------------------------------ */
/* 1. 班級與導師設定                                                    */
/* ------------------------------------------------------------------ */
export const CLASSES_SHEET_NAME = '班級與導師設定';

export async function buildClassesSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['序號', '部別(年級)', '班級名稱', '合併名稱', '泰文代碼', '男生', '女生', '合計', '級任老師'],
    ['↓從第3列開始才是資料。年級請填具體年級（例如「1年」「初一」），級任老師打姓名即可，系統會自動建立', '', '', '', '', '', '', '', ''],
    [
      `⚠️ 年級欄位請務必從下面這份清單裡「照字打」，多一個字/少一個字（例如打成「初中一」）都會讓這個班級對不到部別、` +
        `對不到排課系統的年級，也會讓「科目與比重設定」抓不到對應資料：${SPECIFIC_GRADE_LEVELS.join('、')}`,
      '', '', '', '', '', '', '', '',
    ],
    [1, '1年', '忠班', '', '', 15, 13, 28, '王小明'],
    [2, '1年', '孝班', '', '', 14, 14, 28, '李美華'],
  ]);
}

export async function downloadClassesTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildClassesSheet(), CLASSES_SHEET_NAME);
  download(XLSX, wb, '班級與導師設定_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 2. 科目與比重設定                                                    */
/* ------------------------------------------------------------------ */
export const CURRICULUM_SHEET_NAME = '科目與比重設定';

export async function buildCurriculumSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  const header = ['學年度', '(保留)', '(保留)', '(保留)', '(保留)', '比重(0-1)', '節數', ...SPECIFIC_GRADE_LEVELS];
  const blankGrades = () => SPECIFIC_GRADE_LEVELS.map(() => '');
  const row1 = [2026, '', '', '', '', 0.2, 4, ...blankGrades()];
  const row2 = [2026, '', '', '', '', 0.2, 4, ...blankGrades()];
  // 示範：國語（1~6年）與數學（1~6年）兩科比重0.2、節數4節，其餘年級留空表示該年級沒有這科
  const gradeIdx = (g: string) => 7 + SPECIFIC_GRADE_LEVELS.indexOf(g);
  ['1年', '2年', '3年', '4年', '5年', '6年'].forEach((g) => {
    row1[gradeIdx(g)] = '國語';
    row2[gradeIdx(g)] = '數學';
  });
  return aoa(XLSX, [header, row1, row2]);
}

export async function downloadCurriculumTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildCurriculumSheet(), CURRICULUM_SHEET_NAME);
  download(XLSX, wb, '科目與比重設定_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 3. 整體佔比與加扣分規則                                              */
/* ------------------------------------------------------------------ */
export const GRADING_RULES_SHEET_NAME = '整體佔比與加扣分規則';

export async function buildGradingRulesSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['期中比重', '期末比重', '平時比重', '', '項目', '分數'],
    ['', '', '', '', '曠課', -1],
    [0.35, 0.35, 0.3, '', '遲到', -0.5],
    ['', '', '', '', '病假', 0],
    ['', '', '', '', '事假', 0],
    ['', '', '', '', '公假', 0],
  ]);
}

export async function downloadGradingRulesTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildGradingRulesSheet(), GRADING_RULES_SHEET_NAME);
  download(XLSX, wb, '整體佔比與加扣分規則_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 4. 既有學生快速建檔（精簡版）                                         */
/* ------------------------------------------------------------------ */
export const STUDENTS_IMPORT_SHEET_NAME = '既有學生快速建檔（精簡版）';

export async function buildStudentsImportSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['學年度', '學期', '年級', '班級', '學號', '姓名', '座號', '導師評語', '曠課', '遲到', '病假', '事假', '公假', '小功', '大功', '警告', '小過', '大過', '操行'],
    ['↓從第3列開始才是資料。曠課~大過等彙總欄位僅供參考，不會匯入系統', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    [2026, '上學期', '7年', '忠班', 'S10701', '王小明', 1, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ''],
    [2026, '上學期', '7年', '忠班', 'S10702', '李小華', 2, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ''],
  ]);
}

export async function downloadStudentsImportTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildStudentsImportSheet(), STUDENTS_IMPORT_SHEET_NAME);
  download(XLSX, wb, '既有學生快速建檔_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 5. 任課教師設定（class_schedule，不含星期/節次，僅「這班這科由誰教」）    */
/* ------------------------------------------------------------------ */
export const TEACHER_ASSIGNMENTS_SHEET_NAME = '任課教師設定';

export async function buildTeacherAssignmentsSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['學年度', '學期', '年級', '班級', '科目', '任課教師'],
    ['↓從第3列開始才是資料。任課教師打姓名即可，系統會自動建立/比對既有教師。這裡只設定「誰教哪班哪科」，星期/節次請到「學校課表」頁設定', '', '', '', '', ''],
    [2026, '上學期', '7年', '忠班', '國文', '陳老師'],
    [2026, '上學期', '7年', '忠班', '數學', '林老師'],
  ]);
}

export async function downloadTeacherAssignmentsTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildTeacherAssignmentsSheet(), TEACHER_ASSIGNMENTS_SHEET_NAME);
  download(XLSX, wb, '任課教師設定_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 5b. 學校課表（class_schedule，含星期/節次，完整每週課表）              */
/* ------------------------------------------------------------------ */
export const SCHOOL_TIMETABLE_SHEET_NAME = '學校課表';

export async function buildSchoolTimetableSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['學年度', '學期', '年級', '班級', '星期(一~六)', '節次', '科目', '任課教師'],
    ['↓從第3列開始才是資料。星期請填「一」「二」...「六」，任課教師打姓名即可，系統會自動建立/比對既有教師', '', '', '', '', '', '', ''],
    [2026, '上學期', '7年', '忠班', '一', 1, '國文', '陳老師'],
    [2026, '上學期', '7年', '忠班', '一', 2, '數學', '林老師'],
  ]);
}

export async function downloadSchoolTimetableTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildSchoolTimetableSheet(), SCHOOL_TIMETABLE_SHEET_NAME);
  download(XLSX, wb, '學校課表_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 5c. 帳號名單（app_users，供批次邀請/匯出使用）                        */
/* ------------------------------------------------------------------ */
export const ACCOUNTS_SHEET_NAME = '帳號名單';

export async function buildAccountsSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['姓名', '電子郵件', '角色', '初始密碼'],
    [
      '↓從第3列開始才是資料。角色請填：admin_a（系統管理員A）／admin_b（管理員B）／homeroom_teacher（班級導師）／subject_teacher（任課教師），實際能新增哪些角色要看您自己的身分權限。初始密碼：有填就直接建立帳號並設定這個密碼，不會寄任何信，對方可以馬上用這組密碼登入（建議之後自行更改）；不填則會改寄邀請信，請對方自行點連結設定密碼。若姓名跟既有教師資料一致，會自動連結（不會產生重複的老師資料）',
      '',
      '',
      '',
    ],
    ['王小明', 'teacher1@example.com', 'homeroom_teacher', 'Aa123456'],
    ['李美華', 'teacher2@example.com', 'subject_teacher', 'Bb123456'],
  ]);
}

export async function downloadAccountsTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildAccountsSheet(), ACCOUNTS_SHEET_NAME);
  download(XLSX, wb, '帳號名單_範本.xlsx');
}

// 「下載目前帳號名單」：改成跟批次上傳範本同樣的 4 欄格式（姓名/電子郵件/角色/初始密碼），
// 密碼欄一律留空（原本的密碼本來就無法讀出，也不應該讓明碼到處流通）——這樣下載下來的檔案
// 可以直接拿來對照、修改後再重新上傳（例如整批改角色），不用重新對照格式。
// 沒有任何帳號時（全新系統剛建置），直接退回範本（含範例列），才不會下載出一份空白到看不出格式的檔案。
export async function downloadAccountsList(users: { name: string; email: string | null; role: string }[]) {
  const XLSX = await loadXLSX();
  if (users.length === 0) {
    await downloadAccountsTemplate();
    return;
  }
  const rows = [
    ['姓名', '電子郵件', '角色', '初始密碼'],
    ...users.map((u) => [u.name, u.email ?? '（查無信箱）', u.role, '']),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoa(XLSX, rows), ACCOUNTS_SHEET_NAME);
  download(XLSX, wb, '目前帳號名單.xlsx');
}

/* ------------------------------------------------------------------ */
/* 5d. 節次設定（period_config，只支援「全校」「部別」兩種範圍，          */
/*     「班級」範圍因為要對應內部的班級ID，Excel不好填，請個別到資料庫調整）*/
/* ------------------------------------------------------------------ */
export const PERIOD_CONFIG_SHEET_NAME = '節次設定';

export async function buildPeriodConfigSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['範圍(全校/部別)', '部別(範圍=全校時留空)', '星期(一~六)', '堂數'],
    [
      '↓從第3列開始才是資料。「部別」範圍要填「幼兒園」「國小」「國中」「高中」其中一種。同星期同範圍重複上傳會直接覆蓋原本堂數。' +
        '「班級」個別覆寫（少數班級跟部別不同堂數）目前無法用Excel設定，如有需要請告知系統開發人員協助處理。',
      '',
      '',
      '',
    ],
    ['全校', '', '一', 8],
    ['部別', '國中', '六', 5],
  ]);
}

export async function downloadPeriodConfigTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildPeriodConfigSheet(), PERIOD_CONFIG_SHEET_NAME);
  download(XLSX, wb, '節次設定_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 6. 成績、出缺輸入表（學生成績輸入 + 學生出缺席輸入 共用同一份格式）      */
/* ------------------------------------------------------------------ */
export const SCORE_ATTENDANCE_SHEET_NAME = '成績、出缺輸入表';

const EXAM_BLOCK_START: Record<string, number> = { '期中考': 3, '期末考': 14, '平時分': 25 };
const ATTENDANCE_WEEKDAY_START = 40; // 一~六，每個日期5欄(第1~5節)，共30欄
const ATTENDANCE_WEEKDAYS = ['一', '二', '三', '四', '五', '六'];
const DEMO_SUBJECTS = ['國文', '數學', '英文'];

function makeRow(width: number, fill: (row: any[]) => void) {
  const row = new Array(width).fill('');
  fill(row);
  return row;
}

export async function buildScoreAttendanceSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  const width = ATTENDANCE_WEEKDAY_START + ATTENDANCE_WEEKDAYS.length * 5;

  // 第1列：學年度/學期(任一格含4位數字視為學年度、"上學期"/"下學期"字樣視為學期)，第3欄=年級
  const row1 = makeRow(width, (r) => {
    r[0] = '2026學年度';
    r[1] = '上學期';
    r[2] = '7年';
  });
  // 第2列：第3欄=班級名稱
  const row2 = makeRow(width, (r) => {
    r[2] = '忠班';
  });
  const row3 = makeRow(width, () => {});
  const row4 = makeRow(width, () => {});
  // 第5列：期中考/期末考/平時分 三個區塊標題 + 各星期的日期
  const row5 = makeRow(width, (r) => {
    Object.entries(EXAM_BLOCK_START).forEach(([name, start]) => {
      r[start] = name;
    });
    ATTENDANCE_WEEKDAYS.forEach((wd, i) => {
      r[ATTENDANCE_WEEKDAY_START + i * 5] = new Date(2026, 6, 20 + i); // 示範日期
    });
  });
  // 第6列：出缺勤節次標示（僅供閱讀方便，系統不解析此列）
  const row6 = makeRow(width, (r) => {
    ATTENDANCE_WEEKDAYS.forEach((wd, i) => {
      for (let p = 0; p < 5; p++) {
        r[ATTENDANCE_WEEKDAY_START + i * 5 + p] = `第${p + 1}節`;
      }
    });
  });
  // 第7列：各分數區塊的科目名稱
  const row7 = makeRow(width, (r) => {
    Object.values(EXAM_BLOCK_START).forEach((start) => {
      DEMO_SUBJECTS.forEach((subj, i) => {
        r[start + i] = subj;
      });
    });
  });
  // 第8列起：學生資料（座號/學號/姓名 + 分數/出缺勤代碼留空給老師填寫）
  const studentRow = (seatNo: number, studentNo: string, name: string) =>
    makeRow(width, (r) => {
      r[0] = seatNo;
      r[1] = studentNo;
      r[2] = name;
    });

  return aoa(XLSX, [
    row1,
    row2,
    row3,
    row4,
    row5,
    row6,
    row7,
    studentRow(1, 'S10701', '王小明'),
    studentRow(2, 'S10702', '李小華'),
  ]);
}

export async function buildScoreAttendanceLegendSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['出缺勤代碼說明（填在對應節次的儲存格）'],
    ['代碼', '意義'],
    [10, '曠課'],
    [1, '遲到'],
    [2, '病假'],
    [3, '事假'],
    [4, '公假'],
    ['(空白)', '出席（不用填）'],
    [],
    ['分數區塊填法'],
    ['期中考/期末考/平時分 三個區塊，各科目分數請填在對應科目欄位下方，0-100分'],
  ]);
}

export async function downloadScoreAttendanceTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceSheet(), SCORE_ATTENDANCE_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceLegendSheet(), '代碼說明');
  download(XLSX, wb, '成績出缺輸入表_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 6b. 成績、出缺輸入表：帶入教師目前選定班級的「真實名冊＋真實科目」版本    */
/*     （給「成績登錄」頁「下載範本」用單機版操作的老師，不再是完全空白、    */
/*     跟自己班級無關的示範資料，且只帶出這位老師實際能教的科目）          */
/* ------------------------------------------------------------------ */
export type ClassRosterStudent = { seatNo: number; studentNo: string; name: string };

export async function buildScoreAttendanceSheetForClass(params: {
  academicYear: number;
  term: string;
  gradeLevel: string;
  className: string;
  subjects: string[];
  students: ClassRosterStudent[];
}): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  const width = ATTENDANCE_WEEKDAY_START + ATTENDANCE_WEEKDAYS.length * 5;
  // 各區塊實際能放的欄數（見上面 EXAM_BLOCK_START 的間距），超過的科目會被截掉，
  // 並非本次需求範圍能解決的版面限制——如果真的超過，畫面上會另外提醒老師改用線上輸入。
  const blockWidth = ATTENDANCE_WEEKDAY_START - EXAM_BLOCK_START['平時分'];
  const subjectsForBlock = params.subjects.slice(0, blockWidth);

  const row1 = makeRow(width, (r) => {
    r[0] = `${params.academicYear}學年度`;
    r[1] = params.term;
    r[2] = params.gradeLevel;
  });
  const row2 = makeRow(width, (r) => {
    r[2] = params.className;
  });
  const row3 = makeRow(width, () => {});
  const row4 = makeRow(width, () => {});
  const row5 = makeRow(width, (r) => {
    Object.entries(EXAM_BLOCK_START).forEach(([name, start]) => {
      r[start] = name;
    });
    ATTENDANCE_WEEKDAYS.forEach((wd, i) => {
      r[ATTENDANCE_WEEKDAY_START + i * 5] = new Date(params.academicYear, 6, 20 + i);
    });
  });
  const row6 = makeRow(width, (r) => {
    ATTENDANCE_WEEKDAYS.forEach((wd, i) => {
      for (let p = 0; p < 5; p++) {
        r[ATTENDANCE_WEEKDAY_START + i * 5 + p] = `第${p + 1}節`;
      }
    });
  });
  const row7 = makeRow(width, (r) => {
    Object.values(EXAM_BLOCK_START).forEach((start) => {
      subjectsForBlock.forEach((subj, i) => {
        r[start + i] = subj;
      });
    });
  });
  const studentRow = (seatNo: number, studentNo: string, name: string) =>
    makeRow(width, (r) => {
      r[0] = seatNo;
      r[1] = studentNo;
      r[2] = name;
    });

  const rows = [row1, row2, row3, row4, row5, row6, row7];
  params.students
    .slice()
    .sort((a, b) => a.seatNo - b.seatNo)
    .forEach((s) => rows.push(studentRow(s.seatNo, s.studentNo, s.name)));

  return aoa(XLSX, rows);
}

export async function downloadScoreAttendanceTemplateForClass(params: {
  academicYear: number;
  term: string;
  gradeLevel: string;
  className: string;
  subjects: string[];
  students: ClassRosterStudent[];
}) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceSheetForClass(params), SCORE_ATTENDANCE_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceLegendSheet(), '代碼說明');
  download(XLSX, wb, `成績出缺輸入表_${params.gradeLevel}${params.className}.xlsx`);
}

// 【本輪新增】反映事項「系統管理員能一次上傳全校整學期出缺狀態（目前一次只能用
// 一個班）」——先提供對應的「一次下載全校」：一個活頁簿，每個班各自一張分頁
// （工作表名稱用「年級班級」，Excel分頁名稱上限31字元，超過會截短），每張分頁
// 都是跟單班下載一樣的「成績、出缺輸入表」格式＋真實名冊，管理員逐班填完出缺
// 狀態後，同一個檔案整批上傳回去即可（見 weekly 頁 handleUploadFile 的多分頁
// 處理，用 readAllClassSheets() 逐分頁解析）。
export async function downloadScoreAttendanceTemplateForClasses(
  classesData: {
    academicYear: number;
    term: string;
    gradeLevel: string;
    className: string;
    subjects: string[];
    students: ClassRosterStudent[];
  }[]
) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  for (const params of classesData) {
    let sheetName = `${params.gradeLevel}${params.className}`.slice(0, 31);
    // Excel 分頁名稱在同一個活頁簿裡必須唯一，理論上「年級+班級」不會重複，
    // 但萬一真的撞名（例如截短後剛好一樣），補個流水號避免整批下載失敗。
    let suffix = 1;
    while (usedNames.has(sheetName)) {
      sheetName = `${params.gradeLevel}${params.className}`.slice(0, 28) + '_' + suffix++;
    }
    usedNames.add(sheetName);
    XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceSheetForClass(params), sheetName);
  }
  XLSX.utils.book_append_sheet(wb, await buildScoreAttendanceLegendSheet(), '代碼說明');
  download(XLSX, wb, `成績出缺輸入表_全校.xlsx`);
}

/* ------------------------------------------------------------------ */
/* 7. 全部上傳(下載)：整批設定用的合併範本                               */
/*    （不含成績/出缺，因為那是每班每學期持續登錄的資料，非一次性建置；    */
/*     班級/科目節數/任課教師/節次已改由排課系統匯出Excel自動匯入）        */
/* ------------------------------------------------------------------ */
export async function downloadAllSetupTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, await buildGradingRulesSheet(), GRADING_RULES_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, await buildStudentsImportSheet(), STUDENTS_IMPORT_SHEET_NAME);
  download(XLSX, wb, '新學期開學設定_整批範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 8. 開發人員區「一鍵上傳/下載」：系統內所有Excel表格，合併成一份檔案，   */
/*    專門給第一次建檔（全新學校／全新學年，資料庫幾乎是空的）時使用，     */
/*    不用每個功能頁分開下載/上傳一次。                                  */
/*                                                                      */
/*    ⚠️「班級與導師設定」「任課教師設定」「學校課表」「科目與比重設定」   */
/*    （節數部分）這4張，平常請優先用【排課系統（自動排課工具）】排課後    */
/*    匯出Excel自動匯入，這裡保留只是給「還沒用過排課系統、資料庫整個是   */
/*    空的」全新學校第一次建檔用；已經有資料後如果同時用這裡跟排課系統匯入，*/
/*    以「最後上傳的那次」為準，請避免兩邊都上傳造成互相覆蓋。            */
/* ------------------------------------------------------------------ */
async function buildDeveloperReadmeSheet(): Promise<XLSXNS.WorkSheet> {
  const XLSX = await loadXLSX();
  return aoa(XLSX, [
    ['開發人員區：系統內所有Excel表格 說明（請先看這張再開始填）'],
    [''],
    ['這份檔案把系統裡所有可以用Excel整批建立資料的表格，合併成一份檔案，方便全新學校/全新學年「第一次建檔」時一次填完、一次上傳。'],
    ['每張工作表的格式跟各功能頁「下載範本」下載到的一模一樣，只是這裡集中放在同一份檔案裡。'],
    [''],
    ['工作表', '對應功能頁', '建議使用時機'],
    ['帳號名單', '帳號管理', '建立教職員登入帳號'],
    ['班級與導師設定', '（已停用，見下方說明）', '全新學校第一次建檔用；平常請用排課系統排課後按「存檔到校務系統」自動建立'],
    ['科目與比重設定', '成績相關設定及查詢', '節數部分全新學校第一次建檔用（平常由排課系統帶入）；比重請務必手動填寫，排課系統不會有這項資料'],
    ['任課教師設定', '（已停用，見下方說明）', '全新學校第一次建檔用；平常請用排課系統排課後按「存檔到校務系統」自動建立'],
    ['學校課表', '學校課表', '全新學校第一次建檔用；平常請用排課系統排課後按「存檔到校務系統」自動匯入'],
    ['節次設定', '（目前無獨立頁面，資料庫直接設定）', '設定每週各星期預設堂數，沒設定過的學校請至少填一次「全校」列'],
    ['整體佔比與加扣分規則', '成績相關設定及查詢', '每學期開學前設定期中/期末/平時比重與加扣分項目'],
    ['既有學生快速建檔（精簡版）', '學籍設定及查詢', '全新學校快速把既有學生名冊匯入'],
    [''],
    ['上傳時系統會詢問「這批資料主要適用哪個學年度/學期」，全部工作表共用同一組回答（成績、出缺輸入表除外，那張本來就要在各自的頁面單獨處理，不在這份檔案裡）。'],
    ['上傳前系統會列出「這份檔案裡有、但看起來已經有資料在用排課系統管理」的工作表並提醒一次，請看清楚提醒後再決定要不要繼續。'],
  ]);
}

export const DEVELOPER_ALL_SHEETS = [
  ACCOUNTS_SHEET_NAME,
  CLASSES_SHEET_NAME,
  CURRICULUM_SHEET_NAME,
  TEACHER_ASSIGNMENTS_SHEET_NAME,
  SCHOOL_TIMETABLE_SHEET_NAME,
  PERIOD_CONFIG_SHEET_NAME,
  GRADING_RULES_SHEET_NAME,
  STUDENTS_IMPORT_SHEET_NAME,
] as const;

// 跟排課系統「存檔到校務系統」功能重疊的表，上傳前要特別提醒一次：
// 前4張是「一鍵上傳」自己的可上傳範本；後2張是排課工具匯出Excel的「全校總課表(輸入)」／
// 「課表模板(修改用)」，內容相同、現在也接到同一套 importScheduleExcel() 寫回邏輯，
// 一樣會動到 classes/curriculum/class_schedule，所以一起列進重疊提醒。
export const DEVELOPER_SCHEDULER_OVERLAP_SHEETS = [
  CLASSES_SHEET_NAME,
  CURRICULUM_SHEET_NAME,
  TEACHER_ASSIGNMENTS_SHEET_NAME,
  SCHOOL_TIMETABLE_SHEET_NAME,
  '全校總課表(輸入)',
  '課表模板(修改用)',
  // 「下載完整資料快照」下載回來的「(現況)」工作表現在也可以直接重新上傳（見 BulkExcelPanel 的
  // plan.currentName），所以這4張的「(現況)」版本也要一起列進重疊提醒，不然直接把快照檔案
  // 整份重新上傳時，不會被提醒「可能蓋掉排課系統寫入的資料」。
  '班級與導師設定(現況)',
  '科目與比重設定(現況)',
  '任課教師設定(現況)',
  '學校課表(現況)',
] as const;

export type NamedSheet = { name: string; ws: XLSXNS.WorkSheet };

export async function buildDeveloperSetupSheets(): Promise<NamedSheet[]> {
  return [
    { name: '說明（請先看這裡）', ws: await buildDeveloperReadmeSheet() },
    { name: ACCOUNTS_SHEET_NAME, ws: await buildAccountsSheet() },
    { name: CLASSES_SHEET_NAME, ws: await buildClassesSheet() },
    { name: CURRICULUM_SHEET_NAME, ws: await buildCurriculumSheet() },
    { name: TEACHER_ASSIGNMENTS_SHEET_NAME, ws: await buildTeacherAssignmentsSheet() },
    { name: SCHOOL_TIMETABLE_SHEET_NAME, ws: await buildSchoolTimetableSheet() },
    { name: PERIOD_CONFIG_SHEET_NAME, ws: await buildPeriodConfigSheet() },
    { name: GRADING_RULES_SHEET_NAME, ws: await buildGradingRulesSheet() },
    { name: STUDENTS_IMPORT_SHEET_NAME, ws: await buildStudentsImportSheet() },
  ];
}

export async function downloadDeveloperAllTemplate() {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  const sheets = await buildDeveloperSetupSheets();
  sheets.forEach(({ name, ws }) => XLSX.utils.book_append_sheet(wb, ws, name));
  download(XLSX, wb, '開發人員區_全部表格_範本.xlsx');
}

/* ------------------------------------------------------------------ */
/* 13. 班級成績總表：下載成績 EXCEL 格式                                  */
/* ------------------------------------------------------------------ */
// 對應這輪反映事項 1：「期中」「期末」「平時」目前只能全班列印成績總表，沒有下載
// EXCEL 的功能——這裡直接把【班級成績總表】頁（ClassSummaryTab.tsx）已經在畫面上
// 顯示的資料（不用另外查資料庫）整理成一份 Excel，第一列科目名稱、第二列
// 期中/期末/平時/總分/平均/班排/年排的子欄位，每個學生一列，欄位順序、名稱都
// 跟畫面上的表格一致，方便對照，也方便老師拿去用 Excel 自己加總/篩選。
export type ClassScoreExcelParams = {
  className: string;
  academicYear: number | string;
  term: string;
  viewMode: 'all' | '期中考' | '期末考' | '平時分';
  subjects: string[]; // 已經依比重排序、篩掉比重=0 的科目清單
  examTypes: ('期中考' | '期末考' | '平時分')[]; // viewMode==='all' 時是三種都有，否則只有一種
  students: { enrollment_id: string; seat_no: number; name: string }[];
  subjectScores: Record<string, Record<string, { midterm: number | null; final: number | null; daily: number | null }>>; // enrollment_id -> subject -> {期中/期末/平時}
  attendanceAdjustments: Record<string, number>; // enrollment_id -> 出缺席自動計算分數（取代「全勤」「出缺席」科目手動輸入值）
  classRank: Record<
    string,
    {
      total_score?: number | null;
      class_rank?: number | null;
      midterm_total?: number | null;
      midterm_average?: number | null;
      midterm_class_rank?: number | null;
      final_total?: number | null;
      final_average?: number | null;
      final_class_rank?: number | null;
      daily_total?: number | null;
      daily_average?: number | null;
      daily_class_rank?: number | null;
    }
  >;
  gradeRank: Record<string, { grade_rank?: number | null; midterm_grade_rank?: number | null; final_grade_rank?: number | null; daily_grade_rank?: number | null }>;
  // 反映事項：開發人員區「出缺席成績不含蓋在期中、期末、平時個別三部分分數」開關
  // 開啟時，期中/期末/平時三組「總分／排名」表頭要補上「(未含出缺席加扣分)」，
  // 跟【班級成績總表】畫面上的表頭文字一致（見 sql/68：這三部分不含出缺席，
  // 「全學期」總表那組不受影響、不加這段文字，一律含出缺席）。
  attendanceExcludedFromPartials?: boolean;
};

const EXAM_TYPE_SHORT: Record<'期中考' | '期末考' | '平時分', string> = { 期中考: '期中', 期末考: '期末', 平時分: '平時' };
const EXAM_TYPE_FIELD_KEY: Record<'期中考' | '期末考' | '平時分', 'midterm' | 'final' | 'daily'> = { 期中考: 'midterm', 期末考: 'final', 平時分: 'daily' };
const ATTENDANCE_SUBJECT_NAMES = ['全勤', '出缺席'];

export async function downloadClassScoreExcel(p: ClassScoreExcelParams) {
  const XLSX = await loadXLSX();

  const header1: any[] = ['座號', '姓名'];
  const header2: any[] = ['', ''];
  p.subjects.forEach((s) => {
    p.examTypes.forEach((et, i) => {
      header1.push(i === 0 ? s : '');
      header2.push(EXAM_TYPE_SHORT[et]);
    });
  });
  p.examTypes.forEach((et) => {
    header1.push(p.attendanceExcludedFromPartials ? `${EXAM_TYPE_SHORT[et]}(未含出缺席加扣分)` : EXAM_TYPE_SHORT[et], '', '', '');
    header2.push('總分', '平均(*比重)', '班排名', '年級排名');
  });
  if (p.viewMode === 'all') {
    header1.push('全學期', '', '');
    header2.push('總分', '班排名', '年級排名');
  }

  const rows: any[][] = [header1, header2];
  p.students.forEach((stu) => {
    const row: any[] = [stu.seat_no, stu.name];
    p.subjects.forEach((s) => {
      const isAttendance = ATTENDANCE_SUBJECT_NAMES.includes(s);
      p.examTypes.forEach((et) => {
        if (isAttendance) {
          row.push(p.attendanceAdjustments[stu.enrollment_id] ?? '');
        } else {
          const v = p.subjectScores[stu.enrollment_id]?.[s]?.[EXAM_TYPE_FIELD_KEY[et]];
          row.push(v ?? '');
        }
      });
    });
    const cr = p.classRank[stu.enrollment_id] ?? {};
    const gr = p.gradeRank[stu.enrollment_id] ?? {};
    p.examTypes.forEach((et) => {
      if (et === '期中考') row.push(cr.midterm_total ?? '', cr.midterm_average ?? '', cr.midterm_class_rank ?? '', gr.midterm_grade_rank ?? '');
      else if (et === '期末考') row.push(cr.final_total ?? '', cr.final_average ?? '', cr.final_class_rank ?? '', gr.final_grade_rank ?? '');
      else row.push(cr.daily_total ?? '', cr.daily_average ?? '', cr.daily_class_rank ?? '', gr.daily_grade_rank ?? '');
    });
    if (p.viewMode === 'all') {
      row.push(cr.total_score ?? '', cr.class_rank ?? '', gr.grade_rank ?? '');
    }
    rows.push(row);
  });

  const ws = aoa(XLSX, rows);
  // 科目名稱跨欄合併（每個科目底下有幾個考試類型欄位，就合併幾欄）
  const merges: XLSXNS.Range[] = [];
  let col = 2;
  p.subjects.forEach(() => {
    if (p.examTypes.length > 1) merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + p.examTypes.length - 1 } });
    col += p.examTypes.length;
  });
  p.examTypes.forEach(() => {
    merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + 3 } });
    col += 4;
  });
  if (p.viewMode === 'all') merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + 2 } });
  (ws as any)['!merges'] = merges;

  const wb = XLSX.utils.book_new();
  const sheetLabel = p.viewMode === 'all' ? '全部' : EXAM_TYPE_SHORT[p.viewMode as '期中考' | '期末考' | '平時分'];
  XLSX.utils.book_append_sheet(wb, ws, '成績總表');
  download(XLSX, wb, `${p.className}_${p.academicYear}${p.term}_${sheetLabel}成績.xlsx`);
}

/* ------------------------------------------------------------------ */
/* 14. 批次下載多班／全校成績 EXCEL（一班一個分頁）                        */
/* ------------------------------------------------------------------ */
// 對應反映事項「增加批次列印各班成績表(總分、期中、期末、平時)，現在只能一個班
// 一個班按」——重用上面 downloadClassScoreExcel 同一套組表邏輯，差別是這裡一次
// 接收多個班級的資料，每個班級各自變成活頁簿裡的一個分頁，一次下載一個檔案。
export async function downloadMultiClassScoreExcel(classes: (ClassScoreExcelParams & { sheetName: string })[]) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();

  const usedNames = new Set<string>();
  for (const p of classes) {
    const header1: any[] = ['座號', '姓名'];
    const header2: any[] = ['', ''];
    p.subjects.forEach((s) => {
      p.examTypes.forEach((et, i) => {
        header1.push(i === 0 ? s : '');
        header2.push(EXAM_TYPE_SHORT[et]);
      });
    });
    p.examTypes.forEach((et) => {
      header1.push(p.attendanceExcludedFromPartials ? `${EXAM_TYPE_SHORT[et]}(未含出缺席加扣分)` : EXAM_TYPE_SHORT[et], '', '', '');
      header2.push('總分', '平均(*比重)', '班排名', '年級排名');
    });
    if (p.viewMode === 'all') {
      header1.push('全學期', '', '');
      header2.push('總分', '班排名', '年級排名');
    }

    const rows: any[][] = [header1, header2];
    p.students.forEach((stu) => {
      const row: any[] = [stu.seat_no, stu.name];
      p.subjects.forEach((s) => {
        const isAttendance = ATTENDANCE_SUBJECT_NAMES.includes(s);
        p.examTypes.forEach((et) => {
          if (isAttendance) {
            row.push(p.attendanceAdjustments[stu.enrollment_id] ?? '');
          } else {
            const v = p.subjectScores[stu.enrollment_id]?.[s]?.[EXAM_TYPE_FIELD_KEY[et]];
            row.push(v ?? '');
          }
        });
      });
      const cr = p.classRank[stu.enrollment_id] ?? {};
      const gr = p.gradeRank[stu.enrollment_id] ?? {};
      p.examTypes.forEach((et) => {
        if (et === '期中考') row.push(cr.midterm_total ?? '', cr.midterm_average ?? '', cr.midterm_class_rank ?? '', gr.midterm_grade_rank ?? '');
        else if (et === '期末考') row.push(cr.final_total ?? '', cr.final_average ?? '', cr.final_class_rank ?? '', gr.final_grade_rank ?? '');
        else row.push(cr.daily_total ?? '', cr.daily_average ?? '', cr.daily_class_rank ?? '', gr.daily_grade_rank ?? '');
      });
      if (p.viewMode === 'all') {
        row.push(cr.total_score ?? '', cr.class_rank ?? '', gr.grade_rank ?? '');
      }
      rows.push(row);
    });

    const ws = aoa(XLSX, rows);
    const merges: XLSXNS.Range[] = [];
    let col = 2;
    p.subjects.forEach(() => {
      if (p.examTypes.length > 1) merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + p.examTypes.length - 1 } });
      col += p.examTypes.length;
    });
    p.examTypes.forEach(() => {
      merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + 3 } });
      col += 4;
    });
    if (p.viewMode === 'all') merges.push({ s: { r: 0, c: col }, e: { r: 0, c: col + 2 } });
    (ws as any)['!merges'] = merges;

    // Excel 分頁名稱不能超過31字元、不能重複、不能含特殊符號，這裡簡單處理一下。
    let name = p.sheetName.replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Sheet';
    let dedupeName = name;
    let n = 2;
    while (usedNames.has(dedupeName)) {
      dedupeName = `${name.slice(0, 28)}(${n})`;
      n++;
    }
    usedNames.add(dedupeName);
    XLSX.utils.book_append_sheet(wb, ws, dedupeName);
  }

  const label = classes.length === 1 ? classes[0].sheetName : `${classes.length}個班級`;
  download(XLSX, wb, `批次成績_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

