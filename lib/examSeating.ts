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
  excluded_class_ids: string[]; // 這次考試「不擔任考場」的班級（考場分配時自動排除，不會被自動建立成考場）
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
const PAGE_SIZE = 500; // 每次查詢筆數上限（保守值，低於 Supabase/PostgREST 常見預設上限1000），超過需要分頁抓取，否則資料會被截斷變成0或算錯
const IN_FILTER_CHUNK_SIZE = 150; // 「.in(欄位, 一大串值)」時每批帶入的數量上限，避免全校1000～1300+人時單一請求的網址/參數過長被伺服器拒絕或截斷

/**
 * 分頁抓取所有符合條件的資料列，避免資料筆數超過 Supabase 單次查詢上限
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

/** 把一個陣列切成每批固定大小的小陣列，用於 .in(...) 查詢條件過長時分批查詢（全校1000～1300+人時很容易發生） */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 分批（.in 條件）＋分頁（單批筆數）抓取所有符合條件的資料列，兩種截斷風險一次處理 */
async function fetchAllRowsChunked<T>(
  ids: string[],
  build: (idsChunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> {
  const all: T[] = [];
  for (const idsChunk of chunkArray(ids, IN_FILTER_CHUNK_SIZE)) {
    const rows = await fetchAllRows<T>((from, to) => build(idsChunk, from, to));
    all.push(...rows);
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
    .select('id, name, academic_year, term, status, sent_at, excluded_class_ids')
    .order('created_at', { ascending: false });
  if (error) throw new Error('讀取考試清單失敗：' + error.message);
  return ((data ?? []) as any[]).map((r) => ({ ...r, excluded_class_ids: r.excluded_class_ids ?? [] })) as ExamSession[];
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

/** 設定這次考試「不擔任考場」的班級（下次自動同步考場時會自動跳過／移除這些班級的考場） */
export async function setExcludedClasses(examSessionId: string, classIds: string[]) {
  const { error } = await supabase.from('exam_sessions').update({ excluded_class_ids: classIds }).eq('id', examSessionId);
  if (error) throw new Error('儲存排除班級失敗：' + error.message);
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

export type RoomSyncResult = {
  createdCount: number;
  skippedTooBig: string[];
  skippedEmpty: string[];
  removedExcluded: string[];
  updatedCapacities: { label: string; oldCapacity: number; newCapacity: number }[];
  confirmedMismatches: { label: string; roomCapacity: number; currentHeadcount: number }[];
};

/**
 * 讓「所有班級」自動成為考場，教務處不用再一個個手動新增，同時確保每個考場的座位數
 * 一直等於該班「目前真正在校」的人數（例如班級人數後來有異動，考場座位數就會自動校正）：
 * - 還沒被建立成考場、且沒有被勾選「不擔任考場」的班級，自動新增考場。
 * - 已經是考場、但座位表還沒【確認】的，如果班級人數跟座位數不一致，自動更新座位數（連帶重算方形大小）。
 * - 已經【確認】座位表的考場，因為座位已經排定，不會自動改動座位數，只會回報「人數不合」讓教務處自行確認要不要重新排。
 * - 被勾選「不擔任考場」的班級，如果考場還沒確認，會自動移除該考場（並清掉它在其他考場應試班級名單裡的紀錄）；已確認的話只會回報，不會自動刪除。
 * 人數為0（沒有在校學生）或超過49人（超出方形座位7*7上限）的班級不會自動建立考場，回傳名單供畫面提示。
 */
export async function autoSyncRoomsForSession(examSessionId: string, academicYear: number, excludedClassIds: string[] = []): Promise<RoomSyncResult> {
  const [existingRooms, classOptions] = await Promise.all([listExamRooms(examSessionId), listClassOptionsWithHeadcount(academicYear)]);
  const excludedSet = new Set(excludedClassIds);
  const existingByName = new Map(existingRooms.map((r) => [r.room_name, r]));

  const skippedTooBig: string[] = [];
  const skippedEmpty: string[] = [];
  const removedExcluded: string[] = [];
  const updatedCapacities: { label: string; oldCapacity: number; newCapacity: number }[] = [];
  const confirmedMismatches: { label: string; roomCapacity: number; currentHeadcount: number }[] = [];
  const toCreate: { exam_session_id: string; room_name: string; seat_capacity: number; grid_size: number }[] = [];

  for (const c of classOptions) {
    const existing = existingByName.get(c.label);

    if (excludedSet.has(c.id)) {
      if (existing) {
        if (!existing.confirmed) {
          await supabase.from('exam_room_classes').delete().eq('class_id', c.id); // 清掉這個班在（可能共用的）其他考場應試班級名單裡的紀錄
          await supabase.from('exam_rooms').delete().eq('id', existing.id);
          removedExcluded.push(c.label);
        } else {
          confirmedMismatches.push({ label: c.label, roomCapacity: existing.seat_capacity, currentHeadcount: c.headcount });
        }
      }
      continue;
    }

    if (!existing) {
      if (c.headcount <= 0) {
        skippedEmpty.push(c.label);
      } else if (c.headcount > MAX_SEATS_PER_ROOM) {
        skippedTooBig.push(c.label);
      } else {
        toCreate.push({ exam_session_id: examSessionId, room_name: c.label, seat_capacity: c.headcount, grid_size: gridSizeForCapacity(c.headcount) });
      }
      continue;
    }

    if (existing.seat_capacity !== c.headcount) {
      if (existing.confirmed) {
        confirmedMismatches.push({ label: c.label, roomCapacity: existing.seat_capacity, currentHeadcount: c.headcount });
      } else if (c.headcount > 0 && c.headcount <= MAX_SEATS_PER_ROOM) {
        const { error } = await supabase
          .from('exam_rooms')
          .update({ seat_capacity: c.headcount, grid_size: gridSizeForCapacity(c.headcount) })
          .eq('id', existing.id);
        if (error) throw new Error('更新考場座位數失敗：' + error.message);
        updatedCapacities.push({ label: c.label, oldCapacity: existing.seat_capacity, newCapacity: c.headcount });
      }
    }
  }

  if (toCreate.length > 0) {
    const { error } = await supabase.from('exam_rooms').insert(toCreate);
    if (error) throw new Error('自動建立考場失敗：' + error.message);
  }

  return { createdCount: toCreate.length, skippedTooBig, skippedEmpty, removedExcluded, updatedCapacities, confirmedMismatches };
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
  // 全校可能超過1000～1300+人，所以「.in(student_no, uniq)」要分批查詢，每一批再視需要分頁抓取，
  // 並依 student_no 分組、每組內依日期新到舊排序、最後用 id 當並列時的依據，
  // 確保每一批、每一頁的排序都是穩定的，不會重複或漏抓。
  const statusRows = await fetchAllRowsChunked<{ student_no: string; status: string }>(uniq, (idsChunk, from, to) =>
    supabase
      .from('student_status_changes')
      .select('student_no, status, effective_date, created_at, id')
      .in('student_no', idsChunk)
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
  // 全校學生可能有1000～1300+人，「.in(class_id, ids)」查出來的 enrollments 筆數會超過單次查詢上限，
  // 這裡同時做「分批 in 條件」＋「分頁抓取」，確保每個班級的人數都完整算到，不會被截斷。
  const rows = await fetchAllRowsChunked<{ class_id: string; student_no: string }>(ids, (idsChunk, from, to) =>
    supabase.from('enrollments').select('class_id, student_no, id').in('class_id', idsChunk).eq('is_current', true).order('id').range(from, to)
  );

  // enrollments.is_current 不會因為學生休學/轉學/退學/畢業/肄業而自動改回 false
  // （這是刻意保留、讓管理員之後仍查得到歷史資料的設計，見 sql/61），
  // 所以這裡要另外排除「目前學籍狀態已離校」的學生，人數才會等於真正在校人數。
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

/** 一次儲存「所有考場」目前的應試班級分配，讓畫面上只需要一個儲存鍵 */
export async function saveAllRoomClassGroups(assignments: { examRoomId: string; classIds: string[] }[]) {
  for (const a of assignments) {
    await saveExamRoomClassAssignment(a.examRoomId, a.classIds);
  }
}

// ------------------------------------------------------------
// 考場共用群組（哪些班級互相共用彼此的考場）
// ------------------------------------------------------------

/**
 * 從目前已儲存的 exam_room_classes 還原出「共用考場的班級群組」：
 * 同一群組內的班級，一定會互相出現在彼此的考場應試班級名單裡（對稱）。
 * 即使舊資料不是完全對稱，這裡也會用連通分量把它們正規化成群組，之後存檔就會自動修正成對稱狀態。
 * 沒有跟任何人共用考場的班級，不會出現在回傳結果裡（視為「單獨一個群組＝自己」）。
 */
export function computeGroupsFromRoomClasses(rooms: ExamRoom[], roomClasses: ExamRoomClass[], classOptions: ClassOption[]): string[][] {
  const labelToId: Record<string, string> = Object.fromEntries(classOptions.map((c) => [c.label, c.id]));
  const parent: Record<string, string> = {};
  function find(x: string): string {
    if (!(x in parent)) parent[x] = x;
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (const room of rooms) {
    const ownerId = labelToId[room.room_name];
    if (!ownerId) continue;
    find(ownerId);
    for (const rc of roomClasses.filter((x) => x.exam_room_id === room.id)) {
      find(rc.class_id);
      union(ownerId, rc.class_id);
    }
  }
  const groupsMap: Record<string, string[]> = {};
  for (const id of Object.keys(parent)) {
    const root = find(id);
    groupsMap[root] = groupsMap[root] ?? [];
    groupsMap[root].push(id);
  }
  return Object.values(groupsMap).filter((g) => g.length > 1);
}

/** 找出某個班級目前所在的群組（包含自己）；如果沒有跟任何人共用考場，就回傳只有自己的陣列 */
export function findGroupOf(groups: string[][], classId: string): string[] {
  return groups.find((g) => g.includes(classId)) ?? [classId];
}

/**
 * 切換「某考場（ownerId 為該考場對應的班級）是否包含 targetId 這個應試班級」，
 * 並回傳更新後、維持對稱的群組清單（同群組的每個班級，考場都會互相出現彼此）。
 * 一個班級同時間只會屬於一個群組；如果 targetId 已經跟別的群組共用考場，這裡不會處理合併，
 * 呼叫端（畫面上）要先把那個 checkbox 擋成不能勾。
 */
export function toggleGroupMember(groups: string[][], ownerId: string, targetId: string): string[][] {
  const ownerGroup = findGroupOf(groups, ownerId);
  const rest = groups.filter((g) => g !== ownerGroup);
  if (ownerGroup.includes(targetId)) {
    const shrunk = ownerGroup.filter((id) => id !== targetId);
    if (shrunk.length > 1) rest.push(shrunk);
    return rest;
  }
  const targetGroup = findGroupOf(groups, targetId);
  if (targetGroup.length > 1 && targetGroup !== ownerGroup) return groups; // target 已被安排在別的群組，忽略
  const merged = Array.from(new Set([...ownerGroup, targetId]));
  if (merged.length > MAX_CLASSES_PER_ROOM) return groups;
  rest.push(merged);
  return rest;
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

/**
 * 橫向加總（computeAllocatedCounts）已經保證正確，但縱向（某考場各班加總 <= 座位數）
 * 可能因為考場座位數是「建立考場當下」的班級人數快照、之後班級人數又有異動（轉入/轉出等）
 * 而兜不起來。這裡自動在「同一個班級的不同考場之間」搬動名額（只在同一班的列內移動，
 * 橫向加總維持不變），把超額的考場挪一些給還有空位的考場，直到兩項驗證都符合為止；
 * 如果整組（同一群班級＋考場）的總人數本來就超過總座位數，會盡量調到最接近、
 * 但無法完全消除超額，此時仍需要教務處手動調整（例如調整分組或人數）。
 * 回傳新的 matrix，不會修改傳入的參數。
 */
export function autoBalanceAllocation(params: {
  matrix: Record<string, Record<string, number>>; // examRoomId -> classId -> count
  roomCapacities: Record<string, number>; // examRoomId -> 座位數
  classRoomMap: Record<string, string[]>; // classId -> 分配到的 examRoomId 清單（同一組內的考場）
}): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const roomId of Object.keys(params.matrix)) matrix[roomId] = { ...params.matrix[roomId] };

  function roomSum(roomId: string): number {
    return Object.values(matrix[roomId] ?? {}).reduce((s, v) => s + v, 0);
  }

  let changed = true;
  let guard = 0;
  while (changed && guard < 5000) {
    changed = false;
    guard += 1;
    for (const roomId of Object.keys(params.roomCapacities)) {
      let overflow = roomSum(roomId) - params.roomCapacities[roomId];
      if (overflow <= 0) continue;
      const classesHere = Object.keys(matrix[roomId] ?? {}).filter((cid) => (matrix[roomId][cid] ?? 0) > 0);
      for (const classId of classesHere) {
        if (overflow <= 0) break;
        for (const otherRoom of params.classRoomMap[classId] ?? []) {
          if (otherRoom === roomId || overflow <= 0) continue;
          const slack = params.roomCapacities[otherRoom] - roomSum(otherRoom);
          if (slack <= 0) continue;
          const moveAmount = Math.min(overflow, slack, matrix[roomId][classId]);
          if (moveAmount <= 0) continue;
          matrix[roomId][classId] -= moveAmount;
          matrix[otherRoom] = matrix[otherRoom] ?? {};
          matrix[otherRoom][classId] = (matrix[otherRoom][classId] ?? 0) + moveAmount;
          overflow -= moveAmount;
          changed = true;
        }
      }
    }
  }
  return matrix;
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
