import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
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
      return NextResponse.json({ error: '沒有權限儲存排課專案存檔' }, { status: 403 });
    }

    const body = await req.json();
    const { academicYear, term, note, data } = body ?? {};
    if (!academicYear || !term || !data) {
      return NextResponse.json({ error: '缺少學年度／學期／存檔內容' }, { status: 400 });
    }
    if (!data.GRADES || !data.S) {
      return NextResponse.json({ error: '這個檔案看起來不是排課工具「備份專案」匯出的 JSON 檔案' }, { status: 400 });
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('scheduler_backups')
      .insert({
        academic_year: academicYear,
        term,
        note: note ?? null,
        data,
        saved_by: callerAuth.user.id,
      })
      .select('id, saved_at')
      .single();
    if (insertErr) {
      return NextResponse.json({ error: '儲存失敗：' + insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: inserted.id, saved_at: inserted.saved_at });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
