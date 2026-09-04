import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 對應「第一次登入強制更改密碼」流程的最後一步：驗證呼叫者身分、更新自己的密碼，
// 並把 app_users.must_change_password 清成 false（往後就不會再被
// app/(app)/layout.tsx 攔到 /change-password 頁）。全部用 service role 完成，
// 不需要使用者對 app_users 有直接寫入權限（跟 reset-password／invite-user 等其他
// 帳號管理 API 一樣的做法）。
export async function POST(req: NextRequest) {
  try {
    const { newPassword } = (await req.json()) as { newPassword: string };
    if (!newPassword || newPassword.length < 6) {
      return NextResponse.json({ error: '密碼至少要6個字元' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(callerAuth.user.id, { password: newPassword });
    if (updateErr) {
      return NextResponse.json({ error: '更新密碼失敗：' + updateErr.message }, { status: 500 });
    }

    const { error: clearErr } = await supabaseAdmin.from('app_users').update({ must_change_password: false }).eq('id', callerAuth.user.id);
    if (clearErr) {
      return NextResponse.json({ error: '密碼已更新，但清除提示狀態失敗：' + clearErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
