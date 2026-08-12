import { SupabaseClient } from '@supabase/supabase-js';

// 依「先建立/父層 → 後建立/子層」順序排列：還原時會反過來、先刪子層再刪父層再插入，
// 這樣才不會因為外鍵關聯（例如 enrollments 需要先有 classes/students）而失敗。
//
// 刻意不包含 app_users、portal_accounts、account_audit_log：
// - app_users / portal_accounts 是跟 Supabase Auth 的登入帳號（auth.users）綁在一起的，
//   如果連這個也整批覆蓋，備份之後、還原之前新增/停用過的帳號會對不起來，很可能造成沒有人能登入。
//   帳號本身的救援請改用「帳號管理」頁個別處理。
// - account_audit_log 是異動紀錄，還原資料不應該倒退或抹掉這份稽核軌跡。
//
// 部分資料表來自選擇性執行過的 SQL（registration.sql / promotion.sql 等），
// 如果專案沒有執行那些檔案、資料表不存在，備份/還原時會自動略過該表，不會讓整個流程失敗。
//
// app_user_departments／app_user_module_overrides 這兩張表裡的 app_user_id 是外鍵，
// 指向 app_users（app_users 本身刻意不備份，理由同上）。這代表「還原」只適合用在
// 同一個 Supabase 專案的災難復原（帳號本身都還在，只是資料被誤刪/改壞想retreat回去），
// 不能拿一份備份去「搬到另一個全新的 Supabase 專案」重建——那邊的 app_users id 會對不起來，
// 插入這兩張表時會直接失敗。要整個搬家到新專案，請改用「開發人員區」的整批 Excel
// 下載/上傳，或直接請開發人員協助搬移 auth.users／app_users。
export const BACKUP_TABLES = [
  'teachers',
  'students',
  'classes',
  'class_schedule',
  'curriculum',
  'grading_rules',
  'score_adjustments',
  'conduct_point_defaults',
  'conduct_events',
  'period_config',
  'enrollments',
  'scores',
  'attendance',
  'attendance_notifications',
  'staff_notifications',
  'student_remarks',
  'submission_windows',
  'correction_requests',
  'guardians',
  'student_status_changes',
  'status_change_attachments',
  'profile_edit_requests',
  'grade_progression',
  'scheduler_backups',
  'academic_terms',
  'substitute_assignments',
  'locked_periods',
  'attendance_alert_settings',
  'general_inventory_items',
  'general_inventory_transactions',
  'maintenance_tickets',
  'utility_bills',
  'app_user_departments',
  'app_user_module_overrides',
  'admin_module_categories',
  'governed_tables',
  'pending_changes',
  'bulletin_posts',
] as const;

// 大部分資料表拿 id（uuid）當「符合全部列」的比對欄位；少數是複合主鍵或文字主鍵，這裡特別列出。
// 這個欄位一定要是 not null，才能用 `.not(column, 'is', null)` 撈到/刪到全部列。
const MATCH_ALL_COLUMN: Record<string, string> = {
  grading_rules: 'academic_year',
  conduct_point_defaults: 'item',
};

function matchAllColumn(table: string) {
  return MATCH_ALL_COLUMN[table] ?? 'id';
}

export type BackupSnapshot = Record<string, any[] | null>; // null = 該表不存在/略過
export type BackupCounts = Record<string, number | null>;

// 【2026-08-11 修正】根因：runBackup() 原本每張表只發一次 `select('*')`，沒有用
// `.range()` 分頁——PostgREST（Supabase 的 API 層）預設對「沒有明確指定 range」
// 的查詢會套用伺服器端設定的單次回傳上限（這個專案上限似乎是 1000 筆，但不同表現
// 也可能因為 Supabase 專案設定而不同，例如回報的學生 1000 筆／成績 2000 筆）。
// 超過上限的資料會被「靜默截斷」——不會回傳錯誤，`data` 就只有前面那一批，導致
// 備份檔案看起來成功、筆數卻遠低於實際資料量，等於做了一份不完整、不能拿來真正
// 復原的備份。修正方式：改成用 `.range()` 依 PAGE_SIZE 分頁撈到底（撈到回傳筆數
// 小於 PAGE_SIZE 才停止），不管伺服器單次上限是多少，都能確保撈到全部資料。
const PAGE_SIZE = 1000;

async function fetchAllRows(admin: SupabaseClient, table: string): Promise<{ data: any[] | null; error: any }> {
  const rows: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from(table)
      .select('*')
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break; // 這一批不足一頁，代表已經撈到最後一批
    from += PAGE_SIZE;
  }
  return { data: rows, error: null };
}

export async function runBackup(admin: SupabaseClient): Promise<{ tables: BackupSnapshot; counts: BackupCounts }> {
  const tables: BackupSnapshot = {};
  const counts: BackupCounts = {};

  for (const table of BACKUP_TABLES) {
    const { data, error } = await fetchAllRows(admin, table);
    if (error) {
      // 資料表不存在（該專案沒執行過那個選擇性 SQL 檔）或其他讀取問題，略過但留紀錄
      tables[table] = null;
      counts[table] = null;
      continue;
    }
    tables[table] = data ?? [];
    counts[table] = (data ?? []).length;
  }

  return { tables, counts };
}

const CHUNK_SIZE = 500;

export async function restoreBackup(
  admin: SupabaseClient,
  snapshot: BackupSnapshot
): Promise<{ restoredTables: string[]; skippedTables: string[]; errors: string[] }> {
  const restoredTables: string[] = [];
  const skippedTables: string[] = [];
  const errors: string[] = [];

  const tablesWithData = BACKUP_TABLES.filter((t) => Array.isArray(snapshot[t]));

  // 先刪：反過來，子層先刪
  for (const table of [...tablesWithData].reverse()) {
    const { error } = await admin.from(table).delete().not(matchAllColumn(table), 'is', null);
    if (error) {
      errors.push(`清空 ${table} 失敗：${error.message}`);
    }
  }

  // 再插：依父層→子層順序，並且分批避免單次 payload 太大
  for (const table of tablesWithData) {
    const rows = snapshot[table] as any[];
    if (rows.length === 0) {
      restoredTables.push(table);
      continue;
    }
    let tableOk = true;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { error } = await admin.from(table).insert(chunk);
      if (error) {
        errors.push(`還原 ${table} 第 ${i + 1}-${i + chunk.length} 筆失敗：${error.message}`);
        tableOk = false;
        break;
      }
    }
    if (tableOk) restoredTables.push(table);
  }

  BACKUP_TABLES.forEach((t) => {
    if (!tablesWithData.includes(t)) skippedTables.push(t);
  });

  return { restoredTables, skippedTables, errors };
}
