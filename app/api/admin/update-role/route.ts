import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type UserRole = 'system_admin_s' | 'admin_a' | 'admin_b' | 'homeroom_teacher' | 'subject_teacher';

// 角色階層：S(4) > A(3) > B(2) > 導師/任課教師(1)。只能編輯階層嚴格低於自己的帳號，
// 而且改完之後的新角色也必須是嚴格低於自己（不能把人升到跟自己同階或更高）。
// 系統管理員S本身（不論作為異動者的目標或新角色）永遠不能透過此 API 異動。
const ROLE_LEVEL: Record<UserRole, number> = {
  system_admin_s: 4,
  admin_a: 3,
  admin_b: 2,
  homeroom_teacher: 1,
  subject_teacher: 1,
};

export async function POST(req: NextRequest) {
  try {
    const { targetUserId, newRole } = (await req.json()) as { targetUserId: string; newRole: UserRole };
    if (!targetUserId || !newRole) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }
    if (newRole === 'system_admin_s') {
      return NextResponse.json({ error: '系統管理員S不可透過此功能設定' }, { status: 403 });
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

    const { data: callerProfile, error: callerProfileErr } = await supabaseAdmin
      .from('app_users')
      .select('role')
      .eq('id', callerAuth.user.id)
      .single();
    if (callerProfileErr || !callerProfile) {
      return NextResponse.json({ error: '找不到呼叫者角色資料' }, { status: 403 });
    }

    const { data: targetProfile, error: targetErr } = await supabaseAdmin
      .from('app_users')
      .select('role')
      .eq('id', targetUserId)
      .single();
    if (targetErr || !targetProfile) {
      return NextResponse.json({ error: '找不到目標帳號' }, { status: 404 });
    }

    const callerLevel = ROLE_LEVEL[callerProfile.role as UserRole] ?? 0;
    const targetLevel = ROLE_LEVEL[targetProfile.role as UserRole] ?? 0;
    const newLevel = ROLE_LEVEL[newRole] ?? 0;

    if (targetProfile.role === 'system_admin_s') {
      return NextResponse.json({ error: '系統管理員S帳號不可異動' }, { status: 403 });
    }
    if (callerLevel <= targetLevel) {
      return NextResponse.json({ error: '沒有權限編輯此帳號（只能編輯階層低於自己的帳號）' }, { status: 403 });
    }
    if (newLevel >= callerLevel) {
      return NextResponse.json({ error: '不能把帳號改成跟自己同階或更高的角色' }, { status: 403 });
    }

    if (targetProfile.role === newRole) {
      return NextResponse.json({ success: true, unchanged: true });
    }

    const { error: updateErr } = await supabaseAdmin.from('app_users').update({ role: newRole }).eq('id', targetUserId);
    if (updateErr) {
      return NextResponse.json({ error: '更新角色失敗：' + updateErr.message }, { status: 500 });
    }

    const { error: logErr } = await supabaseAdmin.from('account_audit_log').insert({
      target_user_id: targetUserId,
      action: 'role_change',
      old_value: targetProfile.role,
      new_value: newRole,
      changed_by: callerAuth.user.id,
    });
    if (logErr) {
      // 角色本身已經改成功，紀錄失敗不擋住整個操作，但要讓呼叫端知道
      return NextResponse.json({ success: true, logWarning: '角色已更新，但寫入異動紀錄失敗：' + logErr.message });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
