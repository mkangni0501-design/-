import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup } from '@/lib/backupRestore';

// 全校資料撈取＋寫入備份紀錄，資料量大時可能需要比預設更久的執行時間，
// 拉長這支 route 的執行時間上限（實際上限仍受 Vercel 方案本身的執行時間
// 上限限制，Hobby 方案可能無法真的跑到這麼久，如果方案上限比較低可以調低這個值）。
export const maxDuration = 300;

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
    // 改用 admin_insert_backup()（見 sql/79backup_timeout_and_upload_restore.sql）
    // 而不是直接 `.from('backups').insert(...)`：資料量大時，單一 INSERT 寫入整包
    // 快照會超過 service_role 預設的 statement_timeout 被取消，這個 function
    // 把「這次寫入」的 statement_timeout 另外拉長，避免「備份完成但寫入紀錄失敗：
    // canceling statement due to statement timeout」。
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .rpc('admin_insert_backup', {
        p_kind: '手動',
        p_created_by: callerAuth.user.id,
        p_tables: tables,
        p_table_counts: counts,
      })
      .single();
    if (insertErr) {
      return NextResponse.json({ error: '備份完成但寫入紀錄失敗：' + insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: inserted.id, created_at: inserted.created_at, counts });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
