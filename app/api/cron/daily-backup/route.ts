import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup, insertBackupSnapshot } from '@/lib/backupRestore';

// 理由同 app/api/admin/backup/create/route.ts：全校資料撈取＋寫入備份紀錄，
// 資料量大時需要比預設更久的執行時間。
export const maxDuration = 300;

// 每天自動備份：由排程服務（例如 Vercel Cron，見專案根目錄 vercel.json）呼叫，
// 不是使用者登入觸發，所以用 CRON_SECRET 這組共用密鑰驗證，而不是使用者的登入憑證。
// 請在部署環境的環境變數設定 CRON_SECRET（一組自訂的長亂數字串）。
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: '伺服器尚未設定 CRON_SECRET 環境變數，無法驗證排程請求' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: '驗證失敗' }, { status: 401 });
  }

  try {
    const { tables, counts } = await runBackup(supabaseAdmin);
    // 改用 insertBackupSnapshot()：理由同「手動備份」route（見該檔案與
    // sql/97fix_backup_creation_unknown_error.sql 的說明）——資料量大時改走
    // Storage，避免整包塞進單一 RPC 請求在網路層失敗。
    const { data: inserted, error: insertErr } = await insertBackupSnapshot(supabaseAdmin, '自動', null, tables, counts);
    if (insertErr || !inserted) {
      return NextResponse.json({ error: '備份完成但寫入紀錄失敗：' + (insertErr?.message ?? '未知錯誤') }, { status: 500 });
    }
    return NextResponse.json({ success: true, id: inserted.id, created_at: inserted.created_at, counts });
  } catch (e: any) {
    console.error('[cron/daily-backup] failed:', e);
    const detail =
      e?.message || e?.error_description || e?.details || e?.hint || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
