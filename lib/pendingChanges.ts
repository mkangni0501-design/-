import { supabase } from '@/lib/supabaseClient';
import { AdminDepartment, MyDepartment, isDepartmentLead } from '@/lib/departments';

// 對應 sql/02_pending_changes_approval_system.sql 的 governed_tables 白名單。
// B（承辦人員）對這些表的新增/修改/刪除，一律要送審；A（部門主管）或系統管理員S可以直接寫。
// 這份清單要跟資料庫 governed_tables 表的內容保持一致，日後資料庫新增受管表時這裡也要一併補上。
export const GOVERNED_TABLES: Record<string, { pk: string; department: AdminDepartment }> = {
  curriculum: { pk: 'id', department: 'academic' },
  class_schedule: { pk: 'id', department: 'academic' },
  period_config: { pk: 'id', department: 'academic' },
  grade_progression: { pk: 'department,grade_level', department: 'academic' },
  grading_rules: { pk: 'academic_year,term', department: 'academic' },
  attendance_alert_settings: { pk: 'id', department: 'discipline' },
  conduct_point_defaults: { pk: 'item', department: 'discipline' },
  locked_periods: { pk: 'id', department: 'academic' },
  general_inventory_items: { pk: 'id', department: 'general' },
  general_inventory_transactions: { pk: 'id', department: 'general' },
  maintenance_tickets: { pk: 'id', department: 'general' },
  utility_bills: { pk: 'id', department: 'general' },
  // 【2026-08 修正】sql/23academic_terms_and_substitute_teaching.sql 資料庫端早就把
  // substitute_assignments 登記進 governed_tables 白名單、RLS 政策也要求非教務主管(lead)
  // 要走送審機制，但這裡（TS端呼叫 writeGoverned 用的白名單）一直漏了這筆，加上
  // 代課安排頁面原本也沒有呼叫 writeGoverned，兩邊疊加造成「教務承辦人員」帳號
  // 一寫入代課安排就被 RLS 擋下、代課功能形同無法使用。
  substitute_assignments: { pk: 'id', department: 'academic' },
};

export type PendingOperation = 'insert' | 'update' | 'delete';

export type WriteResult = { error: string | null; pending: boolean; data?: any };

/**
 * 受管資料表的統一寫入函式：
 * - 部門主管(lead)或系統管理員S：直接寫進正式資料表（維持原本行為）。
 * - 部門承辦人員(staff)：改成 insert 一筆到 pending_changes，等主管核准後才真正生效。
 *
 * recordKey：update/delete 時，該筆資料的主鍵值（多欄位主鍵請用同樣的組合字串，例如 grade_progression 用 `${department}|${grade_level}`）。
 * beforeSnapshot：update/delete 前的原始資料，方便主管核准時比對差異（非必填，但建議補上）。
 */
export async function writeGoverned(
  table: keyof typeof GOVERNED_TABLES,
  operation: PendingOperation,
  payload: Record<string, unknown>,
  opts: {
    myDepartments: MyDepartment[];
    isSystemAdmin: boolean;
    requestedBy: string;
    recordKey?: string;
    beforeSnapshot?: Record<string, unknown> | null;
  }
): Promise<WriteResult> {
  const meta = GOVERNED_TABLES[table];
  if (!meta) return { error: `${String(table)} 不在受管資料表清單內`, pending: false };

  const canWriteDirect = opts.isSystemAdmin || isDepartmentLead(opts.myDepartments, meta.department);

  if (canWriteDirect) {
    if (operation === 'insert') {
      // 直接寫入時額外 .select().single() 把新增出來的那筆資料回傳給呼叫端——
      // 有些畫面（例如新增商品時要順便寫入「初始庫存」這筆交易紀錄）需要拿到剛剛
      // insert 出來的 id 才能接著做下一步，原本這裡完全不回傳資料，呼叫端只能自己再查一次。
      // 送審（staff）流程本來就還沒有真正的資料列可以回傳，data 維持 undefined。
      const { data, error } = await supabase.from(table).insert(payload).select().single();
      return { error: error ? error.message : null, pending: false, data: error ? undefined : data };
    }
    if (operation === 'update') {
      if (!opts.recordKey) return { error: '缺少要更新的資料主鍵', pending: false };
      const query = supabase.from(table).update(payload);
      applyKeyFilter(query, meta.pk, opts.recordKey);
      const { error } = await query;
      return { error: error ? error.message : null, pending: false };
    }
    // delete
    if (!opts.recordKey) return { error: '缺少要刪除的資料主鍵', pending: false };
    const query = supabase.from(table).delete();
    applyKeyFilter(query, meta.pk, opts.recordKey);
    const { error } = await query;
    return { error: error ? error.message : null, pending: false };
  }

  // staff：送審，不直接寫資料表
  const { error } = await supabase.from('pending_changes').insert({
    department: meta.department,
    table_name: table,
    operation,
    record_key: operation === 'insert' ? null : opts.recordKey,
    payload,
    before_snapshot: opts.beforeSnapshot ?? null,
    requested_by: opts.requestedBy,
  });
  return { error: error ? error.message : null, pending: !error };
}

// 支援單一或組合主鍵（例如 grade_progression 的 department,grade_level）用 `|` 串接後傳入 recordKey
function applyKeyFilter(query: any, pkColumns: string, recordKey: string) {
  const cols = pkColumns.split(',');
  const vals = recordKey.split('|');
  cols.forEach((col, i) => query.eq(col, vals[i]));
}

export type PendingChangeRow = {
  id: string;
  department: AdminDepartment;
  table_name: string;
  operation: PendingOperation;
  record_key: string | null;
  payload: Record<string, unknown>;
  before_snapshot: Record<string, unknown> | null;
  requested_by: string;
  requested_at: string;
  status: '待審核' | '已核准' | '已駁回';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  applied_at: string | null;
};

/** 主管：讀取自己部門待審核（或全部）的送審清單 */
export async function fetchPendingChanges(department: AdminDepartment, status?: PendingChangeRow['status']) {
  let query = supabase.from('pending_changes').select('*').eq('department', department).order('requested_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  return { data: (data ?? []) as PendingChangeRow[], error: error ? error.message : null };
}

/** 承辦人員：讀取自己送出的送審紀錄 */
export async function fetchMyPendingChanges(requestedBy: string) {
  const { data, error } = await supabase
    .from('pending_changes')
    .select('*')
    .eq('requested_by', requestedBy)
    .order('requested_at', { ascending: false });
  return { data: (data ?? []) as PendingChangeRow[], error: error ? error.message : null };
}

/** 主管：核准或駁回。核准後資料庫觸發器(trg_apply_on_approve)會自動寫進正式資料表。 */
export async function reviewPendingChange(id: string, approve: boolean, reviewNote: string, reviewerId: string) {
  const { error } = await supabase
    .from('pending_changes')
    .update({
      status: approve ? '已核准' : '已駁回',
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
      review_note: reviewNote || null,
    })
    .eq('id', id);
  return { error: error ? error.message : null };
}
