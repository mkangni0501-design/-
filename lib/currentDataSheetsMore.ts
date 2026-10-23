import { supabase } from './supabaseClient';
import type { SheetRows } from './schoolWideDataQueries';
import { fetchAllPaged } from './schoolWideDataQueries';

// ============================================================
// 【2026-10 新增】「完整資料快照」補齊缺漏的資料。
//
// 原本快照只涵蓋「設定類」＋「現行學籍的成績/出缺勤/獎懲」，下面這些資料不在任何一張工作表裡：
//   - 學生基本資料（性別、生日、證號、住址、電話…：原本只有學號+姓名藏在別張表的欄位裡）
//   - 教師名單（teachers 表本身）
//   - 所有學期的學籍（enrollments：升級/學期轉換後 is_current=false 的舊學籍）
//   - 導師評語（student_remarks）／操行成績（所有學期）
//   - 監護人資料（guardians）／學籍異動紀錄（student_status_changes）／成績加扣分設定（score_adjustments）
// 這些工作表一律是「存檔/查詢用」，不在一鍵上傳計畫裡（上傳端不認得它們），所以不會因為重新上傳而覆蓋任何資料。
// 查詢一律分開撈、用 Map 在前端對應（本專案 PostgREST 外鍵嵌入查詢不穩定），並且依主鍵排序＋分頁撈到底。
// ============================================================

export const STUDENTS_MASTER_SHEET_NAME = '學生基本資料(全部)';
export const TEACHERS_SHEET_NAME = '教師名單(全部)';
export const ENROLLMENT_HISTORY_SHEET_NAME = '學籍歷史(全部學期)';
export const REMARKS_ALL_SHEET_NAME = '導師評語(全部學期)';
export const CONDUCT_SCORES_ALL_SHEET_NAME = '操行成績(全部學期)';
export const GUARDIANS_SHEET_NAME = '監護人資料';
export const SCORE_ADJUSTMENTS_SHEET_NAME = '成績加扣分設定';
export const STATUS_CHANGES_SHEET_NAME = '學籍異動紀錄';
export const INTEGRITY_SHEET_NAME = '完整性核對';

type Fail = { name: string; aoa: any[][] };
const failSheet = (name: string, msg: string): Fail => ({ name, aoa: [['讀取失敗：' + msg]] });

/** 全部學期的學籍＋班級＋學生姓名對照（分開撈、前端用 Map 對應） */
export type RosterContext = {
  enrollments: any[];
  classById: Map<string, any>;
  nameByNo: Map<string, string>;
  error?: string;
};

export async function loadRosterContext(): Promise<RosterContext> {
  const [enr, cls, stu] = await Promise.all([
    fetchAllPaged((from, to) =>
      supabase.from('enrollments').select('id, student_no, class_id, term, seat_no, is_current').order('id').range(from, to)
    ),
    fetchAllPaged((from, to) =>
      supabase.from('classes').select('id, academic_year, department, grade_level, class_name').order('id').range(from, to)
    ),
    fetchAllPaged((from, to) => supabase.from('students').select('student_no, name').order('student_no').range(from, to)),
  ]);
  const error = enr.error?.message ?? cls.error?.message ?? stu.error?.message;
  return {
    enrollments: enr.data as any[],
    classById: new Map((cls.data as any[]).map((c) => [c.id, c])),
    nameByNo: new Map((stu.data as any[]).map((s) => [s.student_no, s.name])),
    error,
  };
}

/** 學生基本資料：students 表全部欄位（含已退學/轉出但仍有資料的學生） */
export async function fetchStudentsMasterSheet(): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase
      .from('students')
      .select('student_no, name, gender, thai_name, dob, id_number, nationality, religion, blood_type, address, phone, photo_url, previous_school, previous_school_grade')
      .order('student_no')
      .range(from, to)
  );
  if (error) return failSheet(STUDENTS_MASTER_SHEET_NAME, error.message);
  return {
    name: STUDENTS_MASTER_SHEET_NAME,
    aoa: [
      ['學號', '姓名', '性別', '泰文姓名', '生日', '證號', '國籍', '宗教', '血型', '住址', '電話', '照片網址', '前一所學校', '前一所學校年級'],
      ...(data as any[]).map((r) => [r.student_no, r.name, r.gender, r.thai_name, r.dob, r.id_number, r.nationality, r.religion, r.blood_type, r.address, r.phone, r.photo_url, r.previous_school, r.previous_school_grade]),
    ],
  };
}

export async function fetchTeachersSheet(): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) => supabase.from('teachers').select('id, name, app_user_id').order('id').range(from, to));
  if (error) return failSheet(TEACHERS_SHEET_NAME, error.message);
  return { name: TEACHERS_SHEET_NAME, aoa: [['教師代碼(id)', '姓名', '帳號代碼(app_user_id)'], ...(data as any[]).map((r) => [r.id, r.name, r.app_user_id ?? ''])] };
}

/** 所有學期的學籍（含 is_current=false 的舊學籍）——「全校成績(現況)」只看現行學籍，舊學期靠這張表對應回班級/座號 */
export function buildEnrollmentHistorySheet(ctx: RosterContext): SheetRows {
  if (ctx.error) return failSheet(ENROLLMENT_HISTORY_SHEET_NAME, ctx.error);
  const rows = ctx.enrollments.map((e) => {
    const c = ctx.classById.get(e.class_id);
    return [c?.academic_year ?? '', e.term, c?.department ?? '', c?.grade_level ?? '', c?.class_name ?? '', e.seat_no, e.student_no, ctx.nameByNo.get(e.student_no) ?? '', e.is_current ? 'V' : ''];
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[4]).localeCompare(String(b[4])) || Number(a[5]) - Number(b[5]));
  return { name: ENROLLMENT_HISTORY_SHEET_NAME, aoa: [['學年度', '學期', '部別', '年級', '班級', '座號', '學號', '姓名', '目前學籍(V)'], ...rows] };
}

export async function fetchRemarksAllSheet(ctx: RosterContext): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase.from('student_remarks').select('enrollment_id, comment').order('enrollment_id').range(from, to)
  );
  if (error) return failSheet(REMARKS_ALL_SHEET_NAME, error.message);
  const enrById = new Map(ctx.enrollments.map((e) => [e.id, e]));
  return {
    name: REMARKS_ALL_SHEET_NAME,
    aoa: [
      ['學年度', '學期', '班級', '座號', '學號', '姓名', '導師評語'],
      ...(data as any[]).map((r) => {
        const e = enrById.get(r.enrollment_id);
        const c = e ? ctx.classById.get(e.class_id) : null;
        return [c?.academic_year ?? '', e?.term ?? '', c?.class_name ?? '', e?.seat_no ?? '', e?.student_no ?? '', e ? ctx.nameByNo.get(e.student_no) ?? '' : '', r.comment ?? ''];
      }),
    ],
  };
}

export async function fetchConductScoresAllSheet(ctx: RosterContext): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase.from('conduct_scores').select('enrollment_id, politeness, dress, service, discipline').order('enrollment_id').range(from, to)
  );
  if (error) return failSheet(CONDUCT_SCORES_ALL_SHEET_NAME, error.message);
  const enrById = new Map(ctx.enrollments.map((e) => [e.id, e]));
  return {
    name: CONDUCT_SCORES_ALL_SHEET_NAME,
    aoa: [
      ['學年度', '學期', '部別', '年級', '班級', '座號', '學號', '姓名', '禮貌', '衣著', '服務', '紀律', '目前學籍(V)'],
      ...(data as any[]).map((r) => {
        const e = enrById.get(r.enrollment_id);
        const c = e ? ctx.classById.get(e.class_id) : null;
        return [c?.academic_year ?? '', e?.term ?? '', c?.department ?? '', c?.grade_level ?? '', c?.class_name ?? '', e?.seat_no ?? '', e?.student_no ?? '', e ? ctx.nameByNo.get(e.student_no) ?? '' : '', r.politeness ?? '', r.dress ?? '', r.service ?? '', r.discipline ?? '', e?.is_current ? 'V' : ''];
      }),
    ],
  };
}

export async function fetchGuardiansSheet(ctx: RosterContext): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase.from('guardians').select('id, student_no, relation, name, chinese_name, occupation, phone, email, address').order('id').range(from, to)
  );
  if (error) return failSheet(GUARDIANS_SHEET_NAME, error.message);
  return {
    name: GUARDIANS_SHEET_NAME,
    aoa: [
      ['學號', '學生姓名', '關係', '姓名', '中文姓名', '職業', '電話', '電子郵件', '住址'],
      ...(data as any[]).map((r) => [r.student_no, ctx.nameByNo.get(r.student_no) ?? '', r.relation, r.name, r.chinese_name, r.occupation, r.phone, r.email, r.address]),
    ],
  };
}

export async function fetchScoreAdjustmentsSheet(): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase.from('score_adjustments').select('academic_year, term, name, points, is_active').order('id').range(from, to)
  );
  if (error) return failSheet(SCORE_ADJUSTMENTS_SHEET_NAME, error.message);
  return { name: SCORE_ADJUSTMENTS_SHEET_NAME, aoa: [['學年度', '學期', '名稱', '加扣分', '啟用中(V)'], ...(data as any[]).map((r) => [r.academic_year, r.term, r.name, r.points, r.is_active ? 'V' : ''])] };
}

export async function fetchStatusChangesSheet(ctx: RosterContext): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase.from('student_status_changes').select('id, student_no, status, effective_date, reason, created_at').order('id').range(from, to)
  );
  if (error) return failSheet(STATUS_CHANGES_SHEET_NAME, error.message);
  return {
    name: STATUS_CHANGES_SHEET_NAME,
    aoa: [['學號', '姓名', '狀態', '生效日', '原因', '建立時間'], ...(data as any[]).map((r) => [r.student_no, ctx.nameByNo.get(r.student_no) ?? '', r.status, r.effective_date, r.reason, r.created_at])],
  };
}

/* -------------------- 完整性核對 -------------------- */

export type IntegrityItem = {
  label: string; // 項目名稱
  table: string; // 資料表
  exported: number; // 這份檔案裡實際輸出的筆數
  /** 只比對特定學年度/學期（跟下載時的篩選條件一致）時使用 */
  filter?: Record<string, string | number>;
};

/** 「資料表真實筆數」vs「這份快照實際輸出的筆數」：不一致就代表下載不完整，檔案裡最前面那張工作表會直接標示 */
export async function buildIntegritySheet(items: IntegrityItem[]): Promise<{ sheet: SheetRows; problems: string[] }> {
  const rows: any[][] = [];
  const problems: string[] = [];
  const results = await Promise.all(
    items.map(async (it) => {
      let q = supabase.from(it.table).select('*', { count: 'exact', head: true });
      Object.entries(it.filter ?? {}).forEach(([col, val]) => {
        q = q.eq(col, val);
      });
      const { count, error } = await q;
      return { it, count, error };
    })
  );
  for (const { it, count, error } of results) {
    if (error || count === null) {
      rows.push([it.label, it.table, '無法取得', it.exported, '⚠️ 無法核對：' + (error?.message ?? '未知錯誤')]);
      problems.push(`${it.label}：無法核對（${error?.message ?? '未知錯誤'}）`);
    } else if (count === it.exported) {
      rows.push([it.label, it.table, count, it.exported, '✓ 一致']);
    } else {
      rows.push([it.label, it.table, count, it.exported, `⚠️ 不一致（差 ${count - it.exported} 筆）`]);
      problems.push(`${it.label}：資料庫 ${count} 筆／本檔 ${it.exported} 筆`);
    }
  }
  const header = [
    ['【下載完整性核對】資料庫實際筆數 vs 這份檔案輸出筆數。只要有「⚠️」就代表這份檔案不完整，請不要拿來當作唯一備份。'],
    ['項目', '資料表', '資料庫筆數', '本檔筆數', '結果'],
  ];
  return { sheet: { name: INTEGRITY_SHEET_NAME, aoa: [...header, ...rows] }, problems };
}

