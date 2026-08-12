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

  const { error: updateErr } = await supabaseAdmin
    .from('portal_accounts')
    .update({ auth_user_id: authData.user.id })
    .eq('id', account.id);

  if (updateErr) {
    return NextResponse.json({ error: '綁定失敗：' + updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, studentNo: account.student_no });
}
