import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 批次版的「刪除孤兒登入帳號」：跟 /api/admin/delete-orphaned-account（單筆）邏輯一樣，
// 只是一次接受多個 targetAuthUserIds，逐筆刪除、逐筆回報結果，其中一筆失敗不會擋住其他筆繼續刪。
export async function POST(req: NextRequest) {
  try {
    const { targetAuthUserIds } = (await req.json()) as { targetAuthUserIds: string[] };
    if (!Array.isArray(targetAuthUserIds) || targetAuthUserIds.length === 0) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (callerProfile?.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以刪除孤兒帳號' }, { status: 403 });
    }

    // 重新確認一次「真的還是孤兒」，避免跟同時間新增帳號的操作打架
    const { data: stillThereRows } = await supabaseAdmin.from('app_users').select('id').in('id', targetAuthUserIds);
    const nowHasProfile = new Set((stillThereRows ?? []).map((r) => r.id));

    const deleted: string[] = [];
    const errors: string[] = [];
    for (const id of targetAuthUserIds) {
      if (nowHasProfile.has(id)) {
        errors.push(`${id}：現在已經有角色資料了（可能剛被建立成功），不是孤兒帳號，已略過`);
        continue;
      }
      const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
      if (error) errors.push(`${id}：${error.message}`);
      else deleted.push(id);
    }

    return NextResponse.json({ deleted, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
