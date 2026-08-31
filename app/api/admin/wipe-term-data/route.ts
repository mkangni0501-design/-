import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup } from '@/lib/backupRestore';

// 一鍵清空前一定會先跑一次「全校全部資料表」的完整備份（見下方 runBackup），
// 資料量大時（尤其 attendance／scores 累積一整個學年度）光是備份就可能超過
// Vercel 預設的伺服器函式執行時間上限，導致整個請求被平台中斷、前端收到逾時錯誤，
// 看起來就像「一鍵清空失敗」。這裡明確拉長這個路由的執行時間上限。
// 注意：Hobby 方案即使設定這個數字，平台仍會限制在 60 秒；如果學校資料量真的很大、
// 60 秒仍不夠，需要升級 Vercel 方案（Pro 以上可到 300 秒）才能讓這個上限生效。
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const TERMS = ['上學期', '下學期'];

// 一鍵清空：把選定「學年度＋學期」的資料完全刪除，只留在備份區。
// 範圍：這個學年度的班級底下、這個學期的「學生名冊(enrollments)」以及跟著它的成績、評語，
// 加上這個學年度＋學期的課表、科目與比重、整體佔比規則、加扣分規則、鎖定期間設定。
//
// 刻意不動：
// - classes 本身：同一個學年度的班級橫跨上下學期共用同一筆 classes 資料，只清掉一個學期的話
//   不能把 classes 整筆刪掉，否則另一個學期的資料會跟著壞掉。班級本身要刪要用「班級與導師設定」頁處理。
// - students：學生基本資料不是「學年度＋學期」的資料，屬於學生本人，不在這個功能範圍內。
// - attendance：出缺勤只記錄「學號＋日期」，不是用「學年度＋學期」直接關聯，沒辦法在這裡安全地只清掉
//   單一學期，避免誤刪到其他學期的紀錄。如需清除出缺勤，請個別處理。
export async function POST(req: NextRequest) {
  try {
    const { academicYear, term, skipBackup } = (await req.json()) as { academicYear: number; term: string; skipBackup?: boolean };
    if (!academicYear || !TERMS.includes(term)) {
      return NextResponse.json({ error: '請提供正確的學年度與學期' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: '未登入' }, { status: 401 });
    }
    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) {
      return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
    }
    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (!callerProfile || callerProfile.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以執行一鍵清空' }, { status: 403 });
    }

    // 清空前預設會先備份一次完整資料，確保「資料只留在備份區」這件事是真的成立。
    // 但這個完整備份要掃過全校所有資料表，資料量大時很容易撞到 Vercel 的執行時間上限，
    // 導致「一鍵清空」整個請求逾時失敗、卻又不確定資料到底刪了沒有——對單純想清掉測試資料、
    // 本來就不需要保留備份的情境來說反而變成阻礙。這裡讓呼叫端可以明確傳 skipBackup:true
    // 跳過這個步驟，直接執行刪除，加快速度、也更不容易逾時；正式資料清空仍建議保留預設的備份。
    if (!skipBackup) {
      const { tables, counts } = await runBackup(supabaseAdmin);
      const { error: backupErr } = await supabaseAdmin
        .from('backups')
        .insert({ kind: '手動', created_by: callerAuth.user.id, tables, table_counts: counts });
      if (backupErr) {
        return NextResponse.json({ error: '清空前的安全備份失敗，已中止、沒有刪除任何資料：' + backupErr.message }, { status: 500 });
      }
    }

    const removed: Record<string, number> = {};
    const errors: string[] = [];

    const { data: classRows, error: classErr } = await supabaseAdmin.from('classes').select('id').eq('academic_year', academicYear);
    if (classErr) {
      return NextResponse.json({ error: '讀取班級清單失敗：' + classErr.message }, { status: 500 });
    }
    const classIds = (classRows ?? []).map((c: any) => c.id);

    let enrollmentIds: string[] = [];
    if (classIds.length > 0) {
      const { data: enrollRows, error: enrollErr } = await supabaseAdmin
        .from('enrollments')
        .select('id')
        .in('class_id', classIds)
        .eq('term', term);
      if (enrollErr) {
        return NextResponse.json({ error: '讀取學生名冊失敗：' + enrollErr.message }, { status: 500 });
      }
      enrollmentIds = (enrollRows ?? []).map((e: any) => e.id);
    }

    if (enrollmentIds.length > 0) {
      const { data: scoreRows } = await supabaseAdmin.from('scores').select('id').in('enrollment_id', enrollmentIds);
      const scoreIds = (scoreRows ?? []).map((s: any) => s.id);

      if (scoreIds.length > 0) {
        const { error, count } = await supabaseAdmin.from('correction_requests').delete({ count: 'exact' }).in('record_id', scoreIds);
        if (error) errors.push('刪除相關修正申請失敗：' + error.message);
        else removed['correction_requests'] = count ?? 0;
      }

      let r = await supabaseAdmin.from('scores').delete({ count: 'exact' }).in('enrollment_id', enrollmentIds);
      if (r.error) errors.push('刪除成績失敗：' + r.error.message);
      else removed['scores'] = r.count ?? 0;

      r = await supabaseAdmin.from('student_remarks').delete({ count: 'exact' }).in('enrollment_id', enrollmentIds);
      if (r.error) errors.push('刪除評語失敗：' + r.error.message);
      else removed['student_remarks'] = r.count ?? 0;

      r = await supabaseAdmin.from('enrollments').delete({ count: 'exact' }).in('id', enrollmentIds);
      if (r.error) errors.push('刪除學生名冊失敗：' + r.error.message);
      else removed['enrollments'] = r.count ?? 0;
    }

    const scopedDeletes: Array<{ table: string; match: Record<string, any> }> = [
      { table: 'class_schedule', match: { academic_year: academicYear, term } },
      { table: 'curriculum', match: { academic_year: academicYear, term } },
      { table: 'grading_rules', match: { academic_year: academicYear, term } },
      { table: 'score_adjustments', match: { academic_year: academicYear, term } },
      { table: 'submission_windows', match: { academic_year: academicYear, term } },
    ];
    for (const { table, match } of scopedDeletes) {
      let q = supabaseAdmin.from(table).delete({ count: 'exact' });
      Object.entries(match).forEach(([col, val]) => {
        q = q.eq(col, val);
      });
      const { error, count } = await q;
      if (error) errors.push(`刪除 ${table} 失敗：` + error.message);
      else removed[table] = count ?? 0;
    }

    return NextResponse.json({ success: errors.length === 0, removed, errors, skippedBackup: !!skipBackup });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
