import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 帳號管理頁面本來只從 app_users 讀 id/姓名/角色（沒有信箱，信箱存在 Supabase Auth，
// 前端一般權限查不到）。「下載目前帳號名單」如果要跟「批次上傳」範本同一種格式（含信箱，
// 才能真的拿來當範本用），就需要這支API幫忙把信箱補回來。
// 只回傳「呼叫者在畫面上本來就看得到」的那幾個 id 對應的信箱（由前端傳入 userIds），
// 不會讓一般教職員撈到別人的信箱。
export async function POST(req: NextRequest) {
  try {
    const { userIds } = (await req.json()) as { userIds: string[] };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ emails: {} });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
      return NextResponse.json({ error: '沒有權限查詢帳號信箱' }, { status: 403 });
    }

    const wanted = new Set(userIds);
    const emails: Record<string, string | null> = {};
    let page = 1;
    for (;;) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return NextResponse.json({ error: '讀取信箱失敗：' + error.message }, { status: 500 });
      const users = data?.users ?? [];
      for (const u of users) {
        if (wanted.has(u.id)) emails[u.id] = u.email ?? null;
      }
      if (users.length < 1000 || Object.keys(emails).length >= wanted.size) break;
      page += 1;
      if (page > 50) break;
    }

    return NextResponse.json({ emails });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
