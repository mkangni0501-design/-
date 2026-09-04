import { supabase } from './supabaseClient';

export type SheetRows = { name: string; aoa: any[][] };

// 【2026-08 修正】根因：這個檔案裡原本所有查詢都沒有用 `.range()` 分頁——PostgREST
// （Supabase 的 API 層）對「沒有明確指定 range」的查詢，即使自己有加 `.limit(20000)`，
// 伺服器端還是會套用專案設定的單次回傳上限（這個專案目前是1000筆），超過上限的資料
// 會被「靜默截斷」，不會回傳錯誤，data 就只有前面那一批。這就是「學生超過一千人只抓到
// 一千筆」「成績九千多筆只抓到兩千筆」「出缺勤只抓到六百多筆」的根本原因——
// 不是資料庫裡真的少了那些資料，是查詢本身每次最多只拿得到一批。
// 修正方式：所有查詢一律改用下面這個 fetchAllPaged()，用 `.range()` 依 PAGE_SIZE 分頁
// 撈到底（撈到回傳筆數小於 PAGE_SIZE 才停止），不管伺服器單次上限是多少，都能確保
// 撈到全部資料。跟 lib/backupRestore.ts 的 fetchAllRows() 用同一套邏輯。
export async function fetchAllPaged<T>(
  runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<{ data: T[]; error: any }> {
  const PAGE_SIZE = 1000;
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break; // 這一批不足一頁，代表已經撈到最後一批
    from += PAGE_SIZE;
  }
  return { data: rows, error: null };
}

const CHUNK = 500; // .in('enrollment_id', [...]) 這種查詢的 id 陣列大小，避免單一請求網址過長

async function inChunks<T>(ids: string[], run: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<{ data: T[]; error: any }> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    // 每個 id 區塊本身也要分頁撈到底：500 個學生 × 多個考試類型 × 多個科目，
    // 單一區塊回傳的資料筆數很容易就超過 1000 筆（500人×3種考試×6科＝9000筆），
    // 不分頁的話同一個區塊自己就會被截斷。
    const { data, error } = await fetchAllPaged<T>((from, to) => run(chunk, from, to));
    if (error) return { data: out, error };
    out.push(...data);
  }
  return { data: out, error: null };
}

/** 全校目前的成績現況（不分年級/班級，含期中/期末/平時，所有仍在學籍中的學生） */
export async function fetchAllScoresSheet(): Promise<SheetRows> {
  const { data: enrollRows, error: enrollErr } = await fetchAllPaged((from, to) =>
    supabase
      .from('enrollments')
      .select('id, student_no, seat_no, term, students(name), classes(academic_year, department, grade_level, class_name)')
      .eq('is_current', true)
      .range(from, to)
  );
  if (enrollErr) {
    return { name: '全校成績(現況)', aoa: [['讀取失敗：' + enrollErr.message]] };
  }
  const enrollMap = new Map(enrollRows.map((r: any) => [r.id, r]));
  const ids = enrollRows.map((r: any) => r.id);
  const { data: scoreRows, error: scoreErr } = await inChunks(ids, (chunk, from, to) =>
    supabase.from('scores').select('enrollment_id, exam_type, subject, score').in('enrollment_id', chunk).range(from, to)
  );
  if (scoreErr) {
    return { name: '全校成績(現況)', aoa: [['讀取成績失敗：' + scoreErr.message]] };
  }

  const rows: any[][] = [['學年度', '學期', '部別', '年級', '班級', '座號', '學號', '姓名', '考試類型', '科目', '分數']];
  scoreRows.forEach((s: any) => {
    const e: any = enrollMap.get(s.enrollment_id);
    if (!e) return;
    const cls = Array.isArray(e.classes) ? e.classes[0] : e.classes;
    const stu = Array.isArray(e.students) ? e.students[0] : e.students;
    rows.push([cls?.academic_year, e.term, cls?.department, cls?.grade_level, cls?.class_name, e.seat_no, e.student_no, stu?.name, s.exam_type, s.subject, s.score]);
  });
  return { name: '全校成績(現況)', aoa: rows };
}

/** 全校目前的出缺勤現況（分頁撈到底，不再有筆數上限） */
export async function fetchAllAttendanceSheet(): Promise<SheetRows> {
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase
      .from('attendance')
      .select('student_no, record_date, period_no, status')
      .order('record_date', { ascending: false })
      .range(from, to)
  );
  if (error) return { name: '全校出缺勤(現況)', aoa: [['讀取失敗：' + error.message]] };

  const studentNos = Array.from(new Set(data.map((a: any) => a.student_no)));
  const { data: nameRows, error: nameErr } = await inChunks(studentNos, (chunk, from, to) =>
    supabase.from('students').select('student_no, name').in('student_no', chunk).range(from, to)
  );
  if (nameErr) return { name: '全校出缺勤(現況)', aoa: [['讀取學生姓名失敗：' + nameErr.message]] };
  const nameMap = new Map(nameRows.map((s: any) => [s.student_no, s.name]));

  const rows: any[][] = [['學號', '姓名', '日期', '節次', '狀態']];
  data.forEach((a: any) => rows.push([a.student_no, nameMap.get(a.student_no) ?? '', a.record_date, a.period_no, a.status]));
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
  const { data, error } = await fetchAllPaged((from, to) =>
    supabase
      .from('conduct_events')
      .select('student_no, event_date, event_type, points, students(name), teachers(name)')
      .order('event_date', { ascending: false })
      .range(from, to)
  );
  if (error) {
    return { name: '全校獎懲(現況)', aoa: [['讀取失敗：' + error.message]] };
  }
  if (data.length === 0) {
    return { name: '全校獎懲(現況)', aoa: [HEADER] };
  }
  const rows = data.map((r: any) => {
    const stu = Array.isArray(r.students) ? r.students[0] : r.students;
    const rec = Array.isArray(r.teachers) ? r.teachers[0] : r.teachers;
    return [r.student_no, stu?.name ?? '', r.event_date, r.event_type, r.points, rec?.name ?? ''];
  });
  return { name: '全校獎懲(現況)', aoa: [HEADER, ...rows] };
}
