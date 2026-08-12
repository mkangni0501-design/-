import { supabase } from './supabaseClient';

export type SheetRows = { name: string; aoa: any[][] };

const CHUNK = 500;

async function inChunks<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...(await run(ids.slice(i, i + CHUNK))));
  }
  return out;
}

/** 全校目前的成績現況（不分年級/班級，含期中/期末/平時，所有仍在學籍中的學生） */
export async function fetchAllScoresSheet(): Promise<SheetRows> {
  const { data: enrollRows, error: enrollErr } = await supabase
    .from('enrollments')
    .select('id, student_no, seat_no, term, students(name), classes(academic_year, department, grade_level, class_name)')
    .eq('is_current', true);
  if (enrollErr || !enrollRows) {
    return { name: '全校成績(現況)', aoa: [['讀取失敗：' + (enrollErr?.message ?? '未知錯誤')]] };
  }
  const enrollMap = new Map(enrollRows.map((r: any) => [r.id, r]));
  const ids = enrollRows.map((r: any) => r.id);
  const scoreRows = await inChunks(ids, async (chunk) => {
    const { data } = await supabase.from('scores').select('enrollment_id, exam_type, subject, score').in('enrollment_id', chunk);
    return (data ?? []) as any[];
  });

  const rows: any[][] = [['學年度', '學期', '部別', '年級', '班級', '座號', '學號', '姓名', '考試類型', '科目', '分數']];
  scoreRows.forEach((s) => {
    const e: any = enrollMap.get(s.enrollment_id);
    if (!e) return;
    const cls = Array.isArray(e.classes) ? e.classes[0] : e.classes;
    const stu = Array.isArray(e.students) ? e.students[0] : e.students;
    rows.push([cls?.academic_year, e.term, cls?.department, cls?.grade_level, cls?.class_name, e.seat_no, e.student_no, stu?.name, s.exam_type, s.subject, s.score]);
  });
  return { name: '全校成績(現況)', aoa: rows };
}

/** 全校目前的出缺勤現況（最近 20000 筆，超過的話請縮小查詢範圍或直接到「學生出缺席登錄」頁查） */
export async function fetchAllAttendanceSheet(): Promise<SheetRows> {
  const LIMIT = 20000;
  const { data, error } = await supabase
    .from('attendance')
    .select('student_no, record_date, period_no, status')
    .order('record_date', { ascending: false })
    .limit(LIMIT);
  if (error) return { name: '全校出缺勤(現況)', aoa: [['讀取失敗：' + error.message]] };

  const studentNos = Array.from(new Set((data ?? []).map((a: any) => a.student_no)));
  const nameRows = await inChunks(studentNos, async (chunk) => {
    const { data } = await supabase.from('students').select('student_no, name').in('student_no', chunk);
    return (data ?? []) as any[];
  });
  const nameMap = new Map(nameRows.map((s: any) => [s.student_no, s.name]));

  const rows: any[][] = [['學號', '姓名', '日期', '節次', '狀態']];
  (data ?? []).forEach((a: any) => rows.push([a.student_no, nameMap.get(a.student_no) ?? '', a.record_date, a.period_no, a.status]));
  if ((data ?? []).length >= LIMIT) rows.push([`（已達 ${LIMIT} 筆上限，可能還有更早的紀錄沒列出，完整資料請到「學生出缺席登錄」頁分班查詢）`]);
  return { name: '全校出缺勤(現況)', aoa: rows };
}

/**
 * 全校目前的獎懲現況。conduct_events 的欄位其實從一開始就在 schema.sql 裡定義好了
 * （student_no, event_date, event_type, points, recorded_by），只是原本沒有登錄頁面、
 * 也沒有上傳（寫回）功能。這裡改成跟其他「(現況)」表一樣的風格：把 student_no／recorded_by
 * 轉成看得懂的姓名，欄位固定為「學號、姓名、日期、項目、分數、記錄人」，
 * 這樣下載下來的檔案改一改、填一填，就可以直接透過「一鍵上傳」的「全校獎懲(現況)」工作表寫回去
 * （對應的上傳函式見 lib/bulkHandlers.ts 的 uploadAllConductSheet）。
 */
export async function fetchAllConductSheet(): Promise<SheetRows> {
  const HEADER = ['學號', '姓名', '日期', '項目', '分數', '記錄人'];
  const { data, error } = await supabase
    .from('conduct_events')
    .select('student_no, event_date, event_type, points, students(name), teachers(name)')
    .order('event_date', { ascending: false })
    .limit(20000);
  if (error) {
    return { name: '全校獎懲(現況)', aoa: [['讀取失敗：' + error.message]] };
  }
  if (!data || data.length === 0) {
    return { name: '全校獎懲(現況)', aoa: [HEADER] };
  }
  const rows = (data as any[]).map((r) => {
    const stu = Array.isArray(r.students) ? r.students[0] : r.students;
    const rec = Array.isArray(r.teachers) ? r.teachers[0] : r.teachers;
    return [r.student_no, stu?.name ?? '', r.event_date, r.event_type, r.points, rec?.name ?? ''];
  });
  return { name: '全校獎懲(現況)', aoa: [HEADER, ...rows] };
}
