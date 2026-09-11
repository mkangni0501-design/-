// 考試分班（教務處【考試分班】＋ 導師【輸入考場名單】）共用的型別／演算法／查詢輔助。
// 對應 sql/90exam_seating.sql 的資料表設計，詳細背景說明見該檔案開頭註解。
import { supabase } from './supabaseClient';
import { getHiddenStudentNos } from './hiddenStudents';

export const SEAT_GRID_SIZE = 7; // 附件規格明訂「梅花座(7*7)」，固定49格

export type ExamPeriod = {
  id: string;
  academic_year: number;
  term: string;
  name: string;
  status: '設定中' | '已發送';
  created_at: string;
};

export type ExamRoom = {
  id: string;
  exam_period_id: string;
  room_class_id: string;
  capacity: number;
  seats_confirmed: boolean;
};

export type ExamRoomAllocation = {
  id: string;
  exam_room_id: string;
  class_id: string;
  student_count: number;
};

export type ExamSeat = {
  id: string;
  exam_room_id: string;
  seat_row: number;
  seat_col: number;
  class_id: string | null;
  student_no: string | null;
};

/**
 * 依「各應試班級分配到的人數」，把 7*7=49 格排成梅花座：逐格（由上到下、由左到右）
 * 挑「剩餘人數最多、而且跟左邊/上面那一格不同班」的班級去坐；如果每個候選班級都會
 * 撞到左/上鄰居（人數差距太大、無可避免），退而求其次選剩餘人數最多的那個班——
 * 這樣可以盡量讓同班考生不相鄰，人數差距太大時「盡量」而非「保證」完全不相鄰。
 * 回傳 49 格（未分配到班級的格子 classId 為 null）。
 */
export function generateExamSeatLayout(
  allocations: { classId: string; count: number }[]
): { row: number; col: number; classId: string | null }[] {
  const remaining = new Map<string, number>();
  allocations.forEach((a) => {
    if (a.count > 0) remaining.set(a.classId, (remaining.get(a.classId) ?? 0) + a.count);
  });

  const grid: (string | null)[][] = Array.from({ length: SEAT_GRID_SIZE }, () =>
    Array<string | null>(SEAT_GRID_SIZE).fill(null)
  );

  for (let r = 0; r < SEAT_GRID_SIZE; r++) {
    for (let c = 0; c < SEAT_GRID_SIZE; c++) {
      const candidates = Array.from(remaining.entries())
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      if (candidates.length === 0) continue;
      const left = c > 0 ? grid[r][c - 1] : null;
      const top = r > 0 ? grid[r - 1][c] : null;
      const pick = candidates.find(([cls]) => cls !== left && cls !== top) ?? candidates[0];
      grid[r][c] = pick[0];
      remaining.set(pick[0], (remaining.get(pick[0]) ?? 0) - 1);
    }
  }

  const seats: { row: number; col: number; classId: string | null }[] = [];
  for (let r = 0; r < SEAT_GRID_SIZE; r++) {
    for (let c = 0; c < SEAT_GRID_SIZE; c++) {
      seats.push({ row: r + 1, col: c + 1, classId: grid[r][c] });
    }
  }
  return seats;
}

/** 「依目前的班級數自動提供平均人數」：把 totalCapacity 盡量平均分給 classCount 個班級，餘數依序分給前幾個班級。 */
export function averageAllocate(totalCapacity: number, classCount: number): number[] {
  if (classCount <= 0) return [];
  const base = Math.floor(totalCapacity / classCount);
  const remainder = totalCapacity - base * classCount;
  return Array.from({ length: classCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** 隨機打散陣列（Fisher–Yates），導師端「隨機分配」按鈕用。 */
export function shuffleArray<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 某個班「目前」的人數（在學、未被隱藏的學生），教務處挑考場、算平均人數用。 */
export async function fetchCurrentClassHeadcount(classId: string): Promise<number> {
  const { data } = await supabase.from('enrollments').select('student_no').eq('class_id', classId).eq('is_current', true);
  const studentNos = (data ?? []).map((r: any) => r.student_no as string);
  if (studentNos.length === 0) return 0;
  const hidden = await getHiddenStudentNos(studentNos);
  return studentNos.filter((no) => !hidden.has(no)).length;
}
