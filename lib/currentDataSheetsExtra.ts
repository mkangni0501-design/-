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
