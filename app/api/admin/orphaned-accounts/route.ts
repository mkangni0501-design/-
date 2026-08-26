import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 找出「孤兒帳號」：auth.users 裡已經有這個信箱（會擋住重新新增），
// 但 app_users 完全沒有對應資料列（帳號管理頁面清單讀不到、看不到）。
// 通常是之前新增帳號時，Auth 帳號建立成功、但緊接著寫入 app_users 失敗留下的殘留
// （見 /api/admin/invite-user 的修正說明），也可能是更早期、還沒有這個保護機制時留下的舊資料。
// 只有系統管理員S能查看（跟帳號管理頁面其他敏感操作一致）。
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (callerProfile?.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以查看孤兒帳號' }, { status: 403 });
    }

    const { data: appUserRows, error: appUserErr } = await supabaseAdmin.from('app_users').select('id');
    if (appUserErr) return NextResponse.json({ error: '讀取 app_users 失敗：' + appUserErr.message }, { status: 500 });
    const knownIds = new Set((appUserRows ?? []).map((r) => r.id));

    // Supabase Auth admin listUsers 每頁最多1000筆，分頁抓完為止，避免學校帳號數超過一頁時漏掉。
    const orphaned: { id: string; email: string | null; created_at: string }[] = [];
    let page = 1;
    for (;;) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return NextResponse.json({ error: '讀取登入帳號清單失敗：' + error.message }, { status: 500 });
      const users = data?.users ?? [];
      for (const u of users) {
        if (!knownIds.has(u.id)) orphaned.push({ id: u.id, email: u.email ?? null, created_at: u.created_at });
      }
      if (users.length < 1000) break;
      page += 1;
      if (page > 50) break; // 安全上限，避免資料異常時無窮迴圈
    }

    return NextResponse.json({ orphaned });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
