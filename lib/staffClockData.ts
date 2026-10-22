import { supabase } from '@/lib/supabaseClient';
import {
  ClockEmployee,
  ClockHoliday,
  ClockOverride,
  ClockRecord,
  ClockShift,
  DaySummary,
  addDays,
  bangkokNow,
  summarizeDay,
} from '@/lib/staffClock';

const PAGE = 1000; // PostgREST 預設單次上限 1000 列，一律分頁撈取避免被悄悄截斷

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function loadShifts(): Promise<ClockShift[]> {
  const { data, error } = await supabase.from('clock_shifts').select('*').order('sort_order').order('start_time');
  if (error) throw new Error('讀取班別失敗：' + error.message);
  return (data ?? []) as ClockShift[];
}

export async function loadHolidays(from: string, to: string): Promise<ClockHoliday[]> {
  const { data, error } = await supabase.from('clock_holidays').select('holiday_date, name').gte('holiday_date', from).lte('holiday_date', to);
  if (error) throw new Error('讀取放假日失敗：' + error.message);
  return (data ?? []) as ClockHoliday[];
}

export async function loadEmployees(): Promise<ClockEmployee[]> {
  const { data, error } = await supabase.from('clock_employee_map').select('*').order('device_code');
  if (error) throw new Error('讀取人員對照失敗：' + error.message);
  return (data ?? []) as ClockEmployee[];
}

/** 讀取區間內的打卡與更正。codes 有給就只撈這些人（一般教職員自己查自己時用），沒給就撈全部（管理權限）。 */
export async function loadClockRange(from: string, to: string, codes?: number[]) {
  if (codes && codes.length === 0) return { records: [] as ClockRecord[], overrides: [] as ClockOverride[] };
  const records = await fetchAll<ClockRecord>((a, b) => {
    let q = supabase
      .from('clock_records')
      .select('id, device_code, punched_at, punch_date, method, source, voided, voided_reason, note')
      .gte('punch_date', from)
      .lte('punch_date', to)
      .order('punched_at')
      .range(a, b);
    if (codes) q = q.in('device_code', codes);
    return q;
  });
  const overrides = await fetchAll<ClockOverride>((a, b) => {
    let q = supabase
      .from('clock_day_overrides')
      .select('id, device_code, punch_date, status, note')
      .gte('punch_date', from)
      .lte('punch_date', to)
      .range(a, b);
    if (codes) q = q.in('device_code', codes);
    return q;
  });
  return { records, overrides };
}

export async function loadLastDataAt(): Promise<string | null> {
  const { data, error } = await supabase.rpc('clock_last_data_at');
  if (error) return null;
  return (data as string | null) ?? null;
}

/** 依區間內每天產生一個人的 DaySummary 清單 */
export function buildDays(p: {
  dates: string[];
  employee: ClockEmployee;
  shiftsById: Map<string, ClockShift>;
  records: ClockRecord[]; // 該員工、區間內全部（含作廢，函式內會濾掉）
  overrides: ClockOverride[];
  holidays: Map<string, ClockHoliday>;
}): DaySummary[] {
  const { dates, employee, shiftsById, records, overrides, holidays } = p;
  const myShifts = employee.shift_ids.map((id) => shiftsById.get(id)).filter(Boolean) as ClockShift[];
  const byDate = new Map<string, ClockRecord[]>();
  for (const r of records) {
    if (r.voided) continue;
    const arr = byDate.get(r.punch_date) ?? [];
    arr.push(r);
    byDate.set(r.punch_date, arr);
  }
  const ovByDate = new Map(overrides.map((o) => [o.punch_date, o]));
  const now = bangkokNow();
  return dates.map((date) =>
    summarizeDay({
      date,
      records: byDate.get(date) ?? [],
      shifts: myShifts,
      override: ovByDate.get(date) ?? null,
      holiday: holidays.get(date) ?? null,
      today: now.date,
      nowMinutes: now.minutes,
    })
  );
}

export { addDays };
