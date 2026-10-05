import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { startBackupJob, loadJob, stepBackupJob, findResumableJob } from '@/lib/backupJob';

// 【本輪修正，根因已確認】備份原本是「一次請求」把全校所有資料表撈完，資料量
// （尤其 attendance）成長後，單次請求的總時間超過平台上限，連線被平台切斷（HTTP 504）。
// 改成「分段備份」：前端反覆呼叫這支 API，每次只做約 20 秒就回傳進度，下一次接續，
// 詳見 lib/backupJob.ts 開頭的說明。這樣不管資料量多大、平台單次上限多短都不會 504。
//
// 請求格式（POST，JSON）：
//   { action: 'start' }            → 開始（或接續尚未完成的自動備份）新的備份，回傳 jobId＋第一段進度
//   { action: 'step', jobId }      → 接續執行一段，回傳進度；done=true 時附上 id/created_at/counts
export const maxDuration = 60;

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

    const body = await req.json().catch(() => ({} as any));
    const action: string = body?.action ?? 'start';

    if (action === 'start') {
      // 如果有「每日自動備份」做到一半的 job，直接接手做完，不用重頭再撈一次
      let resumable = await findResumableJob(supabaseAdmin);
      // 前端記著上次中斷的 jobId，帶回來就接續（只接續「手動」且還沒做完的 job）
      if (!resumable && body?.resumeJobId) {
        const prev = await loadJob(supabaseAdmin, String(body.resumeJobId));
        if (prev && !prev.finished && prev.kind === '手動') resumable = prev;
      }
      const state = resumable ?? (await startBackupJob(supabaseAdmin, '手動', callerAuth.user.id));
      const progress = await stepBackupJob(supabaseAdmin, state);
      return NextResponse.json({ success: true, ...progress });
    }

    if (action === 'step') {
      const jobId = String(body?.jobId ?? '');
      const state = await loadJob(supabaseAdmin, jobId);
      if (!state) {
        return NextResponse.json({ error: '找不到這個備份工作（可能已過期或 jobId 不正確），請重新開始備份' }, { status: 404 });
      }
      const progress = await stepBackupJob(supabaseAdmin, state);
      return NextResponse.json({ success: true, ...progress });
    }

    return NextResponse.json({ error: '不認得的 action：' + action }, { status: 400 });
  } catch (e: any) {
    console.error('[backup/create] failed:', e);
    const detail =
      e?.message || e?.error_description || e?.details || e?.hint || (typeof e === 'string' ? e : null) || JSON.stringify(e) || '未知錯誤';
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
