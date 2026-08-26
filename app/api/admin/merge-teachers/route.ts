import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 同一位老師如果被系統記成兩筆不同的 teachers 資料（例如「任課教師設定」用打字建立一筆，
// 後來邀請帳號時名字沒有完全對上、又另外建立一筆），會導致班級/課表/成績等資料分散在
// 兩個不同的 teachers.id 上，這位老師登入後很多頁面會看起來「什麼都沒有」。
// 這支 API 把「要合併掉的那幾筆」所有參照都改指到「要保留的那一筆」，再把多餘的資料刪掉。
//
// ⚠️ 這份清單必須涵蓋「資料庫裡所有外鍵參照到 teachers(id) 的欄位」，一個都不能漏——
// 只要漏掉一個，最後一步刪除多餘教師資料時就會因為還有資料表參照著它而被資料庫擋下來
// （外鍵限制），出現「合併時跳出錯誤提示」的狀況（合併前面的步驟其實都已經做完了，
// 只有最後清除舊資料這一步失敗，等於半途而廢）。
// 之前這裡漏了 substitute_assignments（代課登記的原任課/代課教師）、
// attendance_notifications.decided_by（出缺勤通知是誰決定寄送/不寄送）、
// staff_notifications.teacher_id（站內通知要通知哪位老師）這三個後來才加的表/欄位，
// 就是合併會噴錯的原因。日後如果新增資料表時有欄位參照 teachers(id)，記得也要加進這裡。
const REPOINT_TARGETS: Array<{ table: string; column: string }> = [
  { table: 'classes', column: 'homeroom_teacher_id' },
  { table: 'class_schedule', column: 'teacher_id' },
  { table: 'scores', column: 'recorded_by' },
  { table: 'attendance', column: 'recorded_by' },
  { table: 'conduct_events', column: 'recorded_by' },
  { table: 'student_remarks', column: 'updated_by' },
  { table: 'attendance_audit_log', column: 'changed_by' },
  { table: 'score_audit_log', column: 'changed_by' },
  { table: 'correction_requests', column: 'requested_by' },
  { table: 'substitute_assignments', column: 'original_teacher_id' },
  { table: 'substitute_assignments', column: 'substitute_teacher_id' },
  { table: 'attendance_notifications', column: 'decided_by' },
  { table: 'staff_notifications', column: 'teacher_id' },
];

export async function POST(req: NextRequest) {
  try {
    const { keepId, mergeIds } = (await req.json()) as { keepId: string; mergeIds: string[] };
    if (!keepId || !mergeIds || mergeIds.length === 0) {
      return NextResponse.json({ error: '缺少 keepId 或 mergeIds' }, { status: 400 });
    }
    if (mergeIds.includes(keepId)) {
      return NextResponse.json({ error: '要保留的那一筆不能同時出現在要合併掉的清單裡' }, { status: 400 });
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
    if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
      return NextResponse.json({ error: '沒有權限執行合併' }, { status: 403 });
    }

    const { data: keepRow, error: keepErr } = await supabaseAdmin.from('teachers').select('id, app_user_id, name').eq('id', keepId).single();
    if (keepErr || !keepRow) {
      return NextResponse.json({ error: '找不到要保留的教師資料' }, { status: 404 });
    }
    const { data: mergeRows } = await supabaseAdmin.from('teachers').select('id, app_user_id, name').in('id', mergeIds);

    // 如果要保留的那筆還沒連結登入帳號，但要合併掉的其中一筆有連結，就把帳號連結轉移過去，
    // 這樣合併後這位老師還是能用原本的帳號登入。
    if (!keepRow.app_user_id) {
      const withAccount = (mergeRows ?? []).find((r: any) => r.app_user_id);
      if (withAccount) {
        await supabaseAdmin.from('teachers').update({ app_user_id: withAccount.app_user_id }).eq('id', keepId);
      }
    }

    const repointed: Record<string, number> = {};
    const errors: string[] = [];

    for (const { table, column } of REPOINT_TARGETS) {
      const { error, count } = await supabaseAdmin
        .from(table)
        .update({ [column]: keepId }, { count: 'exact' })
        .in(column, mergeIds);
      if (error) {
        // 42P01＝資料表不存在：代表該功能對應的 SQL migration 還沒在這個環境執行過，
        // 不算合併失敗，安靜略過即可，不用嚇到使用者說「合併出錯」。
        if (error.code !== '42P01') errors.push(`更新 ${table}.${column} 失敗：${error.message}`);
      } else if (count) {
        repointed[table] = (repointed[table] ?? 0) + count;
      }
    }

    const { error: deleteErr } = await supabaseAdmin.from('teachers').delete().in('id', mergeIds);
    if (deleteErr) {
      errors.push('刪除多餘的教師資料失敗（可能還有其他資料表參照到，需要人工檢查）：' + deleteErr.message);
    }

    return NextResponse.json({ success: errors.length === 0, keptName: keepRow.name, repointed, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
