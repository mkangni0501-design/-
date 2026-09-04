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
