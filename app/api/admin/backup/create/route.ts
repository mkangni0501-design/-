import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup } from '@/lib/backupRestore';

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
      return NextResponse.json({ error: '沒有權限執行備份' }, { status: 403 });
    }

    const { tables, counts } = await runBackup(supabaseAdmin);
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('backups')
      .insert({ kind: '手動', created_by: callerAuth.user.id, tables, table_counts: counts })
      .select('id, created_at')
      .single();
    if (insertErr) {
      return NextResponse.json({ error: '備份完成但寫入紀錄失敗：' + insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: inserted.id, created_at: inserted.created_at, counts });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
