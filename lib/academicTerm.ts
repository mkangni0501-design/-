import { supabase } from './supabaseClient';

export type CurrentTerm = { academic_year: number; term: string };

/**
 * 【2026-08 修正】取得「目前生效」的學年學期。
 *
 * 根因：原本多個頁面（查詢教師/班級課表、代課安排…）都直接呼叫
 * `supabase.rpc('current_academic_term')`，這個 RPC 只會回傳
 * `academic_terms` 資料表裡 `is_current = true` 的那一筆——但「設為目前生效」
 * 需要開發人員到「學年學期設定」頁手動按過才會有這筆資料。只要還沒有人按過
 * （或者不小心兩邊都取消），RPC 就會回傳空陣列，這些頁面又沒有任何退回值，
 * 依賴這個值的查詢直接被擋在最前面完全不會執行——畫面上看起來就是「所有帳號
 * 都完全查不到／排不了」，卻沒有任何錯誤訊息可以除錯。
 *
 * 修正：改成呼叫這個共用函式，在 RPC 查無資料時依序退回：
 *   1. `academic_terms` 裡狀態是「進行中」的最新一筆
 *   2. `academic_terms` 裡學年度最新的一筆（同一學年度優先抓「下學期」）
 * 這樣即使還沒有人手動設定「目前生效」，頁面也能先用最合理的猜測正常運作，
 * 不會整頁打不開；之後有人到「學年學期設定」頁正式設定，就會改用那一筆。
 */
export async function resolveCurrentTerm(): Promise<CurrentTerm | null> {
  const { data: termData } = await supabase.rpc('current_academic_term');
  const t = Array.isArray(termData) ? termData[0] : termData;
  if (t && t.academic_year != null && t.term) {
    return { academic_year: t.academic_year, term: t.term };
  }

  const { data: rows } = await supabase
    .from('academic_terms')
    .select('academic_year, term, status')
    .order('academic_year', { ascending: false });
  if (!rows || rows.length === 0) return null;

  const inProgress = rows.find((r: any) => r.status === '進行中');
  if (inProgress) return { academic_year: inProgress.academic_year, term: inProgress.term };

  const latestYear = rows[0].academic_year;
  const sameYear = rows.filter((r: any) => r.academic_year === latestYear);
  const secondTerm = sameYear.find((r: any) => r.term === '下學期');
  return secondTerm ? { academic_year: secondTerm.academic_year, term: secondTerm.term } : { academic_year: sameYear[0].academic_year, term: sameYear[0].term };
}

/**
 * 【本輪新增】反映事項「學生出席紀錄查詢、任課班級出席查詢，讀取出缺勤紀錄
 * 一直出現『canceling statement due to statement timeout』」。
 *
 * 根因：這幾頁在算「這學期／從開學到今天」的出缺勤時，如果 academic_terms
 * 裡沒有人填過這個學年學期的開學日（term_start_date 是 null），原本的寫法是
 * 完全不限制日期下限（或退回極早的日期）——等於每次都對整張 attendance 表
 * （全校、從系統啟用第一天到現在，可能橫跨好幾個學年度）做查詢。對於本來就
 * 不符合「系統管理員／訓導部門／導師本班」這幾個能被快速判斷的身分的使用者
 * （最典型的就是任課教師——RLS 的 can_read_attendance() 對他們只能靠
 * enrollments/class_schedule 的 EXISTS 子查詢逐列判斷），要判斷的候選列數一旦
 * 沒有日期範圍收斂、變成整張表等級，逐列判斷的成本乘上去，就足以超過
 * statement_timeout 被中止——這正是「讀取出缺勤紀錄失敗：canceling statement
 * due to statement timeout」的根因，不是資料量本身有問題，是查詢範圍沒有被
 * 限制住。
 *
 * 修法：開學日還沒填的話，不要整張表下限全部打開，改成用「學年度＋學期」
 * 直接估出一個合理的開學日下限——不用額外查一次資料庫、也一定能把查詢範圍
 * 收斂在「這學期」等級，不會再退化成整張表的規模。等哪天有人真的到「學年
 * 學期設定」頁填了正確的開學日，就會改用那個更準確的日期，這裡只是「還沒填
 * 之前」的安全下限，不是要取代它。
 *
 * 日期依學校實際回報的學制調整：上學期抓 5/1、下學期抓 10/20，兩學期都在
 * 同一個學年度年份內（不是一般行事曆常見的「下學期跨到隔年 2 月」）。
 */
export function estimateTermStart(academicYear: number, term: string): string {
  return term === '下學期' ? `${academicYear}-10-20` : `${academicYear}-05-01`;
}
