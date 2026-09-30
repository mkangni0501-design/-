import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup, insertBackupSnapshot } from '@/lib/backupRestore';

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

    // 改用 insertBackupSnapshot()（見 lib/backupRestore.ts、sql/97fix_backup_creation_unknown_error.sql
    // 的說明）：資料量小就跟以前一樣直接存進 tables 欄位；資料量大就先上傳到
    // Storage、backups 這一列只存路徑，避免整包塞進單一 RPC 請求，超過大小
    // 限制在網路層直接失敗、前端只看得到「未知錯誤」。
    const { data: inserted, error: insertErr } = await insertBackupSnapshot(supabaseAdmin, '手動', callerAuth.user.id, tables, counts);
    if (insertErr || !inserted) {
      return NextResponse.json({ error: '備份完成但寫入紀錄失敗：' + (insertErr?.message ?? '未知錯誤') }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: inserted.id, created_at: inserted.created_at, counts });
  } catch (e: any) {
    // 【本輪修正】反映事項「備份失敗：未知錯誤」——原本 catch 到的例外如果沒有
    // `.message`（例如網路層直接中斷連線拋出的例外、或某個第三方套件拋出的
    // 非標準物件），使用者只會看到「未知錯誤」四個字，完全沒有線索可以往下查。
    // 這裡把能拿到的資訊盡量都塞進錯誤訊息、同時印到伺服器端 log，之後真的再
    // 發生時，開發人員到 Vercel 的 Logs 至少看得到完整內容，不用只靠使用者
    // 回報的這四個字去猜。
    console.error('[backup/create] failed:', e);
    const detail =
      e?.message || e?.error_description || e?.details || e?.hint || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
