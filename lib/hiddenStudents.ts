import { supabase } from './supabaseClient';

// ============================================================
// 【本輪新增】反映事項「已休學學生仍可見，現在只有成績登錄表會看到他」。
//
// 根因（sql/37hide_status_changed_students.sql 檔尾其實已經記錄了這個已知
// 限制，只是還沒有實際處理）：隱藏休學/轉學/退學/畢業/肄業學生，靠的是資料庫
// RLS（看 current_role_name() 是不是管理員角色）。但「切換身分 ▾ → 教師視角」
// 這個預覽功能，只是把 sessionStorage 裡的 viewMode 標成 'teacher'，管理員
// 帳號本身在資料庫裡的角色並沒有真的變成教師——RLS 判斷用的是資料庫裡的
// 真實角色，不會管畫面上正在「假裝」是哪個身分，所以管理員不管有沒有切換
// 成教師視角，資料庫這關永遠看得到隱藏名單裡的學生。
//
// 這對「真正的教師帳號」不是問題（RLS 本來就會正確擋下來），只有「管理員切換
// 成教師視角預覽」這一種情況會漏。因為前端已經知道自己現在是不是在「教師視角」
// （isAdminInCurrentView() 這個時候會回傳 false），這裡補一層前端自己的過濾：
// 不是「真管理員視角」的時候，把撈回來的名單再對照一次「目前最新狀態」，
// 是休學/轉學/退學/畢業/肄業的學生從畫面上拿掉——不管是真教師帳號（RLS 早就
// 擋掉，這裡再查一次是安全但多餘的動作）還是管理員的教師視角預覽，都能得到
// 正確結果。
//
// student_status_changes 這張表本身沒有隱藏名單的 RLS（本來就是設計成教職員
// 都能讀，StudentsStatusChangeTab.tsx 的「目前應隱藏名單」也是直接讀這張表），
// 所以這裡查得到，不受身分影響。
// ============================================================

const HIDDEN_STATUSES = new Set(['休學', '轉學', '退學', '畢業', '肄業']);

/**
 * 傳入一批學號，回傳其中「目前最新狀態」屬於休學/轉學/退學/畢業/肄業的學號集合。
 * 用來在「isAdminInCurrentView() 為 false」（真教師帳號、或管理員切換教師視角
 * 預覽）時，對已經查回來的名冊再過濾一次，見上面的說明。
 */
export async function getHiddenStudentNos(studentNos: string[]): Promise<Set<string>> {
  if (studentNos.length === 0) return new Set();
  const { data, error } = await supabase
    .from('student_status_changes')
    .select('student_no, status, effective_date, created_at')
    .in('student_no', studentNos)
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error || !data) return new Set();
  const latestByStudent = new Map<string, string>();
  data.forEach((r: any) => {
    if (!latestByStudent.has(r.student_no)) latestByStudent.set(r.student_no, r.status);
  });
  const hidden = new Set<string>();
  latestByStudent.forEach((status, studentNo) => {
    if (HIDDEN_STATUSES.has(status)) hidden.add(studentNo);
  });
  return hidden;
}
