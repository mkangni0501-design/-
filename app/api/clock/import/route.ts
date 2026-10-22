import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseClockCsvText } from '@/lib/staffClock';

// 打卡資料匯入 API。兩種呼叫方式：
//  A) 本機自動同步程式（tools/clock-sync）：Authorization: Bearer <CLOCK_SYNC_TOKEN>
//     （CLOCK_SYNC_TOKEN 是自訂的一串長亂碼，設在 Vercel 環境變數，不是 Supabase 金鑰）
//  B) 後台「匯入與同步」分頁手動上傳：帶登入者的 Supabase access token，
//     且必須是系統管理員S／A，或教務部門成員。
// POST：body 是 UTF-8 的 CSV 文字（欄位格式見 lib/staffClock.ts），可重複上傳，依
//       (打卡機代碼, 打卡時間, 機器編號) 去重，不會產生重複資料。
// GET ：回傳資料庫目前最新一筆打卡時間，本機同步程式用它決定「只需要送哪天之後的資料」。
export const maxDuration = 60;

const CHUNK = 500;

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

type Caller = { kind: 'sync' } | { kind: 'user'; userId: string };

async function authenticate(req: NextRequest): Promise<Caller | NextResponse> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return NextResponse.json({ error: '未提供驗證資訊' }, { status: 401 });

  const syncToken = process.env.CLOCK_SYNC_TOKEN;
  if (syncToken && safeEqual(token, syncToken)) return { kind: 'sync' };

  const { data: auth, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !auth.user) return NextResponse.json({ error: '驗證失敗（token 不正確或登入已過期）' }, { status: 401 });

  const { data: profile } = await supabaseAdmin.from('app_users').select('role').eq('id', auth.user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: '找不到教職員帳號' }, { status: 403 });
  let allowed = profile.role === 'system_admin_s' || profile.role === 'admin_a';
  if (!allowed) {
    const { data: dept } = await supabaseAdmin
      .from('app_user_departments')
      .select('department')
      .eq('app_user_id', auth.user.id)
      .eq('department', 'academic')
      .limit(1);
    allowed = !!dept && dept.length > 0;
  }
  if (!allowed) return NextResponse.json({ error: '沒有匯入打卡資料的權限' }, { status: 403 });
  return { kind: 'user', userId: auth.user.id };
}

export async function GET(req: NextRequest) {
  const caller = await authenticate(req);
  if (caller instanceof NextResponse) return caller;
  // 只看機器來的資料（補卡不算），本機同步程式用它決定「只需要送哪天之後的資料」
  const { data, error } = await supabaseAdmin
    .from('clock_records')
    .select('punched_at')
    .neq('source', 'manual')
    .order('punched_at', { ascending: false })
    .limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ lastPunchAt: data?.[0]?.punched_at ?? null });
}

export async function POST(req: NextRequest) {
  const caller = await authenticate(req);
  if (caller instanceof NextResponse) return caller;

  const source = caller.kind === 'sync' ? 'sync' : 'upload';
  const fileName = new URL(req.url).searchParams.get('file') ?? null;
  const text = await req.text();
  const { rows, invalid } = parseClockCsvText(text);

  const logBase = {
    source,
    file_name: fileName,
    rows_received: rows.length + invalid,
    rows_invalid: invalid,
    created_by: caller.kind === 'user' ? caller.userId : null,
  };

  if (rows.length === 0) {
    await supabaseAdmin.from('clock_import_log').insert({ ...logBase, error: '沒有解析到任何有效打卡列' });
    return NextResponse.json({ error: '沒有解析到任何有效打卡列，請確認是打卡機匯出的 CSV', invalid }, { status: 400 });
  }

  try {
    // 1) 沒看過的打卡機代碼：自動建立人員對照（teacher_id 先留空，之後由教務處指定）
    const codes = Array.from(new Map(rows.map((r) => [r.device_code, r.device_name])).entries());
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('clock_employee_map')
      .select('device_code')
      .in('device_code', codes.map(([c]) => c));
    if (exErr) throw new Error('讀取人員對照失敗：' + exErr.message);
    const known = new Set((existing ?? []).map((e: any) => e.device_code as number));
    const newCodes = codes.filter(([c]) => !known.has(c));
    if (newCodes.length > 0) {
      const { error } = await supabaseAdmin
        .from('clock_employee_map')
        .upsert(
          newCodes.map(([device_code, device_name]) => ({ device_code, device_name })),
          { onConflict: 'device_code', ignoreDuplicates: true }
        );
      if (error) throw new Error('建立人員對照失敗：' + error.message);
    }

    // 2) 打卡紀錄：分批寫入，遇到重複（同一人同一分鐘同一機器）自動略過；回傳的列數＝實際新增數
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, source }));
      const { data, error } = await supabaseAdmin
        .from('clock_records')
        .upsert(chunk, { onConflict: 'device_code,punched_at,machine_no', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error('寫入打卡紀錄失敗：' + error.message);
      inserted += data?.length ?? 0;
    }

    const times = rows.map((r) => r.punched_at).sort();
    const summary = {
      received: rows.length,
      inserted,
      duplicates: rows.length - inserted,
      invalid,
      newCodes: newCodes.map(([c]) => c),
      firstPunch: times[0],
      lastPunch: times[times.length - 1],
    };
    await supabaseAdmin.from('clock_import_log').insert({
      ...logBase,
      rows_received: rows.length + invalid,
      rows_inserted: inserted,
      rows_duplicate: rows.length - inserted,
      new_codes: summary.newCodes,
      first_punch: summary.firstPunch,
      last_punch: summary.lastPunch,
    });
    return NextResponse.json({ success: true, ...summary });
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await supabaseAdmin.from('clock_import_log').insert({ ...logBase, error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
