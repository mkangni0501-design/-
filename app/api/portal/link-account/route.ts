import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 家長/學生透過信箱驗證連結登入後，還要輸入學校給的登入代碼（HY+學號），
// 這支API驗證：目前登入這個帳號的信箱，是否跟該代碼登記的信箱一致——兩者都對才綁定成功。
export async function POST(req: NextRequest) {
  const { loginCode } = (await req.json()) as { loginCode: string };
  if (!loginCode) return NextResponse.json({ error: '請輸入登入代碼' }, { status: 400 });

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !authData.user || !authData.user.email) {
    return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
  }

  const { data: account, error: findErr } = await supabaseAdmin
    .from('portal_accounts')
    .select('id, email, student_no')
    .eq('login_code', loginCode.trim().toUpperCase())
    .maybeSingle();

  if (findErr || !account) {
    return NextResponse.json({ error: '找不到這個登入代碼，請確認是否輸入正確或洽學校確認' }, { status: 404 });
  }

  if (account.email.trim().toLowerCase() !== authData.user.email.trim().toLowerCase()) {
    return NextResponse.json({ error: '這個信箱與學校登記的信箱不一致，請用學校登記的信箱登入' }, { status: 403 });
  }

  // 【2026-08-28 修正】同一個原因（見 app/api/portal/request-login/route.ts 的說明）：
  // 如果目前這個已登入的 Supabase 帳號同時也是教職員帳號（信箱剛好跟某位老師的教職員
  // 登入信箱相同），就不能把它綁定成這位學生/家長的 portal_accounts，不然這個人之後
  // 用同一個瀏覽器 session 直接打 /admin，看到的會是完整的教師/管理後台。
  const { data: staffRow } = await supabaseAdmin.from('app_users').select('id').eq('id', authData.user.id).maybeSingle();
  if (staffRow) {
    return NextResponse.json(
      {
        error:
          '這個信箱同時是教職員登入使用的信箱，不能用來登入家長/學生查詢入口（會拿到教職員帳號的權限）。' +
          '請聯絡學校，將這位學生/家長登記的信箱改成跟教職員帳號不同的信箱後再試一次。',
      },
      { status: 409 }
    );
  }

  const { error: updateErr } = await supabaseAdmin
    .from('portal_accounts')
    .update({ auth_user_id: authData.user.id })
    .eq('id', account.id);

  if (updateErr) {
    return NextResponse.json({ error: '綁定失敗：' + updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, studentNo: account.student_no });
}
