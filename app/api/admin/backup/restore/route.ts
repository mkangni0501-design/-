import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { restoreBackup } from '@/lib/backupRestore';

// 還原備份會整批覆蓋校務資料（學生、班級、成績、出缺勤...等），影響範圍非常大，
// 所以只開放系統管理員S本人可以執行，而且要求前端先做過「輸入確認文字」那一關才會呼叫這支API。
export async function POST(req: NextRequest) {
  try {
    const { backupId } = (await req.json()) as { backupId: string };
    if (!backupId) {
      return NextResponse.json({ error: '缺少 backupId' }, { status: 400 });
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
    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (!callerProfile || callerProfile.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以執行還原' }, { status: 403 });
    }

    const { data: backupRow, error: backupErr } = await supabaseAdmin.from('backups').select('tables').eq('id', backupId).single();
    if (backupErr || !backupRow) {
      return NextResponse.json({ error: '找不到這筆備份' }, { status: 404 });
    }

    const result = await restoreBackup(supabaseAdmin, backupRow.tables as any);

    await supabaseAdmin
      .from('backups')
      .update({ restored_at: new Date().toISOString(), restored_by: callerAuth.user.id })
      .eq('id', backupId);

    return NextResponse.json({ success: result.errors.length === 0, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
