import { supabase } from './supabaseClient';

// 排課工具「備份專案」匯出的 JSON 檔案結構（只列出這裡會用到的欄位，其餘欄位原封不動存進 data）
export type SchedulerEntry = { slot: string; sub: string; teacher: string };
export type SchedulerClassSchedule = { entries: SchedulerEntry[]; slots: string[]; locks?: Record<string, boolean>; homeroomSlots?: Record<string, string> };
export type SchedulerProjectData = {
  version?: number;
  savedAt?: string;
  GRADES: { id: string; name: string; classes: string[]; weekday: number; sat: number; slots: number; subs: { n: string; c: number }[] }[];
  S: {
    teachers: Record<string, Record<string, Record<string, string>>>;
    homerooms: Record<string, string>;
    schedules: Record<string, SchedulerClassSchedule>;
    academicYear?: number;
    term?: string;
  };
};

export type SchedulerBackupRow = {
  id: string;
  academic_year: number;
  term: string;
  note: string | null;
  saved_at: string;
  saved_by: string | null;
};

/** 列出某個學年度／學期已存過的排課工具進度（新到舊） */
export async function listSchedulerBackups(academicYear: number, term: string): Promise<{ rows: SchedulerBackupRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('scheduler_backups')
    .select('id, academic_year, term, note, saved_at, saved_by')
    .eq('academic_year', academicYear)
    .eq('term', term)
    .order('saved_at', { ascending: false })
    .limit(30);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as SchedulerBackupRow[], error: null };
}

/** 讀取某一筆存檔的完整內容（供下載回本機、或供查詢小工具使用） */
export async function getSchedulerBackupData(id: string): Promise<{ data: SchedulerProjectData | null; error: string | null }> {
  const { data, error } = await supabase.from('scheduler_backups').select('data').eq('id', id).single();
  if (error || !data) return { data: null, error: error?.message ?? '讀取失敗' };
  return { data: data.data as SchedulerProjectData, error: null };
}

/** 把排課工具匯出的 JSON 上傳存進系統（呼叫伺服器 API，會檢查管理員身分） */
export async function saveSchedulerBackup(
  projectData: SchedulerProjectData,
  academicYear: number,
  term: string,
  note: string | undefined,
  accessToken: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/admin/scheduler-backup/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ academicYear, term, note, data: projectData }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { success: false, error: body.error ?? '儲存失敗' };
  return { success: true };
}

export function downloadSchedulerBackupAsFile(projectData: SchedulerProjectData, filenameHint: string) {
  const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameHint;
  a.click();
  URL.revokeObjectURL(url);
}
