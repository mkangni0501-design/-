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
  // 【本輪新增】對照 sql/28 到 sql/65 逐一核對後，發現這幾張表在這幾輪陸續加入
  // 系統，但一直沒有補進備份/還原範圍——這代表這一輪之前，用「備份與還原」還原
  // 資料庫的話，這些表的資料完全不會被還原回去；一併補上：
  'conduct_scores', // ConductScoresTab.tsx 老師登錄的德育/操行成績（guardians 已在上面清單中，不重複列）
  'teacher_service_certificates', // 開發人員區「聘書」：歷年教師資料
  'teacher_appointment_letters', // 開發人員區「聘書」：自聘/當年教師聘書
  'teacher_letter_settings', // 開發人員區「聘書」設定
  'admin_module_order', // 管理後台功能卡片排序
  'site_content', // 首頁公佈欄以外的其他站台內容設定
  'site_settings', // 站台整體設定
  'submission_window_audit_log', // 成績鎖定/解鎖稽核紀錄
  'report_card_style', // 成績單樣式設定
  'report_card_merge_template', // 成績單合併列印範本設定
  'portal_login_settings', // 家長/學生登入入口設定
  'password_policy_settings', // 密碼政策設定（本輪新增的出缺席開關另見 attendance_score_display_settings）
  'teacher_login_settings', // 教師登入首頁設定
  'attendance_score_display_settings', // 本輪新增：出缺席不含蓋期中/期末/平時開關
  'clubs',
  'club_members',
  'club_attendance',
  'club_scores',
  'club_selection_windows',
  'club_preferences',
  'conduct_event_requests', // 敘獎分層審核（管理員B→A→S）的申請/審核紀錄（sql/95）
  // 教職員打卡（sql/104）：clock_import_log 只是匯入流水帳，不列入備份
  'clock_shifts',
  'clock_holidays',
  'clock_employee_map',
  'clock_records',
  'clock_day_overrides',
  // 【2026-10 補齊】下面這些表原本完全不在備份範圍：考試分班（exam_*，依外鍵順序：
  // 考試場次 → 試場 → 試場班級/座位 → 座位學生；各班名單送出狀態只依賴場次）與
  // 導師代點名設定。report_card_xlsx_template 是整份 xlsx 二進位檔（bytea），不放進 JSON 備份，
  // 請另外保留原始檔。attendance_audit_log／score_audit_log 是稽核軌跡，跟 account_audit_log
  // 同樣的理由刻意不納入（還原不應該倒退或抹掉稽核紀錄）。
  'exam_sessions',
  'exam_rooms',
  'exam_room_classes',
  'exam_room_seats',
  'exam_seat_students',
  'exam_class_roster_status',
  'homeroom_attendance_assist_settings',
] as const;

// 【2026-10 修正】主鍵「不是單一 id 欄位」的資料表。這份清單有兩個用途：
// 1) 分頁撈資料時一定要依「主鍵」排序——`.range()` 分頁如果沒有排序，PostgreSQL 不保證每次回傳
//    的順序一致，跨多個請求翻頁時同一列可能重複出現、另一列則被跳過，備份檔筆數看起來「差不多」
//    其實有漏。原本這些表（含 students 全校學生名冊）因為沒有 id 欄位被退回「不排序」。
// 2) 還原時「清空整張表」需要一個一定不是 null 的欄位來比對（`.not(col,'is',null)`），
//    原本預設用 id，沒有 id 欄位的表（students／student_remarks／conduct_scores 等）清空會報錯，
//    接著插入又撞主鍵重複，導致這幾張表根本還原不回去。
// 欄位依據 sql/02_constraints_indexes.sql 的 PRIMARY KEY 定義（主鍵欄位一定 not null）。
export const NON_ID_PRIMARY_KEYS: Record<string, string[]> = {
  students: ['student_no'],
  grading_rules: ['academic_year', 'term'],
  conduct_point_defaults: ['item'],
  student_remarks: ['enrollment_id'],
  grade_progression: ['department', 'grade_level'],
  governed_tables: ['table_name'],
  conduct_scores: ['enrollment_id'],
  admin_module_order: ['module_key'],
  site_content: ['content_key'],
  site_settings: ['setting_key'],
  clock_holidays: ['holiday_date'],
  clock_employee_map: ['device_code'],
  exam_seat_students: ['exam_room_seat_id'],
};

/** 分頁時用來排序的欄位（主鍵）：大部分表是 id，少數見 NON_ID_PRIMARY_KEYS */
export function orderColumnsFor(table: string): string[] {
  return NON_ID_PRIMARY_KEYS[table] ?? ['id'];
}

function matchAllColumn(table: string) {
  return orderColumnsFor(table)[0];
}

/** 這個錯誤是不是「資料表根本不存在」（該專案沒執行過那個選擇性 SQL 檔）——只有這種才可以略過；
 *  其他任何讀取錯誤（逾時、網路、權限）都不可以默默略過，否則備份會悄悄少一張表。 */
export function isMissingTableError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code ?? '');
  const msg = String(err.message ?? '');
  return code === '42P01' || code === 'PGRST205' || /could not find the table|does not exist|relation .* does not exist/i.test(msg);
}

/** 依主鍵排序（多欄位就依序 order），讓 `.range()` 跨頁翻頁結果穩定 */
export function applyStableOrder<Q extends { order: (col: string, opts?: { ascending?: boolean }) => Q }>(q: Q, table: string): Q {
  let out = q;
  for (const col of orderColumnsFor(table)) out = out.order(col, { ascending: true });
  return out;
}

export type BackupSnapshot = Record<string, any[] | null>; // null = 該表不存在/略過
export type BackupCounts = Record<string, number | null>;

// 「上傳檔案還原」時，上傳的內容來自使用者手上的檔案，不像從 backups 表讀出來的
// 那樣保證格式正確，這裡做最基本的形狀檢查：必須是物件、不能是陣列，
// 而且至少要有一個 BACKUP_TABLES 認得的表、內容是陣列，否則多半是選錯檔案
// （例如上傳到 Excel 匯出檔、或別的 JSON），及早擋掉、給清楚的錯誤訊息，
// 不要讓它悄悄跑進 restoreBackup() 變成「還原了 0 個資料表」。
export function parseUploadedSnapshot(raw: unknown): { snapshot: BackupSnapshot; matchedTables: string[] } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: '上傳的檔案內容格式不正確（不是一個 JSON 物件）' };
  }
  const snapshot = raw as BackupSnapshot;
  const matchedTables = BACKUP_TABLES.filter((t) => Array.isArray(snapshot[t]));
  if (matchedTables.length === 0) {
    return { error: '上傳的檔案裡看不到任何本系統認得的資料表內容，請確認上傳的是「備份與還原」頁面「下載」按鈕匯出的備份檔' };
  }
  return { snapshot, matchedTables };
}

// 上傳還原完成後，要把上傳的內容存一份進 backups 表（kind = '上傳'）留稽核紀錄，
// 這裡算出跟 runBackup() 回傳格式一致的 table_counts，讓這筆紀錄在清單上跟
// 一般備份紀錄看起來一樣、能一起下載/還原。
export function countsFromSnapshot(snapshot: BackupSnapshot): BackupCounts {
  const counts: BackupCounts = {};
  for (const table of BACKUP_TABLES) {
    counts[table] = Array.isArray(snapshot[table]) ? (snapshot[table] as any[]).length : null;
  }
  return counts;
}

// 【2026-08-11 修正】根因：runBackup() 原本每張表只發一次 `select('*')`，沒有用
// `.range()` 分頁——PostgREST（Supabase 的 API 層）預設對「沒有明確指定 range」
// 的查詢會套用伺服器端設定的單次回傳上限（這個專案上限似乎是 1000 筆，但不同表現
// 也可能因為 Supabase 專案設定而不同，例如回報的學生 1000 筆／成績 2000 筆）。
// 超過上限的資料會被「靜默截斷」——不會回傳錯誤，`data` 就只有前面那一批，導致
// 備份檔案看起來成功、筆數卻遠低於實際資料量，等於做了一份不完整、不能拿來真正
// 復原的備份。修正方式：改成用 `.range()` 依 PAGE_SIZE 分頁撈到底（撈到回傳筆數
// 小於 PAGE_SIZE 才停止），不管伺服器單次上限是多少，都能確保撈到全部資料。
const PAGE_SIZE = 1000;

export async function countTableRows(admin: SupabaseClient, table: string): Promise<{ count: number | null; error: any }> {
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
  return { count: error ? null : count ?? 0, error };
}

async function fetchAllRows(admin: SupabaseClient, table: string): Promise<{ data: any[] | null; error: any }> {
  const rows: any[] = [];
  let from = 0;
  while (true) {
    let data: any[] | null = null;
    let error: any = null;
    // 暫時性錯誤（網路抖動、逾時）重試最多 2 次；資料表不存在則不重試、直接回報
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await applyStableOrder(admin.from(table).select('*'), table).range(from, from + PAGE_SIZE - 1);
      data = res.data as any[] | null;
      error = res.error;
      if (!error || isMissingTableError(error)) break;
    }
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break; // 這一批不足一頁，代表已經撈到最後一批
    from += PAGE_SIZE;
  }
  return { data: rows, error: null };
}

// 【本輪新增】反映事項「備份失敗：未知錯誤」——詳見 sql/97fix_backup_creation_unknown_error.sql
// 的說明。超過這個門檻（字元數，約略對應位元組數）就不要把整包內容塞進單一 RPC
// 參數，改成先上傳到 Storage，backups 這一列只存路徑。3MB 是留了相當大的安全
// 邊際（一般常見的請求大小限制多半在數 MB 到數十 MB 之間），資料量還會持續
// 成長，這個門檻本來就應該抓保守一點。
const INLINE_SIZE_LIMIT = 3 * 1000 * 1000;

/**
 * 把 runBackup() 產生的快照寫進 backups 表——資料量小就直接存進 tables 欄位，
 * 資料量大（超過 INLINE_SIZE_LIMIT）就先上傳到 Storage，欄位只存路徑
 * （storage_path），兩種情況呼叫端完全不用關心，都是呼叫這支函式、拿到跟
 * admin_insert_backup() 一樣的 { id, created_at }。
 */
export async function insertBackupSnapshot(
  admin: SupabaseClient,
  kind: '自動' | '手動' | '上傳',
  createdBy: string | null,
  tables: BackupSnapshot,
  counts: BackupCounts
): Promise<{ data: { id: string; created_at: string } | null; error: any }> {
  const json = JSON.stringify(tables);

  if (json.length <= INLINE_SIZE_LIMIT) {
    const { data, error } = await admin
      .rpc('admin_insert_backup', { p_kind: kind, p_created_by: createdBy, p_tables: tables, p_table_counts: counts })
      .single();
    return { data: data as { id: string; created_at: string } | null, error };
  }

  const path = `snapshots/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  // 用 Buffer 而不是 Blob：Node.js 的 Serverless Function 環境一定有 Buffer，
  // 不用依賴這個執行環境是否提供全域 Blob。
  const { error: uploadErr } = await admin.storage
    .from('backup-uploads')
    .upload(path, Buffer.from(json, 'utf-8'), { contentType: 'application/json' });
  if (uploadErr) {
    return { data: null, error: { message: '備份內容過大，上傳到儲存空間失敗：' + uploadErr.message } };
  }
  const { data, error } = await admin
    .rpc('admin_insert_backup', { p_kind: kind, p_created_by: createdBy, p_tables: null, p_table_counts: counts, p_storage_path: path })
    .single();
  if (error) {
    // 寫入 backups 這一列失敗的話，剛剛上傳的檔案就變孤兒了，清掉避免占空間。
    await admin.storage.from('backup-uploads').remove([path]);
  }
  return { data: data as { id: string; created_at: string } | null, error };
}

/** 依 backups 這一列的 tables／storage_path，取出真正的快照內容——tables 有值就直接用，沒有的話（大檔案）從 Storage 讀出來。 */
export async function loadBackupSnapshot(
  admin: SupabaseClient,
  row: { tables: BackupSnapshot | null; storage_path: string | null }
): Promise<{ snapshot: BackupSnapshot | null; error: any }> {
  if (row.tables) return { snapshot: row.tables, error: null };
  if (!row.storage_path) return { snapshot: null, error: { message: '這筆備份沒有內容也沒有儲存路徑，資料可能已損毀' } };
  const { data: fileBlob, error } = await admin.storage.from('backup-uploads').download(row.storage_path);
  if (error || !fileBlob) return { snapshot: null, error: error ?? { message: '讀取備份檔案失敗' } };
  let parsed: any;
  try {
    parsed = JSON.parse(await fileBlob.text());
  } catch {
    return { snapshot: null, error: { message: '備份檔案內容不是有效的 JSON' } };
  }
  // 分段備份（見 lib/backupJob.ts）：storage_path 指向的是一個很小的 manifest
  // （各資料表的分段檔清單），把分段檔逐個讀回來合併成一份完整快照。
  if (parsed && parsed.format === 'parts' && parsed.parts && typeof parsed.parts === 'object') {
    const snapshot: BackupSnapshot = {};
    for (const [table, paths] of Object.entries(parsed.parts as Record<string, string[] | null>)) {
      if (paths === null) {
        snapshot[table] = null;
        continue;
      }
      const rows: any[] = [];
      for (const partPath of paths) {
        const { data: partBlob, error: partErr } = await admin.storage.from('backup-uploads').download(partPath);
        if (partErr || !partBlob) return { snapshot: null, error: { message: `備份分段檔遺失或讀取失敗：${partPath}` } };
        try {
          const part = JSON.parse(await partBlob.text());
          for (const r of part) rows.push(r);
        } catch {
          return { snapshot: null, error: { message: `備份分段檔內容損毀：${partPath}` } };
        }
      }
      snapshot[table] = rows;
    }
    return { snapshot, error: null };
  }
  return { snapshot: parsed, error: null };
}

// 【本輪修正】反映事項「開發人員的備份一樣發生備份失敗：未知錯誤」——這裡才是
// 真正的根因：BACKUP_TABLES 現在有 65 張以上，原本是 for 迴圈一張一張依序
// await，每張表自己再分頁撈到底——不管單張表多快，65 次「依序」的網路來回
// 疊加起來，總時間很容易超過 Vercel 方案本身的執行時間上限（Hobby 方案常見
// 是幾十秒等級，即使程式碼裡宣告 maxDuration=300 也一樣會被平台強制中止），
// 一旦被平台中止，連線會被直接砍斷、回應不是正常 JSON，前端
// `res.json().catch(() => ({}))` 接不到任何 `.error` 欄位，才會落回「未知
// 錯誤」四個字——這個問題不管伺服器端 catch 區塊的錯誤訊息寫得再詳細都沒用，
// 因為函式根本沒有機會跑到那段程式碼、也沒機會把回應送出去。
// 修法：改成有限並行（同時最多 CONCURRENCY 張表一起撈），用 Promise.all 分批
// 處理，大幅縮短總執行時間，不要讓 65 張表的網路延遲依序疊加。
const BACKUP_CONCURRENCY = 8;

export type RunBackupResult = {
  tables: BackupSnapshot;
  counts: BackupCounts;
  /** 讀取失敗、而且不是「資料表不存在」的表——代表這份備份不完整，呼叫端不可以拿來當作「已經備份好了」 */
  failedTables: { table: string; message: string }[];
  /** 撈到的筆數跟資料庫目前筆數對不上的表（已重撈一次仍對不上） */
  mismatches: { table: string; backedUp: number; inDatabase: number }[];
};

export async function runBackup(admin: SupabaseClient): Promise<RunBackupResult> {
  const tables: BackupSnapshot = {};
  const counts: BackupCounts = {};
  const failedTables: RunBackupResult['failedTables'] = [];
  const mismatches: RunBackupResult['mismatches'] = [];

  async function backupOne(table: string) {
    let res = await fetchAllRows(admin, table);
    if (res.error) {
      if (isMissingTableError(res.error)) {
        tables[table] = null; // 該專案沒執行過那個選擇性 SQL 檔，真的沒有這張表
        counts[table] = null;
      } else {
        tables[table] = null;
        counts[table] = null;
        failedTables.push({ table, message: res.error.message ?? JSON.stringify(res.error) });
      }
      return;
    }
    // 筆數核對：撈完立刻跟資料庫目前筆數比，對不上就整張重撈一次
    let got = res.data ?? [];
    const first = await countTableRows(admin, table);
    if (first.count !== null && first.count !== got.length) {
      const retry = await fetchAllRows(admin, table);
      if (!retry.error) got = retry.data ?? [];
      const second = await countTableRows(admin, table);
      if (second.count !== null && second.count !== got.length) {
        mismatches.push({ table, backedUp: got.length, inDatabase: second.count });
      }
    }
    tables[table] = got;
    counts[table] = got.length;
  }

  for (let i = 0; i < BACKUP_TABLES.length; i += BACKUP_CONCURRENCY) {
    const batch = BACKUP_TABLES.slice(i, i + BACKUP_CONCURRENCY);
    await Promise.all(batch.map((table) => backupOne(table)));
  }

  return { tables, counts, failedTables, mismatches };
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
