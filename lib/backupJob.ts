import type { SupabaseClient } from '@supabase/supabase-js';
import { BACKUP_TABLES, type BackupCounts, type BackupSnapshot } from './backupRestore';

// ============================================================
// 分段備份（可續跑）
// ------------------------------------------------------------
// 【根因】備份原本是「一次 HTTP 請求」裡把 65 張表全部撈完。其中 attendance
// （全校整學期每一節的出缺勤，數十萬列）、scores 這類大表，每頁只能撈 1000 筆，
// 光是來回的網路請求就要幾百次；總時間一旦超過平台對單次請求的上限，平台會直接
// 切斷連線（HTTP 504），不管程式裡宣告 maxDuration 多大、也不管用多少並行都一樣——
// 資料量只會越來越多，這種「一次做完」的設計遲早都會撞牆。
//
// 【做法】把備份拆成很多個「短請求」：每次請求只做 STEP_BUDGET_MS 這麼久（預設
// 20 秒，遠低於各種方案的上限），做到哪裡就把進度（目前在第幾張表、撈到第幾筆）
// 存在 Storage，下一次請求接著做；撈到的資料每約 PART_ROWS 列寫成一個分段檔。
// 全部撈完後只寫一個很小的 manifest（分段檔清單），backups 表那一列的
// storage_path 指向這個 manifest；loadBackupSnapshot() 讀到 manifest 時會把各分段
// 檔讀回來合併，還原／下載的呼叫端完全不用改。
// 手動備份由前端迴圈呼叫、顯示進度；每日自動備份由排程呼叫，沒做完會在下一次
// 排程（或有人手動按備份）時自動接續，不會重頭來過。
// ============================================================

const BUCKET = 'backup-uploads';
const PAGE_SIZE = 1000;
const PARALLEL_PAGES = 4; // 同一張表同時撈幾頁
const PART_ROWS = 20000; // 每個分段檔最多幾列
export const STEP_BUDGET_MS = 20000;

type TableState = {
  done: boolean;
  offset: number; // 已經撈到並寫進分段檔的列數
  parts: string[]; // 這張表的分段檔路徑
  ordered: boolean; // 是否用 id 排序（沒有 id 欄位的表退回不排序）
  skipped?: boolean; // 資料表不存在／讀取失敗，略過
};

export type BackupJobState = {
  jobId: string;
  kind: '自動' | '手動';
  createdBy: string | null;
  startedAt: string;
  tableIdx: number;
  tables: Record<string, TableState>;
  counts: BackupCounts;
  backupId?: string;
  backupCreatedAt?: string;
  finished?: boolean;
};

export type BackupJobProgress = {
  jobId: string;
  done: boolean;
  tableIdx: number;
  totalTables: number;
  currentTable: string | null;
  rowsInCurrentTable: number;
  id?: string;
  created_at?: string;
  counts?: BackupCounts;
};

const statePath = (jobId: string) => `jobs/${jobId}/state.json`;
const manifestPath = (jobId: string) => `jobs/${jobId}/manifest.json`;
const CURRENT_POINTER = 'jobs/current.json'; // 自動備份用：記錄目前未完成的 job

async function putJson(admin: SupabaseClient, path: string, value: unknown) {
  const { error } = await admin.storage
    .from(BUCKET)
    .upload(path, Buffer.from(JSON.stringify(value), 'utf-8'), { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`寫入儲存空間失敗（${path}）：${error.message}`);
}

async function getJson<T>(admin: SupabaseClient, path: string): Promise<T | null> {
  const { data, error } = await admin.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try {
    return JSON.parse(await data.text()) as T;
  } catch {
    return null;
  }
}

export async function startBackupJob(admin: SupabaseClient, kind: '自動' | '手動', createdBy: string | null): Promise<BackupJobState> {
  const jobId = `${new Date().toISOString().slice(0, 10)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tables: Record<string, TableState> = {};
  BACKUP_TABLES.forEach((t) => (tables[t] = { done: false, offset: 0, parts: [], ordered: true }));
  const state: BackupJobState = { jobId, kind, createdBy, startedAt: new Date().toISOString(), tableIdx: 0, tables, counts: {} };
  await putJson(admin, statePath(jobId), state);
  if (kind === '自動') await putJson(admin, CURRENT_POINTER, { jobId, startedAt: state.startedAt });
  return state;
}

/** 自動備份用：有沒有一個還沒做完、而且不太舊（36 小時內）的 job 可以接續 */
export async function findResumableJob(admin: SupabaseClient): Promise<BackupJobState | null> {
  const ptr = await getJson<{ jobId: string; startedAt: string }>(admin, CURRENT_POINTER);
  if (!ptr) return null;
  if (Date.now() - new Date(ptr.startedAt).getTime() > 36 * 3600 * 1000) return null;
  const state = await getJson<BackupJobState>(admin, statePath(ptr.jobId));
  if (!state || state.finished) return null;
  return state;
}

export async function loadJob(admin: SupabaseClient, jobId: string): Promise<BackupJobState | null> {
  if (!/^[0-9A-Za-z-]+$/.test(jobId)) return null;
  return getJson<BackupJobState>(admin, statePath(jobId));
}

async function fetchPage(admin: SupabaseClient, table: string, ordered: boolean, from: number) {
  let q = admin.from(table).select('*');
  if (ordered) q = q.order('id', { ascending: true });
  return q.range(from, from + PAGE_SIZE - 1);
}

/**
 * 在 budgetMs 內盡量往前做，做不完就存進度回傳（done=false），呼叫端再叫一次即可接續。
 * 全部做完時寫入 manifest、並在 backups 表新增一列。
 */
export async function stepBackupJob(admin: SupabaseClient, state: BackupJobState, budgetMs = STEP_BUDGET_MS): Promise<BackupJobProgress> {
  const deadline = Date.now() + budgetMs;
  const total = BACKUP_TABLES.length;

  while (state.tableIdx < total && Date.now() < deadline) {
    const table = BACKUP_TABLES[state.tableIdx];
    const ts = state.tables[table];
    if (ts.done) {
      state.tableIdx++;
      continue;
    }

    let buffer: any[] = [];
    let failed: any = null;
    let reachedEnd = false;

    const flush = async () => {
      if (buffer.length === 0) return;
      const path = `jobs/${state.jobId}/${table}.${ts.parts.length}.json`;
      await putJson(admin, path, buffer);
      ts.parts.push(path);
      ts.offset += buffer.length;
      buffer = [];
    };

    while (!reachedEnd && !failed && Date.now() < deadline) {
      const from = ts.offset + buffer.length;
      const pageStarts = Array.from({ length: PARALLEL_PAGES }, (_, i) => from + i * PAGE_SIZE);
      let results = await Promise.all(pageStarts.map((f) => fetchPage(admin, table, ts.ordered, f)));

      // 這張表沒有 id 欄位（複合主鍵／文字主鍵）：改成不排序重試一次，之後固定不排序
      if (ts.ordered && ts.offset === 0 && buffer.length === 0 && results[0].error && /id/i.test(results[0].error.message ?? '') && /column|42703/i.test(`${results[0].error.message} ${results[0].error.code}`)) {
        ts.ordered = false;
        results = await Promise.all(pageStarts.map((f) => fetchPage(admin, table, ts.ordered, f)));
      }

      for (const r of results) {
        if (r.error) {
          failed = r.error;
          break;
        }
        const rows = r.data ?? [];
        buffer.push(...rows);
        if (rows.length < PAGE_SIZE) {
          reachedEnd = true;
          break; // 這一頁不足一頁，後面的頁一定是空的
        }
      }
      if (buffer.length >= PART_ROWS) await flush();
    }

    if (failed) {
      // 資料表不存在（該專案沒執行過那個選擇性 SQL 檔）或其他讀取問題：略過，跟舊版行為一致
      // 但已經撈到一半的表不能默默變成不完整的備份——只有「從頭就失敗」才當成略過，
      // 撈到一半才失敗就整個備份失敗，讓人知道要重來。
      if (ts.offset === 0 && buffer.length === 0 && ts.parts.length === 0) {
        ts.done = true;
        ts.skipped = true;
        state.counts[table] = null;
        state.tableIdx++;
        continue;
      }
      throw new Error(`讀取資料表 ${table} 失敗：${failed.message ?? JSON.stringify(failed)}`);
    }

    await flush();
    if (reachedEnd) {
      ts.done = true;
      state.counts[table] = ts.offset;
      state.tableIdx++;
    }
    // 沒到結尾就是時間用完了，外層 while 會因為 deadline 結束
  }

  if (state.tableIdx >= total) return finalizeJob(admin, state);

  await putJson(admin, statePath(state.jobId), state);
  const cur = BACKUP_TABLES[state.tableIdx] ?? null;
  return {
    jobId: state.jobId,
    done: false,
    tableIdx: state.tableIdx,
    totalTables: total,
    currentTable: cur,
    rowsInCurrentTable: cur ? state.tables[cur].offset : 0,
  };
}

async function finalizeJob(admin: SupabaseClient, state: BackupJobState): Promise<BackupJobProgress> {
  const total = BACKUP_TABLES.length;
  if (!state.backupId) {
    const parts: Record<string, string[] | null> = {};
    BACKUP_TABLES.forEach((t) => {
      const ts = state.tables[t];
      parts[t] = ts.skipped ? null : ts.parts;
    });
    await putJson(admin, manifestPath(state.jobId), { format: 'parts', version: 1, parts });
    const { data, error } = await admin
      .rpc('admin_insert_backup', {
        p_kind: state.kind,
        p_created_by: state.createdBy,
        p_tables: null,
        p_table_counts: state.counts,
        p_storage_path: manifestPath(state.jobId),
      })
      .single();
    if (error || !data) {
      throw new Error('備份資料已全部讀取，但寫入備份紀錄失敗：' + (error?.message ?? '未知錯誤'));
    }
    state.backupId = (data as any).id;
    state.backupCreatedAt = (data as any).created_at;
  }
  state.finished = true;
  await putJson(admin, statePath(state.jobId), state);
  if (state.kind === '自動') await admin.storage.from(BUCKET).remove([CURRENT_POINTER]);
  return {
    jobId: state.jobId,
    done: true,
    tableIdx: total,
    totalTables: total,
    currentTable: null,
    rowsInCurrentTable: 0,
    id: state.backupId,
    created_at: state.backupCreatedAt,
    counts: state.counts,
  };
}
