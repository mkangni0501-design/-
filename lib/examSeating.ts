import { supabase } from './supabaseClient';

// ============================================================
// 考試分班 / 考場編排 共用邏輯
// 對應 sql/90exam_seating.sql
// ============================================================

export type ExamSession = {
  id: string;
  name: string;
  academic_year: number;
  term: string;
  status: '編排中' | '已發送' | '已完成';
  sent_at: string | null;
};

export type ExamRoom = {
  id: string;
  exam_session_id: string;
  room_name: string;
  seat_capacity: number;
  grid_size: number;
  confirmed: boolean;
};

export type ExamRoomClass = {
  id: string;
  exam_room_id: string;
  class_id: string;
  allocated_count: number;
};

export type ClassOption = {
  id: string;
  label: string;
  headcount: number; // 現在在讀人數
};

const MAX_SEATS_PER_ROOM = 49; // 最大 7*7
export const MAX_CLASSES_PER_ROOM = 4; // 每個考場最多安排 4 個應試班級
const PAGE_SIZE = 1000; // Supabase/PostgREST 單次查詢預設上限，超過需要分頁抓取，否則班級人數會被截斷變成 0 或少算

/**
 * 分頁抓取所有符合條件的資料列，避免資料筆數超過 Supabase 單次查詢上限（預設1000筆）
 * 時被截斷，導致像是「班級人數變成0或算錯」這種問題。呼叫端需自行加上足以保證穩定
 * 排序的 .order(...)（例如用主鍵排序），否則分頁之間可能重複或漏掉資料列。
 */
async function fetchAllRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/** 依座位數換算方形邊長（最大7），供新增考場時使用 */
export function gridSizeForCapacity(capacity: number): number {
  return Math.min(7, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, capacity)))));
}

// ------------------------------------------------------------
// 讀取
// ------------------------------------------------------------

export async function listExamSessions(): Promise<ExamSession[]> {
  const { data, error } = await supabase
    .from('exam_sessions')
    .select('id, name, academic_year, term, status, sent_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error('讀取考試清單失敗：' + error.message);
  return (data ?? []) as ExamSession[];
}

export async function createExamSession(params: { name: string; academic_year: number; term: string; created_by: string | null }) {
  const { error } = await supabase.from('exam_sessions').insert({
    name: params.name,
    academic_year: params.academic_year,
    term: params.term,
    created_by: params.created_by,
  });
  if (error) throw new Error('新增考試失敗：' + error.message);
}

export async function deleteExamSession(id: string) {
  const { error } = await supabase.from('exam_sessions').delete().eq('id', id);
  if (error) throw new Error('刪除考試失敗：' + error.message);
}

export async function listExamRooms(examSessionId: string): Promise<ExamRoom[]> {
  const { data, error } = await supabase
    .from('exam_rooms')
    .select('id, exam_session_id, room_name, seat_capacity, grid_size, confirmed')
    .eq('exam_session_id', examSessionId)
    .order('room_name');
  if (error) throw new Error('讀取考場清單失敗：' + error.message);
  return (data ?? []) as ExamRoom[];
}

export async function createExamRoom(examSessionId: string, roomName: string, capacity: number) {
  if (capacity <= 0 || capacity > MAX_SEATS_PER_ROOM) {
    throw new Error(`座位數需介於 1 ~ ${MAX_SEATS_PER_ROOM}（方形座位最大 7*7）`);
  }
  const { error } = await supabase.from('exam_rooms').insert({
    exam_session_id: examSessionId,
    room_name: roomName,
    seat_capacity: capacity,
    grid_size: gridSizeForCapacity(capacity),
  });
  if (error) throw new Error('新增考場失敗：' + error.message);
}

export async function deleteExamRoom(id: string) {
  const { error } = await supabase.from('exam_rooms').delete().eq('id', id);
  if (error) throw new Error('刪除考場失敗：' + error.message);
}

export type RoomSyncResult = { createdCount: number; skippedTooBig: string[]; skippedEmpty: string[] };

/**
 * 讓「所有班級」自動成為考場，教務處不用再一個個手動新增：
 * 針對這個學年度、目前還沒被建立成考場的班級，自動新增考場
 * （考場名稱＝班級名稱，座位數＝該班目前真正在校人數）。
 * 人數為0（沒有在校學生）或超過49人（超出方形座位7*7上限）的班級會被跳過，回傳名單供畫面提示。
 */
export async function autoSyncRoomsForSession(examSessionId: string, academicYear: number): Promise<RoomSyncResult> {
  const [existingRooms, classOptions] = await Promise.all([listExamRooms(examSessionId), listClassOptionsWithHeadcount(academicYear)]);
  const existingNames = new Set(existingRooms.map((r) => r.room_name));
  const toCreate = classOptions.filter((c) => !existingNames.has(c.label));
  const skippedTooBig: string[] = [];
  const skippedEmpty: string[] = [];
  const rows: { exam_session_id: string; room_name: string; seat_capacity: number; grid_size: number }[] = [];
  for (const c of toCreate) {
    if (c.headcount <= 0) {
      skippedEmpty.push(c.label);
      continue;
    }
    if (c.headcount > MAX_SEATS_PER_ROOM) {
      skippedTooBig.push(c.label);
      continue;
    }
    rows.push({ exam_session_id: examSessionId, room_name: c.label, seat_capacity: c.headcount, grid_size: gridSizeForCapacity(c.headcount) });
  }
  if (rows.length > 0) {
    const { error } = await supabase.from('exam_rooms').insert(rows);
    if (error) throw new Error('自動建立考場失敗：' + error.message);
  }
  return { createdCount: rows.length, skippedTooBig, skippedEmpty };
}

const HIDDEN_STUDENT_STATUSES = ['休學', '轉學', '退學', '畢業', '肄業'];

export type EnrollmentRow = { student_no: string; seat_no: number | null; name: string };

/** 某班目前「真正在校」的學生名冊（排除休學/轉學/退學/畢業/肄業），供導師輸入考場名單使用 */
export async function listCurrentEnrollments(classId: string): Promise<EnrollmentRow[]> {
  const rows = await fetchAllRows<any>((from, to) =>
    supabase
      .from('enrollments')
      .select('id, student_no, seat_no, students(name)')
      .eq('class_id', classId)
      .eq('is_current', true)
      .order('id')
      .range(from, to)
  );
  const hiddenStudentNos = await findHiddenStudentNos(rows.map((r) => r.student_no));
  return rows.filter((r) => !hiddenStudentNos.has(r.student_no)).map((r) => ({ student_no: r.student_no, seat_no: r.seat_no, name: r.students?.name ?? '' }));
}

/** 給一批學號，回傳其中「目前學籍狀態已離校」（休學/轉學/退學/畢業/肄業）的學號集合 */
async function findHiddenStudentNos(studentNos: string[]): Promise<Set<string>> {
  const uniq = Array.from(new Set(studentNos));
  const hidden = new Set<string>();
  if (uniq.length === 0) return hidden;
  // 依 student_no 分組、每組內依日期新到舊排序，並用 id 當最終排序依據，
  // 確保分頁抓取（.range）時每一頁的排序都是穩定、不會重複或漏抓。
  const statusRows = await fetchAllRows<{ student_no: string; status: string }>((from, to) =>
    supabase
      .from('student_status_changes')
      .select('student_no, status, effective_date, created_at, id')
      .in('student_no', uniq)
      .order('student_no', { ascending: true })
      .order('effective_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
  );
  const latestSeen = new Set<string>();
  for (const s of statusRows) {
    if (latestSeen.has(s.student_no)) continue; // 已依日期排序，第一筆看到的就是該生最新狀態
    latestSeen.add(s.student_no);
    if (HIDDEN_STUDENT_STATUSES.includes(s.status)) hidden.add(s.student_no);
  }
  return hidden;
}

/** 目前所有現在在讀的班級（供選擇應試班級用），附上目前「真正在校」的在讀人數 */
export async function listClassOptionsWithHeadcount(academicYear?: number): Promise<ClassOption[]> {
  const classes = await fetchAllRows<any>((from, to) => {
    let query = supabase.from('classes').select('id, academic_year, grade_level, class_name').order('grade_level').order('class_name').order('id').range(from, to);
    if (academicYear != null) query = query.eq('academic_year', academicYear);
    return query;
  });
  const ids = classes.map((c: any) => c.id);
  if (ids.length === 0) return [];
  const rows = await fetchAllRows<{ class_id: string; student_no: string }>((from, to) =>
    supabase.from('enrollments').select('class_id, student_no, id').in('class_id', ids).eq('is_current', true).order('id').range(from, to)
  );

  // enrollments.is_current 不會因為學生休學/轉學/退學/畢業/肄業而自動改回 false
  // （這是刻意保留、讓管理員之後仍查得到歷史資料的設計，見 sql/61），
  // 所以這裡要另外排除「目前學籍狀態已離校」的學生，人數才會等於真正在校人數。
  // 另外，抓取的兩個查詢都改用分頁（fetchAllRows）撈全部資料，避免全校學生數超過
  // Supabase 單次查詢上限（預設1000筆）時被截斷，造成很多班級人數變成0或算錯。
  const hiddenStudentNos = await findHiddenStudentNos(rows.map((r) => r.student_no));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (hiddenStudentNos.has(row.student_no)) continue;
    counts[row.class_id] = (counts[row.class_id] ?? 0) + 1;
  }
  return classes.map((c: any) => ({
    id: c.id,
    label: `${c.grade_level}${c.class_name}`,
    headcount: counts[c.id] ?? 0,
  }));
}

export async function listExamRoomClasses(examRoomIds: string[]): Promise<ExamRoomClass[]> {
  if (examRoomIds.length === 0) return [];
  const { data, error } = await supabase
    .from('exam_room_classes')
    .select('id, exam_room_id, class_id, allocated_count')
    .in('exam_room_id', examRoomIds);
  if (error) throw new Error('讀取班級考場分配失敗：' + error.message);
  return (data ?? []) as ExamRoomClass[];
}

/** 儲存「哪些班級分配到這個考場」（第2步）：整批覆蓋，allocated_count 先填0，之後由試算步驟計算 */
export async function saveExamRoomClassAssignment(examRoomId: string, classIds: string[]) {
  if (classIds.length > MAX_CLASSES_PER_ROOM) {
    throw new Error(`每個考場最多只能安排 ${MAX_CLASSES_PER_ROOM} 個應試班級`);
  }
  const { error: delErr } = await supabase.from('exam_room_classes').delete().eq('exam_room_id', examRoomId);
  if (delErr) throw new Error('清除舊分配失敗：' + delErr.message);
  if (classIds.length === 0) return;
  const { error: insErr } = await supabase
    .from('exam_room_classes')
    .insert(classIds.map((class_id) => ({ exam_room_id: examRoomId, class_id, allocated_count: 0 })));
  if (insErr) throw new Error('儲存班級考場分配失敗：' + insErr.message);
}

/** 儲存試算/手動修改後的各班考場人數（第3-4步的【儲存】） */
export async function saveAllocatedCounts(rows: { id: string; allocated_count: number }[]) {
  for (const row of rows) {
    const { error } = await supabase.from('exam_room_classes').update({ allocated_count: row.allocated_count }).eq('id', row.id);
    if (error) throw new Error('儲存分配人數失敗：' + error.message);
  }
}

// ------------------------------------------------------------
// 步驟3：依座位數比例計算各班在各考場的人數（四捨五入 + 橫向加總校正）
// ------------------------------------------------------------

export type AllocationInput = {
  classId: string;
  headcount: number; // 該班應試人數
  rooms: { examRoomId: string; capacity: number }[]; // 該班分配到的考場與各考場座位數
};

/**
 * 每個【考場表】中應試班級人數 = 應試班級人數 * 該考場座位數 / 應試班級所分配的考場總座位數，
 * 四捨五入後用最大餘數法校正，確保橫向加總（該班在各考場人數之和）一定等於該班總人數。
 * 回傳 examRoomId -> classId -> count
 */
export function computeAllocatedCounts(inputs: AllocationInput[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const input of inputs) {
    const totalCapacity = input.rooms.reduce((s, r) => s + r.capacity, 0);
    if (totalCapacity === 0 || input.headcount === 0) {
      for (const r of input.rooms) {
        result[r.examRoomId] = result[r.examRoomId] ?? {};
        result[r.examRoomId][input.classId] = 0;
      }
      continue;
    }
    const raw = input.rooms.map((r) => ({
      examRoomId: r.examRoomId,
      exact: (input.headcount * r.capacity) / totalCapacity,
    }));
    const floors = raw.map((r) => ({ examRoomId: r.examRoomId, base: Math.floor(r.exact), remainder: r.exact - Math.floor(r.exact) }));
    let assigned = floors.reduce((s, r) => s + r.base, 0);
    let remaining = input.headcount - assigned;
    // 用四捨五入的精神：餘數 >= 0.5 的先進位；不夠湊滿再依餘數大小依序補（最大餘數法），
    // 確保橫向加總（該班分配到的各考場人數總和）恰好等於該班總人數。
    const order = [...floors].sort((a, b) => b.remainder - a.remainder);
    const roundUp = new Set<string>();
    for (const f of floors) if (f.remainder >= 0.5) roundUp.add(f.examRoomId);
    let counts: Record<string, number> = {};
    for (const f of floors) counts[f.examRoomId] = f.base + (roundUp.has(f.examRoomId) ? 1 : 0);
    let diff = input.headcount - Object.values(counts).reduce((s, v) => s + v, 0);
    let i = 0;
    while (diff !== 0 && order.length > 0) {
      const target = order[i % order.length].examRoomId;
      if (diff > 0) {
        counts[target] += 1;
        diff -= 1;
      } else if (counts[target] > 0) {
        counts[target] -= 1;
        diff += 1;
      }
      i += 1;
      if (i > 10000) break; // 保險
    }
    for (const r of input.rooms) {
      result[r.examRoomId] = result[r.examRoomId] ?? {};
      result[r.examRoomId][input.classId] = counts[r.examRoomId] ?? 0;
    }
  }
  return result;
}

/** 雙驗證：橫向（班級加總=總人數）、縱向（考場加總<=座位數） */
export type ValidationResult = {
  horizontalOk: boolean;
  horizontalErrors: string[]; // 班級層級的錯誤訊息
  verticalOk: boolean;
  verticalErrors: string[]; // 考場層級的錯誤訊息
};

export function validateAllocation(params: {
  classHeadcounts: Record<string, number>; // classId -> 總人數
  classLabels: Record<string, string>;
  roomCapacities: Record<string, number>; // examRoomId -> 座位數
  roomLabels: Record<string, string>;
  // matrix[examRoomId][classId] = count
  matrix: Record<string, Record<string, number>>;
  classRoomMap: Record<string, string[]>; // classId -> 分配到的 examRoomId 清單
}): ValidationResult {
  const horizontalErrors: string[] = [];
  for (const classId of Object.keys(params.classRoomMap)) {
    const sum = params.classRoomMap[classId].reduce((s, roomId) => s + (params.matrix[roomId]?.[classId] ?? 0), 0);
    const expected = params.classHeadcounts[classId] ?? 0;
    if (sum !== expected) {
      horizontalErrors.push(`${params.classLabels[classId] ?? classId}：各考場人數加總為 ${sum}，應為 ${expected}`);
    }
  }
  const verticalErrors: string[] = [];
  for (const roomId of Object.keys(params.roomCapacities)) {
    const sum = Object.values(params.matrix[roomId] ?? {}).reduce((s, v) => s + v, 0);
    const capacity = params.roomCapacities[roomId];
    if (sum > capacity) {
      verticalErrors.push(`${params.roomLabels[roomId] ?? roomId}：各班人數加總為 ${sum}，超過座位數 ${capacity}`);
    }
  }
  return {
    horizontalOk: horizontalErrors.length === 0,
    horizontalErrors,
    verticalOk: verticalErrors.length === 0,
    verticalErrors,
  };
}

// ------------------------------------------------------------
// 步驟5：梅花座 —— 依方形座位（最大7*7）排列，讓同班考生盡可能不相鄰
// ------------------------------------------------------------

export type SeatCell = { seatNo: number; row: number; col: number; classId: string | null };

/**
 * 蛇形（之字形）走訪方形格子，取得座位序號 1..capacity 對應的 (row, col)。
 * 蛇形走法讓序列上相鄰的座位號，在方格上也大致相鄰，方便下面的公平交錯排班演算法
 * 產生「同班盡量不相鄰」的效果。超過 capacity 的格子（座位數不是完全平方數時）不使用。
 */
function boustrophedonCells(gridSize: number, capacity: number): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  for (let row = 0; row < gridSize && cells.length < capacity; row++) {
    const cols = row % 2 === 0 ? [...Array(gridSize).keys()] : [...Array(gridSize).keys()].reverse();
    for (const col of cols) {
      if (cells.length >= capacity) break;
      cells.push({ row, col });
    }
  }
  return cells;
}

/**
 * 公平交錯排序（類似作業系統排程的公平佇列做法）：每一步都挑「目前已排入比例最低」的
 * 班級放進序列下一格，讓各班座位盡量平均、交錯分散在座位序列中，而不是同班連續坐在一起，
 * 藉此逼近梅花座「同班考生盡可能不相鄰」的效果。
 */
function fairInterleave(counts: { classId: string; count: number }[]): (string | null)[] {
  const items = counts.filter((c) => c.count > 0).map((c) => ({ ...c, placed: 0 }));
  const total = items.reduce((s, c) => s + c.count, 0);
  const seq: (string | null)[] = [];
  for (let i = 0; i < total; i++) {
    let best: (typeof items)[number] | null = null;
    for (const it of items) {
      if (it.placed >= it.count) continue;
      if (best === null || it.placed / it.count < best.placed / best.count) best = it;
    }
    if (!best) break;
    seq.push(best.classId);
    best.placed += 1;
  }
  return seq;
}

/** 依考場座位數與各班分配人數，產生梅花座座位表（尚未寫入資料庫） */
export function generateSeatLayout(params: { gridSize: number; capacity: number; classCounts: { classId: string; count: number }[] }): SeatCell[] {
  const cells = boustrophedonCells(params.gridSize, params.capacity);
  const seq = fairInterleave(params.classCounts);
  return cells.map((cell, idx) => ({
    seatNo: idx + 1,
    row: cell.row,
    col: cell.col,
    classId: seq[idx] ?? null,
  }));
}

// ------------------------------------------------------------
// 確認座位表（寫入 exam_room_seats）＋ 之後預覽/導師輸入名單用的讀取
// ------------------------------------------------------------

export async function confirmRoomSeatLayout(examRoomId: string, seats: SeatCell[]) {
  const { error: delErr } = await supabase.from('exam_room_seats').delete().eq('exam_room_id', examRoomId);
  if (delErr) throw new Error('清除舊座位表失敗：' + delErr.message);
  const { error: insErr } = await supabase.from('exam_room_seats').insert(
    seats.map((s) => ({
      exam_room_id: examRoomId,
      seat_no: s.seatNo,
      row_no: s.row,
      col_no: s.col,
      class_id: s.classId,
    }))
  );
  if (insErr) throw new Error('寫入座位表失敗：' + insErr.message);
  const { error: confirmErr } = await supabase.from('exam_rooms').update({ confirmed: true, confirmed_at: new Date().toISOString() }).eq('id', examRoomId);
  if (confirmErr) throw new Error('確認考場失敗：' + confirmErr.message);
}

export async function sendExamSession(examSessionId: string) {
  const { error } = await supabase.from('exam_sessions').update({ status: '已發送', sent_at: new Date().toISOString() }).eq('id', examSessionId);
  if (error) throw new Error('發送考場表失敗：' + error.message);
}

export type ExamRoomSeatRow = {
  id: string;
  exam_room_id: string;
  seat_no: number;
  row_no: number;
  col_no: number;
  class_id: string | null;
  exam_seat_students?: { student_no: string | null; class_seat_no: number | null } | null;
};

export async function listRoomSeats(examRoomId: string): Promise<ExamRoomSeatRow[]> {
  const { data, error } = await supabase
    .from('exam_room_seats')
    .select('id, exam_room_id, seat_no, row_no, col_no, class_id, exam_seat_students(student_no, class_seat_no)')
    .eq('exam_room_id', examRoomId)
    .order('seat_no');
  if (error) throw new Error('讀取座位表失敗：' + error.message);
  return (data ?? []).map((row: any) => ({
    ...row,
    exam_seat_students: Array.isArray(row.exam_seat_students) ? row.exam_seat_students[0] ?? null : row.exam_seat_students,
  })) as ExamRoomSeatRow[];
}

export async function upsertSeatStudent(examRoomSeatId: string, studentNo: string | null, classSeatNo: number | null, updatedBy: string | null) {
  const { error } = await supabase.from('exam_seat_students').upsert(
    {
      exam_room_seat_id: examRoomSeatId,
      student_no: studentNo,
      class_seat_no: classSeatNo,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'exam_room_seat_id' }
  );
  if (error) throw new Error('儲存座位名單失敗：' + error.message);
}

export async function submitClassRoster(examSessionId: string, classId: string, teacherId: string | null) {
  const { error } = await supabase
    .from('exam_class_roster_status')
    .update({ submitted: true, submitted_by: teacherId, submitted_at: new Date().toISOString() })
    .eq('exam_session_id', examSessionId)
    .eq('class_id', classId);
  if (error) throw new Error('送出名單失敗：' + error.message);
}

export type RosterStatus = { exam_session_id: string; class_id: string; submitted: boolean; submitted_at: string | null };

export async function listRosterStatus(examSessionId: string): Promise<RosterStatus[]> {
  const { data, error } = await supabase
    .from('exam_class_roster_status')
    .select('exam_session_id, class_id, submitted, submitted_at')
    .eq('exam_session_id', examSessionId);
  if (error) throw new Error('讀取名單提交狀態失敗：' + error.message);
  return (data ?? []) as RosterStatus[];
}
