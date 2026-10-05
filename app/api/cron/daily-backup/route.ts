import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { startBackupJob, findResumableJob, stepBackupJob } from '@/lib/backupJob';

// 【本輪修正】跟手動備份同一個根因（一次請求撈完全校資料，超過平台單次請求時間上限
// 被切斷）：改成分段備份（見 lib/backupJob.ts）。排程每次被呼叫只做一段（約 4 分鐘內），
// 沒做完的進度存在 Storage，下一次排程自動接續——所以 vercel.json 把排程設成
// 相隔 30 分鐘觸發兩次（見該檔）；已經有今天的自動備份就直接略過，不會重複備份。
export const maxDuration = 300; // 排程沒有人在等回應，可以一次做久一點（專案原本就已經宣告 300 並部署成功）

const CRON_STEP_BUDGET_MS = 240000;

// 每日自動備份：由排程服務（例如 Vercel Cron，見專案根目錄 vercel.json）呼叫，
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
    let state = await findResumableJob(supabaseAdmin);
    if (!state) {
      // 沒有做到一半的：如果最近 12 小時內已經有一份自動備份了，這次排程就略過
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: recent } = await supabaseAdmin.from('backups').select('id').eq('kind', '自動').gte('created_at', since).limit(1);
      if (recent && recent.length > 0) {
        return NextResponse.json({ success: true, skipped: true, reason: '最近 12 小時內已有自動備份' });
      }
      state = await startBackupJob(supabaseAdmin, '自動', null);
    }
    const progress = await stepBackupJob(supabaseAdmin, state, CRON_STEP_BUDGET_MS);
    return NextResponse.json({ success: true, ...progress });
  } catch (e: any) {
    console.error('[cron/daily-backup] failed:', e);
    const detail =
      e?.message || e?.error_description || e?.details || e?.hint || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
