import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { startBackupJob, findResumableJob, stepBackupJob, putState } from '@/lib/backupJob';

// 每日自動備份（Vercel Cron 呼叫，見專案根目錄 vercel.json）。
//
// 【自動備份一直沒有真的做完的根因】
// 1. 備份是分段做的（見 lib/backupJob.ts），但排程「每次被呼叫只做一段」，而 vercel.json
//    一天只觸發兩次 → 一份備份要很多段，兩次排程根本做不完；
// 2. 進度原本只在一整段結束時才存，排程那一段又很長，中途只要被平台切斷／逾時，進度就
//    全部丟掉，下一次排程從頭來過；
// 3. 結果就是排程每天只留下「做到一半的自動備份工作」，backups 表一直沒有「自動」紀錄，
//    直到有人按手動備份、由手動接手跑完，才出現一筆（當時顯示成「自動」）。
//
// 【修正】
// - 進度每寫完一個分段檔就存（lib/backupJob.ts），被切斷也只損失一小段；
// - 這支 API 一次盡量做久（預算 CRON_STEP_BUDGET_MS），沒做完就「自己再呼叫自己」接著做
//   （最多 MAX_CHAIN 輪），不必等下一次排程；
// - 加上「租約」，同時有兩個排程實例（例如兩個排程時間點、或上一輪還沒結束）時不會重複做同一份；
// - 兩個排程時間點仍然保留當作保險：萬一接力中斷，下一次排程會從存檔的進度接續。
export const maxDuration = 300;

const CRON_STEP_BUDGET_MS = 200000; // 留 100 秒給收尾（寫 manifest、寫備份紀錄、接力呼叫）
const LEASE_EXTRA_MS = 90000;
const MAX_CHAIN = 12;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: '伺服器尚未設定 CRON_SECRET 環境變數，無法驗證排程請求' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: '驗證失敗' }, { status: 401 });
  }

  const chain = Math.max(0, Number(new URL(req.url).searchParams.get('chain') ?? 0) || 0);

  try {
    let state = await findResumableJob(supabaseAdmin);
    if (state?.leaseUntil && new Date(state.leaseUntil).getTime() > Date.now()) {
      // 另一個排程實例正在做這一份，不要重複做
      return NextResponse.json({ success: true, busy: true, jobId: state.jobId });
    }
    if (!state) {
      // 沒有做到一半的：如果最近 12 小時內已經有一份自動備份了，這次排程就略過
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: recent } = await supabaseAdmin.from('backups').select('id').eq('kind', '自動').gte('created_at', since).limit(1);
      if (recent && recent.length > 0) {
        return NextResponse.json({ success: true, skipped: true, reason: '最近 12 小時內已有自動備份' });
      }
      state = await startBackupJob(supabaseAdmin, '自動', null);
    }

    state.leaseUntil = new Date(Date.now() + CRON_STEP_BUDGET_MS + LEASE_EXTRA_MS).toISOString();
    const progress = await stepBackupJob(supabaseAdmin, state, CRON_STEP_BUDGET_MS);
    console.log('[cron/daily-backup]', JSON.stringify({ chain, ...progress, counts: undefined }));

    if (!progress.done) {
      // 釋放租約，並自己再呼叫自己接著做下一輪（不等回應，只確認請求已送出）
      state.leaseUntil = null;
      await putState(supabaseAdmin, state).catch(() => {});
      if (chain < MAX_CHAIN) {
        const next = new URL(req.url);
        next.searchParams.set('chain', String(chain + 1));
        fetch(next.toString(), { headers: { authorization: `Bearer ${expected}` }, signal: AbortSignal.timeout(4000) }).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000)); // 給請求一點時間真的送出去
      }
    }
    return NextResponse.json({ success: true, chain, ...progress });
  } catch (e: any) {
    console.error('[cron/daily-backup] failed:', e);
    const detail =
      e?.message || e?.error_description || e?.details || e?.hint || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
