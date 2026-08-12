import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runBackup } from '@/lib/backupRestore';

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
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('backups')
      .insert({ kind: '自動', created_by: null, tables, table_counts: counts })
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
