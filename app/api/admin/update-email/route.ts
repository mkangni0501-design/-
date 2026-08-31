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

// 對應反映事項「請增加教師及管理者信箱更換功能」：高權限管理者協助更換信箱，
// 規則跟既有的 /api/admin/reset-password 一致——只能更換「階層低於自己」的帳號，
// 並留下異動紀錄。跟密碼不同，信箱是登入用的識別碼，改完之後對方要用「新信箱」
// 登入（密碼不變）。
export async function POST(req: NextRequest) {
  try {
    const { targetUserId, newEmail } = (await req.json()) as { targetUserId: string; newEmail: string };
    if (!targetUserId || !newEmail) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }
    const email = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: '信箱格式不正確' }, { status: 400 });
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
      return NextResponse.json({ error: '系統管理員S帳號不可用此功能更換信箱' }, { status: 403 });
    }
    const callerLevel = ROLE_LEVEL[callerProfile.role as UserRole] ?? 0;
    const targetLevel = ROLE_LEVEL[targetProfile.role as UserRole] ?? 0;
    if (callerLevel <= targetLevel) {
      return NextResponse.json({ error: '沒有權限更換此帳號的信箱（只能更換階層低於自己的帳號）' }, { status: 403 });
    }

    const { data: oldUserData } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
    const oldEmail = oldUserData?.user?.email ?? null;

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
      email,
      email_confirm: true, // 直接視為已驗證，不寄確認信（跟建立帳號時的做法一致，不依賴外部信件送達）
    });
    if (updateErr) {
      if (/already registered|already exists/i.test(updateErr.message)) {
        return NextResponse.json({ error: '這個信箱已經被其他帳號使用了' }, { status: 409 });
      }
      return NextResponse.json({ error: '更換信箱失敗：' + updateErr.message }, { status: 500 });
    }

    const { error: logErr } = await supabaseAdmin.from('account_audit_log').insert({
      target_user_id: targetUserId,
      action: 'email_change',
      old_value: oldEmail,
      new_value: email,
      changed_by: callerAuth.user.id,
    });
    if (logErr) {
      return NextResponse.json({ success: true, logWarning: '信箱已更換，但寫入異動紀錄失敗：' + logErr.message });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
