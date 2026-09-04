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

// 高權限管理者協助重製密碼：只能重製「階層低於自己」的帳號密碼，並留下異動紀錄（不記錄實際密碼內容）。
export async function POST(req: NextRequest) {
  try {
    const { targetUserId, newPassword } = (await req.json()) as { targetUserId: string; newPassword: string };
    if (!targetUserId || !newPassword) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: '密碼至少要6個字元' }, { status: 400 });
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

    if (targetProfile.role === 'system_admin_s') {
      return NextResponse.json({ error: '系統管理員S帳號不可用此功能重設密碼' }, { status: 403 });
    }
    const callerLevel = ROLE_LEVEL[callerProfile.role as UserRole] ?? 0;
    const targetLevel = ROLE_LEVEL[targetProfile.role as UserRole] ?? 0;
    if (callerLevel <= targetLevel) {
      return NextResponse.json({ error: '沒有權限重設此帳號的密碼（只能重設階層低於自己的帳號）' }, { status: 403 });
    }

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, { password: newPassword });
    if (updateErr) {
      return NextResponse.json({ error: '重設密碼失敗：' + updateErr.message }, { status: 500 });
    }

    const { error: logErr } = await supabaseAdmin.from('account_audit_log').insert({
      target_user_id: targetUserId,
      action: 'password_reset',
      old_value: null,
      new_value: '（已由管理者協助重製，實際密碼不留存於紀錄）',
      changed_by: callerAuth.user.id,
    });
    if (logErr) {
      return NextResponse.json({ success: true, logWarning: '密碼已重設，但寫入異動紀錄失敗：' + logErr.message });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
