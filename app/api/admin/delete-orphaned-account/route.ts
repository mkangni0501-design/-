import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 刪除指定的孤兒登入帳號（auth.users 有、app_users 沒有的那種）。
// 刪除前重新確認一次「真的還是孤兒」，避免跟同時間新增帳號的操作打架。
export async function POST(req: NextRequest) {
  try {
    const { targetAuthUserId } = (await req.json()) as { targetAuthUserId: string };
    if (!targetAuthUserId) return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (callerProfile?.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以刪除孤兒帳號' }, { status: 403 });
    }

    const { data: stillThere } = await supabaseAdmin.from('app_users').select('id').eq('id', targetAuthUserId).maybeSingle();
    if (stillThere) {
      return NextResponse.json({ error: '這個帳號現在已經有角色資料了（可能剛被建立成功），不是孤兒帳號，不會刪除' }, { status: 409 });
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(targetAuthUserId);
    if (error) return NextResponse.json({ error: '刪除失敗：' + error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
