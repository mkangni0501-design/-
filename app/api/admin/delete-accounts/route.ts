import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type UserRole = 'system_admin_s' | 'admin_a' | 'admin_b' | 'homeroom_teacher' | 'subject_teacher';

const ROLE_LEVEL: Record<UserRole, number> = {
  system_admin_s: 4,
  admin_a: 3,
  admin_b: 2,
  homeroom_teacher: 1,
  subject_teacher: 1,
};

// 刪除帳號前，要先把所有「可為空、參照到這個帳號」的歷史紀錄欄位設成 null，
// 否則因為外鍵限制，刪除會直接失敗（例如這個人曾經審核過修改申請、設定過鎖定範圍、
// 建立過備份...等）。這裡故意用「解除關聯」而不是連同歷史紀錄一起刪掉，保留稽核軌跡。
// 部分資料表是選擇性 SQL（registration.sql / portal.sql / student_edit.sql）才會建立，
// 沒執行過的話 update 會出錯，直接忽略即可。
const NULLABLE_REFERENCES: Array<{ table: string; column: string }> = [
  { table: 'account_audit_log', column: 'changed_by' },
  { table: 'backups', column: 'created_by' },
  { table: 'backups', column: 'restored_by' },
  { table: 'profile_edit_requests', column: 'created_by' },
  { table: 'profile_edit_requests', column: 'reviewed_by' },
  { table: 'student_status_changes', column: 'changed_by' },
  { table: 'submission_windows', column: 'set_by' },
  { table: 'submission_windows', column: 'reviewed_by' },
  { table: 'students', column: 'updated_by' },
];

export async function POST(req: NextRequest) {
  try {
    const { targetUserIds } = (await req.json()) as { targetUserIds: string[] };
    if (!targetUserIds || targetUserIds.length === 0) {
      return NextResponse.json({ error: '缺少 targetUserIds' }, { status: 400 });
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
    if (!callerProfile) {
      return NextResponse.json({ error: '找不到呼叫者角色資料' }, { status: 403 });
    }
    const callerLevel = ROLE_LEVEL[callerProfile.role as UserRole] ?? 0;

    if (targetUserIds.includes(callerAuth.user.id)) {
      return NextResponse.json({ error: '不能刪除自己的帳號' }, { status: 400 });
    }

    const deleted: string[] = [];
    const errors: string[] = [];

    for (const targetUserId of targetUserIds) {
      const { data: targetProfile } = await supabaseAdmin.from('app_users').select('role, name').eq('id', targetUserId).single();
      if (!targetProfile) {
        errors.push(`${targetUserId}：找不到這個帳號`);
        continue;
      }
      const targetLevel = ROLE_LEVEL[targetProfile.role as UserRole] ?? 0;
      if (targetProfile.role === 'system_admin_s' || callerLevel <= targetLevel) {
        errors.push(`${targetProfile.name}：沒有權限刪除這個帳號`);
        continue;
      }

      // 教師資料本身不刪（班級/課表/成績紀錄都還在），只是解除跟登入帳號的連結
      await supabaseAdmin.from('teachers').update({ app_user_id: null }).eq('app_user_id', targetUserId);

      for (const ref of NULLABLE_REFERENCES) {
        try {
          await supabaseAdmin.from(ref.table).update({ [ref.column]: null }).eq(ref.column, targetUserId);
        } catch {
          // 資料表不存在（選擇性 SQL 沒執行過）就略過
        }
      }

      const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);
      if (deleteErr) {
        errors.push(`${targetProfile.name}：刪除失敗（${deleteErr.message}）`);
        continue;
      }
      deleted.push(targetProfile.name);
    }

    return NextResponse.json({ success: errors.length === 0, deleted, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
