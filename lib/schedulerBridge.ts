import { supabase } from './supabaseClient';
import { resolveClassId, resolveTeacherByName, upsertTeacherAssignment } from './bulkHandlers';

// ============================================================
// 排課系統橋接工具
// ------------------------------------------------------------
// 「排課系統」(app/(app)/admin/scheduling/scheduler-tool.html，原始檔：
// scheduler_v0729-6小學星期六顯示.html) 是一個完全獨立、資料存在瀏覽器
// localStorage 的排課小工具，年級／班級清單寫死在它自己的原始碼(GRADES 陣列)裡。
//
// 這個檔案的用途：把校務行政系統裡「科目與比重設定」「班級與導師設定」
// 「任課教師設定」既有的資料，轉成排課系統「匯入教師」「年級設定→一鍵匯入全校」
// 兩個分頁看得懂的貼上格式，avoid逐筆手動重打。
//
// 因為班級名稱是用「字串猜測」對應過去的（例如校務系統存的是「忠」，排課系統
// 認得的是「一年忠」），猜不出來或猜錯的地方都會列在 warnings 裡，
// 請管理者在貼到排課系統之前，肉眼確認一次再貼上。
// ============================================================

// 校務系統「年級」欄位 → 排課系統「年級名稱」欄位 的對照表
//
// 【2026-08 年級文字統一】校務系統的「初一/初二/初三」「高一/高二/高三」跟排課系統原本
// 就是同一套文字，不需要再轉換過去（以前這裡誤寫成「初中一」「高中一」這種帶「中」字的
// 版本，跟 lib/gradeMapping.ts 對不上，已改成一致），保留這個對照表只是讓「校務系統欄位」
// 跟「排課系統欄位」在語意上還是分開兩個獨立清單，日後如果其中一邊的文字要單獨調整還是
// 可以只改這裡，不用去動另一邊。
export const GRADE_LEVEL_TO_SCHEDULER: Record<string, string> = {
  '幼甲': '幼甲班',
  '幼乙': '幼乙班',
  '1年': '一年級',
  '2年': '二年級',
  '3年': '三年級',
  '4年': '四年級',
  '5年': '五年級',
  '6年': '六年級',
  '初一': '初一',
  '初二': '初二',
  '初三': '初三',
  '高一': '高一',
  '高二': '高二',
  '高三': '高三',
};

// 對照排課系統原始碼(GRADES 陣列)裡目前寫死的班級清單，用來猜測班級名稱。
// 學校日後如果調整班級名稱／新增班級，這裡跟排課系統原始碼（public/scheduler/scheduler-tool.html
// 的 GRADES 陣列）都要一起改，兩邊班級清單必須完全一致，否則會出現「找不到對應年級」的錯誤。
//
// 【2026-08 修正】依「校務系統完整資料快照」現況，高一/高二/高三目前都各自只有一個「忠」班，
// 這裡原本寫的是 ['高一']／['高二']／['高三']（把年級名稱當成班級名稱，沒有加班級字），
// 跟校務系統「年級=高一、班級名稱=忠」兜出來的「高一忠」對不起來，才會出現
// 「高一忠: 找不到對應年級」「高二忠: 找不到對應年級」「高三忠: 找不到對應年級」的錯誤，已修正。
export const SCHEDULER_CLASSES: Record<string, string[]> = {
  '幼甲班': ['幼甲忠班', '幼甲孝班', '幼甲仁班', '幼甲愛班'],
  '幼乙班': ['幼乙忠班', '幼乙孝班', '幼乙仁班', '幼乙愛班'],
  '一年級': ['一年忠', '一年孝', '一年仁', '一年愛'],
  '二年級': ['二年忠', '二年孝', '二年仁'],
  '三年級': ['三年忠', '三年孝', '三年仁', '三年愛'],
  '四年級': ['四年忠', '四年孝', '四年仁'],
  '五年級': ['五年忠', '五年孝'],
  '六年級': ['六年忠', '六年孝'],
  '初一': ['初一忠', '初一孝'],
  '初二': ['初二忠', '初二孝'],
  '初三': ['初三忠'],
  '高一': ['高一忠'],
  '高二': ['高二忠'],
  '高三': ['高三忠'],
};

function guessSchedulerClassLabel(schedulerGrade: string, className: string): { label: string; guessed: boolean } {
  const list = SCHEDULER_CLASSES[schedulerGrade] ?? [];
  const normalized = className.trim().replace(/班$/, '');
  const found = list.find((c) => c.endsWith(normalized));
  if (found) return { label: found, guessed: false };
  return { label: schedulerGrade + normalized, guessed: true };
}

export type BridgeResult = { text: string; warnings: string[] };

/** 產生「年級設定 → 一鍵匯入全校」分頁要貼的文字（年級名稱單獨一行，下面每行「科目 節數」） */
export async function buildCurriculumImportText(academicYear: number, term: string): Promise<BridgeResult> {
  const warnings: string[] = [];
  const { data, error } = await supabase
    .from('curriculum')
    .select('grade_level, subject, periods')
    .eq('academic_year', academicYear)
    .eq('term', term);

  if (error) return { text: '', warnings: ['讀取「科目與比重設定」失敗：' + error.message] };

  const byGrade: Record<string, { subject: string; periods: number | null }[]> = {};
  for (const row of (data ?? []) as any[]) {
    const schedulerGrade = GRADE_LEVEL_TO_SCHEDULER[row.grade_level];
    if (!schedulerGrade) {
      warnings.push(`年級「${row.grade_level}」在對照表中找不到對應的排課系統年級，已略過（科目：${row.subject}）`);
      continue;
    }
    if (!byGrade[schedulerGrade]) byGrade[schedulerGrade] = [];
    byGrade[schedulerGrade].push({ subject: row.subject, periods: row.periods });
  }

  const blocks: string[] = [];
  for (const gradeName of Object.keys(byGrade)) {
    const lines: string[] = [];
    for (const s of byGrade[gradeName]) {
      if (s.periods == null) {
        warnings.push(`${gradeName}／${s.subject} 尚未設定節數，已略過此科目`);
        continue;
      }
      lines.push(`${s.subject} ${s.periods}`);
    }
    if (lines.length) blocks.push([gradeName, ...lines].join('\n'));
  }
  return { text: blocks.join('\n\n'), warnings };
}

/** 產生「匯入教師」分頁要貼的文字（每兩行一組：班級+科目／導師+各科老師） */
export async function buildTeacherImportText(academicYear: number, term: string): Promise<BridgeResult> {
  const warnings: string[] = [];

  const { data: classes, error: classErr } = await supabase
    .from('classes')
    .select('id, grade_level, class_name, teachers(name)')
    .eq('academic_year', academicYear);
  if (classErr || !classes) return { text: '', warnings: ['讀取「班級與導師設定」失敗：' + (classErr?.message ?? '未知錯誤')] };

  const { data: scheduleRows, error: schedErr } = await supabase
    .from('class_schedule')
    .select('class_id, subject, teachers(name)')
    .eq('academic_year', academicYear)
    .eq('term', term);
  if (schedErr) warnings.push('讀取「任課教師設定」失敗：' + schedErr.message);

  const byClass: Record<string, { subject: string; teacherName: string }[]> = {};
  for (const row of (scheduleRows ?? []) as any[]) {
    const teacherName = row.teachers?.name;
    if (!teacherName) continue;
    if (!byClass[row.class_id]) byClass[row.class_id] = [];
    if (!byClass[row.class_id].some((r) => r.subject === row.subject)) {
      byClass[row.class_id].push({ subject: row.subject, teacherName });
    }
  }

  const blocks: string[] = [];
  for (const cls of classes as any[]) {
    const schedulerGrade = GRADE_LEVEL_TO_SCHEDULER[cls.grade_level];
    if (!schedulerGrade) {
      warnings.push(`班級「${cls.grade_level}${cls.class_name}」找不到對應的排課系統年級，已略過`);
      continue;
    }
    const { label, guessed } = guessSchedulerClassLabel(schedulerGrade, cls.class_name);
    if (guessed) warnings.push(`班級「${cls.grade_level}${cls.class_name}」自動猜測對應到「${label}」，貼上前請確認是否正確`);

    const assignments = byClass[cls.id] ?? [];
    if (!assignments.length) {
      warnings.push(`「${label}」目前沒有任課教師設定資料，已略過`);
      continue;
    }
    const homeroom = cls.teachers?.name ?? '';
    const row1 = [label, ...assignments.map((a) => a.subject)].join('\t');
    const row2 = [homeroom, ...assignments.map((a) => a.teacherName)].join('\t');
    blocks.push(row1 + '\n' + row2);
  }
  return { text: blocks.join('\n'), warnings };
}

// ============================================================
// 反向匯入：排課系統匯出的 Excel →（班級與導師、科目節數、課表）寫回 Supabase
// ------------------------------------------------------------
// 只依賴排課系統匯出檔裡固定會有的兩張工作表：
//   「全校總課表(輸入)」：每班兩列一組（科目列＋老師列），是課表與導師資料的來源。
//   「匯入的年級&科目&節數」：年級名稱單獨一行、下面每行「科目 節數」，是科目節數的來源。
// 排課系統沒有「科目比重（weight）」的概念，所以比重一律先寫 0，
// 需要再到「成績相關設定及查詢」第一分頁手動補上正確比重。
// ============================================================

const WEEKDAY_LABEL_TO_NUM: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

const SCHEDULER_TO_GRADE_LEVEL: Record<string, string> = Object.fromEntries(
  Object.entries(GRADE_LEVEL_TO_SCHEDULER).map(([gradeLevel, schedulerName]) => [schedulerName, gradeLevel])
);

function findSchedulerGradeOfClass(className: string): string | null {
  for (const [grade, classes] of Object.entries(SCHEDULER_CLASSES)) {
    if (classes.includes(className)) return grade;
  }
  return null;
}

// 把排課系統的班級標籤（例如「一年忠」「幼甲忠班」「高一」）去掉年級字首/「班」字尾，
// 還原成校務系統慣用的班級名稱（例如「忠」）。只有一班的年級（高一/高二/高三）去掉字首後
// 會變空字串，這種情況就直接用完整標籤當班級名稱。
function classNameWithoutGradePrefix(schedulerGrade: string, className: string): string {
  const prefix = schedulerGrade.replace(/班$/, '').replace(/級$/, '');
  let rest = className;
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  rest = rest.replace(/班$/, '');
  return rest || className;
}

export type ScheduleImportResult = {
  classesUpserted: number;
  curriculumUpserted: number;
  scheduleUpserted: number;
  warnings: string[];
};

// ============================================================
// 直接存檔：排課工具「存檔到校務系統」按鈕送出的專案資料 → 直接寫回 Supabase
// ------------------------------------------------------------
// 跟 importScheduleExcel 做的事完全一樣（班級/課表/科目節數），差別只是資料來源
// 不是解析Excel，而是排課工具本身的 S 物件（跟「備份專案」JSON是同一份格式），
// 這樣使用者在排課工具裡按一次「存檔到校務系統」就好，不用先匯出Excel再回頭上傳。
// ============================================================

const SLOT_RE = /週(.)-(\d+)/;

export async function importScheduleFromProjectData(data: any, academicYear: number, term: string): Promise<ScheduleImportResult> {
  const warnings: string[] = [];
  let classesUpserted = 0;
  let curriculumUpserted = 0;
  let scheduleUpserted = 0;

  const grades: any[] = data?.GRADES ?? [];
  const schedules: Record<string, any> = data?.S?.schedules ?? {};
  const homerooms: Record<string, string> = data?.S?.homerooms ?? {};

  // ---- 1. 科目節數（每個年級的 subs：[{n:科目, c:節數}]） ----
  for (const g of grades) {
    const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[g.name];
    if (!gradeLevel) {
      warnings.push(`年級「${g.name}」找不到對應的校務系統年級代碼，已略過科目節數`);
      continue;
    }
    for (const s of g.subs ?? []) {
      if (!s?.n) continue;
      const { error } = await supabase
        .from('curriculum')
        .upsert(
          { academic_year: academicYear, term, grade_level: gradeLevel, subject: s.n, weight: 0, periods: s.c ?? null },
          { onConflict: 'academic_year,term,grade_level,subject' }
        );
      if (error) warnings.push(`科目節數寫入失敗（${g.name}／${s.n}）：${error.message}`);
      else curriculumUpserted++;
    }
  }
  if (curriculumUpserted > 0) {
    warnings.push('科目比重（weight）目前統一寫入為 0，請到「成績相關設定及查詢」第一分頁補上正確的比重。');
  }

  // ---- 2. 班級／導師／課表 ----
  const classCache = new Map<string, string>();
  for (const className of Object.keys(schedules)) {
    const schedulerGrade = findSchedulerGradeOfClass(className);
    if (!schedulerGrade) {
      warnings.push(`班級「${className}」在對照表中找不到所屬年級，已略過`);
      continue;
    }
    const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[schedulerGrade];
    if (!gradeLevel) {
      warnings.push(`年級「${schedulerGrade}」找不到對應的校務系統年級代碼，已略過班級「${className}」`);
      continue;
    }
    const shortClassName = classNameWithoutGradePrefix(schedulerGrade, className);
    const cacheKey = `${gradeLevel}-${shortClassName}`;
    let classId = classCache.get(cacheKey);
    if (!classId) {
      try {
        classId = await resolveClassId(academicYear, gradeLevel, shortClassName);
        classCache.set(cacheKey, classId);
        classesUpserted++;
      } catch (err: any) {
        warnings.push(`建立班級「${className}」失敗：${err.message}`);
        continue;
      }
    }

    const homeroomName = homerooms[className];
    if (homeroomName) {
      try {
        const homeroomId = await resolveTeacherByName(homeroomName);
        if (homeroomId) await supabase.from('classes').update({ homeroom_teacher_id: homeroomId }).eq('id', classId);
      } catch (err: any) {
        warnings.push(`設定「${className}」導師失敗：${err.message}`);
      }
    }

    const entries: any[] = schedules[className]?.entries ?? [];
    for (const e of entries) {
      if (!e?.slot || !e?.sub || !e?.teacher) continue;
      const m = SLOT_RE.exec(e.slot);
      if (!m) continue;
      const weekday = WEEKDAY_LABEL_TO_NUM[m[1]];
      const periodNo = Number(m[2]);
      if (!weekday || Number.isNaN(periodNo)) continue;
      try {
        const teacherId = await resolveTeacherByName(e.teacher);
        if (!teacherId) continue;
        const { error } = await supabase
          .from('class_schedule')
          .upsert(
            { class_id: classId, academic_year: academicYear, term, weekday, period_no: periodNo, subject: e.sub, teacher_id: teacherId },
            { onConflict: 'class_id,academic_year,term,weekday,period_no' }
          );
        if (error) warnings.push(`「${className}」週${m[1]}第${periodNo}節寫入失敗：${error.message}`);
        else scheduleUpserted++;
      } catch (err: any) {
        warnings.push(`「${className}」週${m[1]}第${periodNo}節處理失敗：${err.message}`);
      }
    }
  }

  return { classesUpserted, curriculumUpserted, scheduleUpserted, warnings };
}

// ============================================================
// 只存「匯入教師 & 導師資料」／「全校科目節數匯入」這兩張，不用等整個排課流程做完
// ------------------------------------------------------------
// 背景（系統管理員S反映）：排課工具「匯入教師」「年級設定」這兩個分頁貼上資料後，
// 只會更新工具自己網頁裡的 S 變數——這個工具其實完全沒有任何持久化機制（連
// localStorage都沒用，純粹是分頁還開著時的記憶體），只要分頁被關掉、整理，
// 沒送出「💾 存檔到校務系統」的資料就直接消失，而「存檔到校務系統」原本的設計
// 是「整個學期課表都排完之後」才按一次的動作（有衝堂檢查擋著，沒排完課根本按不了）。
// 但任課教師／導師分配通常一學期只設定一次、之後很少變動，S 系統管理員與教務處
// 負責人都會希望「匯入教師」「一鍵匯入全校（科目節數）」這兩個分頁可以匯入後
// 立刻分別單獨存進資料庫，不用被綁在「排完課才能存檔」這個時間點上。
// 這兩支函式就是給這兩個分頁各自獨立、立即使用的版本，寫的資料表跟
// importScheduleFromProjectData 一致（curriculum／classes／class_schedule），
// 但不觸碰實際排課時段（weekday/period_no），也不需要先通過衝堂檢查。
// ============================================================

export type CurriculumImportResult = { curriculumUpserted: number; warnings: string[] };

export async function importCurriculumFromProjectData(data: any, academicYear: number, term: string): Promise<CurriculumImportResult> {
  const warnings: string[] = [];
  let curriculumUpserted = 0;
  const grades: any[] = data?.GRADES ?? [];

  for (const g of grades) {
    const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[g?.name];
    if (!gradeLevel) {
      warnings.push(`年級「${g?.name}」找不到對應的校務系統年級代碼，已略過科目節數`);
      continue;
    }
    for (const s of g.subs ?? []) {
      if (!s?.n) continue;
      const { error } = await supabase
        .from('curriculum')
        .upsert(
          { academic_year: academicYear, term, grade_level: gradeLevel, subject: s.n, weight: 0, periods: s.c ?? null },
          { onConflict: 'academic_year,term,grade_level,subject' }
        );
      if (error) warnings.push(`科目節數寫入失敗（${g.name}／${s.n}）：${error.message}`);
      else curriculumUpserted++;
    }
  }
  if (curriculumUpserted > 0) {
    warnings.push('科目比重（weight）目前統一寫入為 0，請到「成績相關設定及查詢」第一分頁補上正確的比重。');
  }
  return { curriculumUpserted, warnings };
}

export type TeacherAssignmentImportResult = { classesUpserted: number; assignmentsUpserted: number; warnings: string[] };

export async function importTeacherAssignmentsFromProjectData(
  data: any,
  academicYear: number,
  term: string
): Promise<TeacherAssignmentImportResult> {
  const warnings: string[] = [];
  let classesUpserted = 0;
  let assignmentsUpserted = 0;

  const grades: any[] = data?.GRADES ?? [];
  const teachers: Record<string, Record<string, Record<string, string>>> = data?.S?.teachers ?? {};
  const homerooms: Record<string, string> = data?.S?.homerooms ?? {};
  const classCache = new Map<string, string>();

  for (const g of grades) {
    const schedulerGrade = g?.name;
    const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[schedulerGrade];
    if (!gradeLevel) {
      warnings.push(`年級「${schedulerGrade}」找不到對應的校務系統年級代碼，已略過`);
      continue;
    }
    for (const className of g.classes ?? []) {
      const shortClassName = classNameWithoutGradePrefix(schedulerGrade, className);
      const cacheKey = `${gradeLevel}-${shortClassName}`;
      let classId = classCache.get(cacheKey);
      if (!classId) {
        try {
          classId = await resolveClassId(academicYear, gradeLevel, shortClassName);
          classCache.set(cacheKey, classId);
          classesUpserted++;
        } catch (err: any) {
          warnings.push(`建立班級「${className}」失敗：${err.message}`);
          continue;
        }
      }

      const homeroomName = homerooms[className];
      if (homeroomName) {
        try {
          const homeroomId = await resolveTeacherByName(homeroomName);
          if (homeroomId) await supabase.from('classes').update({ homeroom_teacher_id: homeroomId }).eq('id', classId);
        } catch (err: any) {
          warnings.push(`設定「${className}」導師失敗：${err.message}`);
        }
      }

      const tMap = (teachers[g.id] && teachers[g.id][className]) || {};
      for (const subject of Object.keys(tMap)) {
        const teacherName = tMap[subject];
        if (!teacherName) continue;
        try {
          const teacherId = await resolveTeacherByName(teacherName);
          if (!teacherId) continue;
          await upsertTeacherAssignment(classId, academicYear, term, subject, teacherId);
          assignmentsUpserted++;
        } catch (err: any) {
          warnings.push(`「${className}」${subject}任課教師寫入失敗：${err.message}`);
        }
      }
    }
  }

  return { classesUpserted, assignmentsUpserted, warnings };
}

export async function importScheduleExcel(file: File, academicYear: number, term: string): Promise<ScheduleImportResult> {
  const warnings: string[] = [];
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  const gridSheet = wb.Sheets['全校總課表(輸入)'];
  const curriculumSheet = wb.Sheets['匯入的年級&科目&節數'];

  if (!gridSheet) {
    return {
      classesUpserted: 0,
      curriculumUpserted: 0,
      scheduleUpserted: 0,
      warnings: ['找不到「全校總課表(輸入)」工作表，請確認上傳的是排課系統「匯出Excel」產生的檔案'],
    };
  }

  let curriculumUpserted = 0;

  // ---- 1. 科目節數 ----
  if (curriculumSheet) {
    const curriculumRows = XLSX.utils.sheet_to_json(curriculumSheet, { header: 1, defval: null }) as any[][];
    let currentGrade: string | null = null;
    for (const row of curriculumRows) {
      const col0 = row[0] != null ? String(row[0]).trim() : '';
      const col1 = row[1];
      if (!col0) continue;
      if (col1 == null) {
        currentGrade = col0;
        continue;
      }
      if (!currentGrade) continue;
      const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[currentGrade];
      if (!gradeLevel) {
        warnings.push(`年級「${currentGrade}」找不到對應的校務系統年級代碼，已略過（科目：${col0}）`);
        continue;
      }
      const periods = Number(col1);
      const { error } = await supabase
        .from('curriculum')
        .upsert(
          { academic_year: academicYear, term, grade_level: gradeLevel, subject: col0, weight: 0, periods },
          { onConflict: 'academic_year,term,grade_level,subject' }
        );
      if (error) warnings.push(`科目節數寫入失敗（${currentGrade}／${col0}）：${error.message}`);
      else curriculumUpserted++;
    }
    if (curriculumUpserted > 0) {
      warnings.push('科目比重（weight）目前統一寫入為 0，請到「成績相關設定及查詢」第一分頁補上正確的比重。');
    }
  } else {
    warnings.push('Excel裡沒有「匯入的年級&科目&節數」工作表，已略過科目節數匯入，請自行到「成績相關設定及查詢」第一分頁設定。');
  }

  // ---- 2. 班級／導師／課表 ----
  const gridRows = XLSX.utils.sheet_to_json(gridSheet, { header: 1, defval: null }) as any[][];
  const weekdayHeaderRow = gridRows[1] ?? [];
  const periodHeaderRow = gridRows[2] ?? [];

  const colWeekday: (number | null)[] = [];
  let lastWeekday: number | null = null;
  for (let c = 0; c < weekdayHeaderRow.length; c++) {
    const label = weekdayHeaderRow[c];
    if (label) lastWeekday = WEEKDAY_LABEL_TO_NUM[String(label).replace('星期', '')] ?? lastWeekday;
    colWeekday[c] = lastWeekday;
  }

  const classCache = new Map<string, string>();
  let classesUpserted = 0;
  let scheduleUpserted = 0;

  for (let i = 3; i + 1 < gridRows.length; i += 2) {
    const subjectRow = gridRows[i];
    const teacherRow = gridRows[i + 1];
    if (!subjectRow || !subjectRow[1]) continue;
    const className = String(subjectRow[1]).trim();
    const homeroomName = teacherRow && teacherRow[1] != null ? String(teacherRow[1]).trim() : '';

    const schedulerGrade = findSchedulerGradeOfClass(className);
    if (!schedulerGrade) {
      warnings.push(`班級「${className}」在對照表中找不到所屬年級，已略過`);
      continue;
    }
    const gradeLevel = SCHEDULER_TO_GRADE_LEVEL[schedulerGrade];
    if (!gradeLevel) {
      warnings.push(`年級「${schedulerGrade}」找不到對應的校務系統年級代碼，已略過班級「${className}」`);
      continue;
    }
    const shortClassName = classNameWithoutGradePrefix(schedulerGrade, className);

    const cacheKey = `${gradeLevel}-${shortClassName}`;
    let classId = classCache.get(cacheKey);
    if (!classId) {
      try {
        classId = await resolveClassId(academicYear, gradeLevel, shortClassName);
        classCache.set(cacheKey, classId);
        classesUpserted++;
      } catch (err: any) {
        warnings.push(`建立班級「${className}」失敗：${err.message}`);
        continue;
      }
    }

    if (homeroomName) {
      try {
        const homeroomId = await resolveTeacherByName(homeroomName);
        if (homeroomId) await supabase.from('classes').update({ homeroom_teacher_id: homeroomId }).eq('id', classId);
      } catch (err: any) {
        warnings.push(`設定「${className}」導師失敗：${err.message}`);
      }
    }

    for (let c = 2; c < subjectRow.length; c++) {
      const subject = subjectRow[c] != null ? String(subjectRow[c]).trim() : '';
      if (!subject || subject === '放學') continue;
      const weekday = colWeekday[c];
      const periodNo = Number(periodHeaderRow[c]);
      if (!weekday || Number.isNaN(periodNo)) continue;
      const teacherName = teacherRow && teacherRow[c] != null ? String(teacherRow[c]).trim() : '';
      if (!teacherName) {
        warnings.push(`「${className}」週${weekday}第${periodNo}節（${subject}）沒有老師姓名，已略過`);
        continue;
      }
      try {
        const teacherId = await resolveTeacherByName(teacherName);
        if (!teacherId) continue;
        const { error } = await supabase
          .from('class_schedule')
          .upsert(
            { class_id: classId, academic_year: academicYear, term, weekday, period_no: periodNo, subject, teacher_id: teacherId },
            { onConflict: 'class_id,academic_year,term,weekday,period_no' }
          );
        if (error) warnings.push(`「${className}」週${weekday}第${periodNo}節寫入失敗：${error.message}`);
        else scheduleUpserted++;
      } catch (err: any) {
        warnings.push(`「${className}」週${weekday}第${periodNo}節處理失敗：${err.message}`);
      }
    }
  }

  return { classesUpserted, curriculumUpserted, scheduleUpserted, warnings };
}
