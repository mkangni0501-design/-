import { supabase } from './supabaseClient';
import type { SheetRows } from './schoolWideDataQueries';
import { fetchAllPaged } from './schoolWideDataQueries';

// ============================================================
// 【2026-08 新增】管理員S反映「一鍵上傳/下載中功能上有缺失分頁」——原本
// currentDataSheets.ts + BulkExcelPanel.tsx 只涵蓋教務處的8張表（帳號/班級/
// 科目比重/任課教師/課表/節次/加扣分規則/學生）+ 排課系統 + 全校成績/出缺勤/獎懲，
// 完全沒有涵蓋：
//   總務：general_inventory_items／general_inventory_transactions／
//         maintenance_tickets／utility_bills（sql/25general_affairs_five_tables.sql）
//   訓導：attendance_alert_settings／conduct_point_defaults
//         （sql/8attendance_alerts_and_guardian_edit.sql／sql/7conduct_defaults.sql）
//   開發人員：academic_terms（sql/23academic_terms_and_substitute_teaching.sql）
// 這個檔案補上這幾張表的「現況」查詢，讓「下載完整資料快照」真的涵蓋全系統資料
// （教師歷年資料／聘書兩張表已經有自己的下載，見 lib/teacherLetters.ts，這裡不重複）。
// ============================================================

/* -------------------- 訓導 -------------------- */

export const ATTENDANCE_ALERT_SETTINGS_SHEET_NAME = '出缺勤示警門檻設定(現況)';
export async function fetchCurrentAttendanceAlertSettingsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase.from('attendance_alert_settings').select('threshold_periods').eq('id', 1).maybeSingle();
  if (error) return { name: ATTENDANCE_ALERT_SETTINGS_SHEET_NAME, aoa: [['讀取失敗：' + error.message]] };
  return { name: ATTENDANCE_ALERT_SETTINGS_SHEET_NAME, aoa: [['累計節數門檻(事假+病假+曠課)'], [data?.threshold_periods ?? 3]] };
}

export const CONDUCT_POINT_DEFAULTS_SHEET_NAME = '出缺勤獎懲加扣分參考值(現況)';
export async function fetchCurrentConductPointDefaultsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase.from('conduct_point_defaults').select('item, points').order('item');
  if (error || !data) return { name: CONDUCT_POINT_DEFAULTS_SHEET_NAME, aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  return { name: CONDUCT_POINT_DEFAULTS_SHEET_NAME, aoa: [['項目', '加扣分'], ...data.map((r: any) => [r.item, r.points])] };
}

/* -------------------- 總務 -------------------- */

export const GENERAL_INVENTORY_ITEMS_SHEET_NAME = '總務庫存品項(現況)';
export async function fetchCurrentGeneralInventoryItemsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('general_inventory_items')
    .select('category, name, spec, unit, unit_price, quantity_on_hand, note')
    .order('category')
    .order('name');
  if (error || !data) return { name: GENERAL_INVENTORY_ITEMS_SHEET_NAME, aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  return {
    name: GENERAL_INVENTORY_ITEMS_SHEET_NAME,
    aoa: [
      ['分類(書庫/校服/簿本)', '品名', '規格', '單位', '單價', '目前庫存(自動計算,僅供參考)', '備註'],
      ...data.map((r: any) => [r.category, r.name, r.spec, r.unit, r.unit_price, r.quantity_on_hand, r.note]),
    ],
  };
}

export const GENERAL_INVENTORY_TX_SHEET_NAME = '總務庫存進出紀錄(現況)';
export async function fetchCurrentGeneralInventoryTransactionsSheet(): Promise<SheetRows> {
  // 【2026-08 修正】原本 .limit(2000) 看似有給上限，但 PostgREST 伺服器端的單次回傳上限
  // （這個專案是1000）優先生效，實際上還是只會拿到1000筆，`.limit()` 比它大時完全沒用。
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase
      .from('general_inventory_transactions')
      .select('direction, quantity, unit_price_at_time, counterparty, note, recorded_at, general_inventory_items(name)')
      .order('recorded_at', { ascending: false })
      .range(from, to)
  );
  if (error) return { name: GENERAL_INVENTORY_TX_SHEET_NAME, aoa: [['讀取失敗：' + error.message]] };
  return {
    name: GENERAL_INVENTORY_TX_SHEET_NAME,
    aoa: [
      ['品項', '方向(入庫/售出/借出/歸還/調整/報損)', '數量', '單價', '對象(買家/借閱人)', '備註', '時間'],
      ...data.map((r: any) => [r.general_inventory_items?.name ?? '', r.direction, r.quantity, r.unit_price_at_time, r.counterparty, r.note, r.recorded_at]),
    ],
  };
}

export const MAINTENANCE_TICKETS_SHEET_NAME = '總務修繕登記(現況)';
export async function fetchCurrentMaintenanceTicketsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('maintenance_tickets')
    .select('location, issue, status, assigned_to, reported_at, resolved_at, note')
    .order('reported_at', { ascending: false });
  if (error || !data) return { name: MAINTENANCE_TICKETS_SHEET_NAME, aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  return {
    name: MAINTENANCE_TICKETS_SHEET_NAME,
    aoa: [
      ['地點', '問題描述', '狀態(待處理/處理中/已完成/取消)', '承辦廠商/人員', '登記時間', '完成時間', '備註'],
      ...data.map((r: any) => [r.location, r.issue, r.status, r.assigned_to, r.reported_at, r.resolved_at, r.note]),
    ],
  };
}

export const UTILITY_BILLS_SHEET_NAME = '總務水電網路費用(現況)';
export async function fetchCurrentUtilityBillsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('utility_bills')
    .select('category, billing_month, amount, paid, paid_date, note')
    .order('billing_month', { ascending: false });
  if (error || !data) return { name: UTILITY_BILLS_SHEET_NAME, aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  return {
    name: UTILITY_BILLS_SHEET_NAME,
    aoa: [
      ['類別(水費/電費/網路費/其他)', '帳單月份(該月1號)', '金額', '已繳費(V)', '繳費日期', '備註'],
      ...data.map((r: any) => [r.category, r.billing_month, r.amount, r.paid ? 'V' : '', r.paid_date, r.note]),
    ],
  };
}

/* -------------------- 開發人員 -------------------- */

export const ACADEMIC_TERMS_SHEET_NAME = '學年學期設定(現況)';
export async function fetchCurrentAcademicTermsSheet(): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('academic_terms')
    .select('academic_year, term, term_start_date, term_end_date, is_current, status')
    .order('academic_year', { ascending: false })
    .order('term');
  if (error || !data) return { name: ACADEMIC_TERMS_SHEET_NAME, aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  return {
    name: ACADEMIC_TERMS_SHEET_NAME,
    aoa: [
      ['學年度', '學期(上學期/下學期)', '起始日', '結束日', '目前生效(V)', '狀態(規劃中/進行中/已結束)'],
      ...data.map((r: any) => [r.academic_year, r.term, r.term_start_date, r.term_end_date, r.is_current ? 'V' : '', r.status]),
    ],
  };
}

// ============================================================
// 【本輪新增】反映事項「社團/操行成績/樣式設定這幾張也確定要能透過 Excel 一鍵上傳」——
// 這三張過去完全沒有一鍵上傳/下載範圍，這裡補上。社團模組（sql/54clubs_module.sql）
// 有6張表，這裡只納入「社團名冊」（clubs+club_members，學校平常會需要整批建立/搬遷的
// 靜態資料）跟「社團成績」（club_scores，學期末批次登錄用），跟 scores/attendance 一樣
// 需要頻繁操作；club_attendance（社團點名）／club_selection_windows／club_preferences
// （選社流程）本質上是逐日/逐次的操作紀錄或一次性流程設定，不適合用一鍵上傳整批覆蓋
// （跟 submission_windows 目前也不在一鍵上傳範圍是同樣的理由）——如果之後也要納入，
// 請再另外提出，我會照這裡的寫法個別補上。
// ============================================================

/* -------------------- 教務：操行成績（禮貌／衣著／服務／紀律） -------------------- */

export const CONDUCT_SCORES_SHEET_NAME = '操行成績(現況)';
export async function fetchCurrentConductScoresSheet(): Promise<SheetRows> {
  const HEADER = ['學年度', '部別', '年級', '班級', '學期', '座號', '學號', '姓名', '禮貌', '衣著', '服務', '紀律'];
  const { data: enrollRows, error: enrollErr } = await fetchAllPaged((from, to) =>
    supabase
      .from('enrollments')
      .select('id, student_no, seat_no, term, students(name), classes(academic_year, department, grade_level, class_name)')
      .eq('is_current', true)
      .range(from, to)
  );
  if (enrollErr) return { name: CONDUCT_SCORES_SHEET_NAME, aoa: [['讀取失敗：' + enrollErr.message]] };
  const ids = enrollRows.map((r: any) => r.id);
  const { data: conductRows, error: conductErr } =
    ids.length === 0
      ? { data: [] as any[], error: null }
      : await supabase.from('conduct_scores').select('enrollment_id, politeness, dress, service, discipline').in('enrollment_id', ids);
  if (conductErr) return { name: CONDUCT_SCORES_SHEET_NAME, aoa: [['讀取操行成績失敗：' + conductErr.message]] };
  const conductMap = new Map((conductRows ?? []).map((c: any) => [c.enrollment_id, c]));
  const rows = enrollRows
    .map((e: any) => {
      const cls = Array.isArray(e.classes) ? e.classes[0] : e.classes;
      const stu = Array.isArray(e.students) ? e.students[0] : e.students;
      const c = conductMap.get(e.id);
      return [
        cls?.academic_year ?? '',
        cls?.department ?? '',
        cls?.grade_level ?? '',
        cls?.class_name ?? '',
        e.term,
        e.seat_no,
        e.student_no,
        stu?.name ?? '',
        c?.politeness ?? '',
        c?.dress ?? '',
        c?.service ?? '',
        c?.discipline ?? '',
      ];
    })
    .sort((a, b) => (a[3] === b[3] ? Number(a[5]) - Number(b[5]) : String(a[3]).localeCompare(String(b[3]))));
  return { name: CONDUCT_SCORES_SHEET_NAME, aoa: [HEADER, ...rows] };
}

/* -------------------- 開發人員：成績單樣式設定 -------------------- */
// config 是 jsonb（顏色/字級/邊框/文字標籤/圖片網址等一整包設定），直接塞一格 JSON 文字，
// 上傳時原樣 JSON.parse 回去寫入——這裡不逐欄拆開，是因為 config 內部欄位結構是
// lib/ReportCardDocument.tsx／ReportCardStyleTab.tsx 共用的型別（ReportCardStyleConfig），
// 拆成幾十欄 Excel 欄位既難維護也容易漏欄，不如直接原樣搬運整包 JSON。
export const REPORT_CARD_STYLE_SHEET_NAME = '成績單樣式設定(現況)';
export async function fetchCurrentReportCardStyleSheet(): Promise<SheetRows> {
  const { data, error } = await supabase.from('report_card_style').select('name, is_active, config').order('updated_at', { ascending: false });
  if (error) return { name: REPORT_CARD_STYLE_SHEET_NAME, aoa: [['讀取失敗：' + error.message]] };
  return {
    name: REPORT_CARD_STYLE_SHEET_NAME,
    aoa: [
      ['名稱', '目前生效(V)', '設定內容(JSON，請整段搬移，不要手動修改格式)'],
      ...(data ?? []).map((r: any) => [r.name, r.is_active ? 'V' : '', JSON.stringify(r.config)]),
    ],
  };
}

/* -------------------- 教務：社團名冊（clubs + club_members） -------------------- */

export const CLUB_ROSTER_SHEET_NAME = '社團名冊(現況)';
export async function fetchCurrentClubRosterSheet(academicYear: number, term: string): Promise<SheetRows> {
  const HEADER = ['社團名稱', '學年度', '學期', '指導老師(校內)', '外聘老師姓名', '名額上限', '固定節次', '啟用中(V)', '學號', '姓名', '狀態(在社/退社)'];
  const { data: clubs, error: clubErr } = await supabase
    .from('clubs')
    .select('id, name, capacity, period_no, is_active, external_teacher_name, teachers(name)')
    .eq('academic_year', academicYear)
    .eq('term', term)
    .order('name');
  if (clubErr) return { name: CLUB_ROSTER_SHEET_NAME, aoa: [['讀取失敗：' + clubErr.message]] };
  const clubIds = (clubs ?? []).map((c: any) => c.id);
  const { data: members, error: memberErr } =
    clubIds.length === 0
      ? { data: [] as any[], error: null }
      : await supabase.from('club_members').select('club_id, student_no, status, students(name)').in('club_id', clubIds).order('student_no');
  if (memberErr) return { name: CLUB_ROSTER_SHEET_NAME, aoa: [['讀取社團成員失敗：' + memberErr.message]] };
  const membersByClub = new Map<string, any[]>();
  (members ?? []).forEach((m: any) => {
    const arr = membersByClub.get(m.club_id) ?? [];
    arr.push(m);
    membersByClub.set(m.club_id, arr);
  });
  const rows: any[][] = [];
  (clubs ?? []).forEach((c: any) => {
    const teacherName = (Array.isArray(c.teachers) ? c.teachers[0] : c.teachers)?.name ?? '';
    const clubMembers = membersByClub.get(c.id) ?? [];
    const base = [c.name, academicYear, term, teacherName, c.external_teacher_name ?? '', c.capacity ?? '', c.period_no ?? '', c.is_active ? 'V' : ''];
    if (clubMembers.length === 0) {
      rows.push([...base, '', '', '']);
    } else {
      clubMembers.forEach((m: any) => {
        const stu = Array.isArray(m.students) ? m.students[0] : m.students;
        rows.push([...base, m.student_no, stu?.name ?? '', m.status]);
      });
    }
  });
  return { name: CLUB_ROSTER_SHEET_NAME, aoa: [HEADER, ...rows] };
}

/* -------------------- 教務：社團成績 -------------------- */

export const CLUB_SCORES_SHEET_NAME = '社團成績(現況)';
export async function fetchCurrentClubScoresSheet(academicYear: number, term: string): Promise<SheetRows> {
  const HEADER = ['社團名稱', '學年度', '學期', '學號', '姓名', '期中考', '期末考', '平時分', '已送出(V)'];
  const { data: clubs, error: clubErr } = await supabase.from('clubs').select('id, name').eq('academic_year', academicYear).eq('term', term);
  if (clubErr) return { name: CLUB_SCORES_SHEET_NAME, aoa: [['讀取失敗：' + clubErr.message]] };
  const clubIds = (clubs ?? []).map((c: any) => c.id);
  const clubNameById = new Map((clubs ?? []).map((c: any) => [c.id, c.name]));
  const { data: scores, error: scoreErr } =
    clubIds.length === 0
      ? { data: [] as any[], error: null }
      : await supabase
          .from('club_scores')
          .select('club_id, student_no, score_midterm, score_final, score_daily, is_submitted, students(name)')
          .in('club_id', clubIds);
  if (scoreErr) return { name: CLUB_SCORES_SHEET_NAME, aoa: [['讀取社團成績失敗：' + scoreErr.message]] };
  const rows = (scores ?? [])
    .map((s: any) => {
      const stu = Array.isArray(s.students) ? s.students[0] : s.students;
      return [
        clubNameById.get(s.club_id) ?? '',
        academicYear,
        term,
        s.student_no,
        stu?.name ?? '',
        s.score_midterm ?? '',
        s.score_final ?? '',
        s.score_daily ?? '',
        s.is_submitted ? 'V' : '',
      ];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { name: CLUB_SCORES_SHEET_NAME, aoa: [HEADER, ...rows] };
}
