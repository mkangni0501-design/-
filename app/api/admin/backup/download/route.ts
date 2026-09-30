import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadBackupSnapshot } from '@/lib/backupRestore';

// 【本輪新增】配合 insertBackupSnapshot()／loadBackupSnapshot()（見
// lib/backupRestore.ts、sql/97fix_backup_creation_unknown_error.sql 的說明）：
// 備份內容現在可能存在 Storage 而不是 backups.tables 欄位裡，前端原本直接用
// 登入者身分 `supabase.from('backups').select('tables')` 讀取的做法就不夠用了
// （一來 tables 可能是 null，二來一般瀏覽器端的登入身分沒有 Storage 的讀取
// 權限）。改成透過這支 API（service role）統一處理，不管內容存在哪裡、
// 不管操作者是 system_admin_s／admin_a／admin_b 哪個管理員角色，都能正確下載。
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });
    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
      return NextResponse.json({ error: '沒有權限下載備份' }, { status: 403 });
    }

    const { data: row, error: rowErr } = await supabaseAdmin
      .from('backups')
      .select('tables, storage_path, created_at')
      .eq('id', id)
      .single();
    if (rowErr || !row) return NextResponse.json({ error: '找不到這筆備份' }, { status: 404 });

    const { snapshot, error: loadErr } = await loadBackupSnapshot(supabaseAdmin, row);
    if (loadErr || !snapshot) {
      return NextResponse.json({ error: '讀取備份內容失敗：' + (loadErr?.message ?? '未知錯誤') }, { status: 500 });
    }

    return new NextResponse(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="backup-${String(row.created_at).slice(0, 19).replace(/[:T]/g, '-')}.json"`,
      },
    });
  } catch (e: any) {
    console.error('[backup/download] failed:', e);
    const detail = e?.message || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
