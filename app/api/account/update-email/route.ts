import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 對應反映事項「請增加教師及管理者信箱更換功能」：讓任何已登入的教職員（不限管理員）
// 自己更換自己的登入信箱，不用透過管理員代為操作。因為改的是登入用的識別碼，這裡
// 要求先輸入目前密碼再次確認身分（避免有人趁教職員忘記把電腦鎖上時，直接把信箱
// 改成自己的、藉此接管帳號）；密碼驗證方式是伺服器端用 service role 直接嘗試登入
// 一次，不影響使用者目前瀏覽器裡的 session。
export async function POST(req: NextRequest) {
  try {
    const { newEmail, currentPassword } = (await req.json()) as { newEmail: string; currentPassword: string };
    if (!newEmail || !currentPassword) {
      return NextResponse.json({ error: '請輸入新信箱與目前密碼' }, { status: 400 });
    }
    const email = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: '信箱格式不正確' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerErr } = await supabaseAdmin.auth.getUser(token);
    if (callerErr || !callerAuth.user || !callerAuth.user.email) {
      return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
    }

    // 驗證目前密碼：直接呼叫 Supabase Auth 的密碼登入端點驗證一次（不透過 SDK 的
    // signInWithPassword()）——因為 supabaseAdmin 是整個伺服器共用的一個 client
    // 實例，如果直接在它上面呼叫 signInWithPassword()，SDK 內部會把這次登入結果
    // 的 session 設進這個共用 client 裡，之後同一個伺服器行程處理的其他（服務端）
    // 請求可能會不小心沿用到這個使用者的 session，而不是原本中立的 service role
    // 身分——用原始 fetch 呼叫同一個驗證端點，純粹只看回應是成功還是失敗，不會
    // 動到任何 client 的狀態。
    const verifyRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      body: JSON.stringify({ email: callerAuth.user.email, password: currentPassword }),
    });
    if (!verifyRes.ok) {
      return NextResponse.json({ error: '目前密碼不正確' }, { status: 403 });
    }

    const oldEmail = callerAuth.user.email;
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(callerAuth.user.id, {
      email,
      email_confirm: true,
    });
    if (updateErr) {
      if (/already registered|already exists/i.test(updateErr.message)) {
        return NextResponse.json({ error: '這個信箱已經被其他帳號使用了' }, { status: 409 });
      }
      return NextResponse.json({ error: '更換信箱失敗：' + updateErr.message }, { status: 500 });
    }

    const { error: logErr } = await supabaseAdmin.from('account_audit_log').insert({
      target_user_id: callerAuth.user.id,
      action: 'email_change',
      old_value: oldEmail,
      new_value: email,
      changed_by: callerAuth.user.id,
    });
    if (logErr) {
      return NextResponse.json({ success: true, logWarning: '信箱已更換，但寫入異動紀錄失敗：' + logErr.message });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
