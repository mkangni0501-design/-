import { supabase } from './supabaseClient';
import { fetchAllPaged } from './schoolWideDataQueries';

export type AttendanceRow = { student_no: string; record_date: string; period_no: number; status: string };

const CONCURRENCY = 8;

/**
 * 【本輪新增】反映事項「學年學期已經正確填了開學日（5/11～9/30），管理員A、S
 * 看『學期』統計表還是『讀取出缺勤紀錄失敗：canceling statement due to
 * statement timeout』，而且開啟很慢」。
 *
 * 根因：attendance/report、attendance/subject-view 這兩頁原本都是「一次」對
 * attendance 下 `.in('student_no', 一整班的學號).gte(...).lte(...)`（分頁抓到底），
 * 這種「一大串 IN 名單 + 日期範圍」的組合，查詢規劃器不一定會選用
 * (student_no, record_date, period_no) 這組複合唯一索引——如果改選了 sql/80
 * 那個單純依 record_date 建的索引（idx_attendance_record_date），就會變成先掃出
 * 「全校在這學期日期範圍內的所有出缺勤紀錄」，再逐列篩學號／套 RLS，範圍等於
 * 整個學期、全校規模，不是只有這個班級——這才是即使已經把日期收斂在「這學期」
 * 這麼窄的範圍、還是逾時或很慢的根因。且 fetchAllPaged 需要的 ORDER BY
 * （student_no, record_date, period_no）如果規劃器選的是別的索引，還會多一次
 * 對這個大集合的排序，更慢。
 *
 * 修法：不要用一大串 IN 名單去撈，改成「每個學生各自查一次」（同一時間最多
 * CONCURRENCY 個並行），每一次查詢都是 `student_no = 這個學號`（單一相等條件，
 * 精準命中複合索引最左邊那一欄），查詢規劃器沒有模糊空間，一定會用
 * 索引精準掃到這個學生的資料列、不會牽動其他學生／其他班級的資料，範圍穩定
 * 收斂在「這個學生 × 這段日期」，不會再退化成全校規模。
 */
export async function fetchAttendanceForStudents(
  studentNos: string[],
  rangeStart: string | null,
  rangeEnd: string
): Promise<{ data: AttendanceRow[]; error: any }> {
  const rows: AttendanceRow[] = [];
  for (let i = 0; i < studentNos.length; i += CONCURRENCY) {
    const batch = studentNos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((studentNo) =>
        fetchAllPaged<AttendanceRow>((from, to) => {
          let q = supabase
            .from('attendance')
            .select('student_no, record_date, period_no, status')
            .eq('student_no', studentNo);
          if (rangeStart) q = q.gte('record_date', rangeStart);
          q = q.lte('record_date', rangeEnd);
          // 分頁撈取一定要有固定排序，否則頁與頁之間可能漏列或重複。
          return q.order('record_date').order('period_no').range(from, to);
        })
      )
    );
    for (const r of results) {
      if (r.error) return { data: rows, error: r.error };
      rows.push(...r.data);
    }
  }
  return { data: rows, error: null };
}
