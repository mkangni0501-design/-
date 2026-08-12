import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 家長輸入「登入代碼＋信箱」後，先在這裡檢查兩者是否對得上，
// 對得上才真的寄驗證信；不對就直接告知失敗，不會寄信給不相符的信箱。
export async function POST(req: NextRequest) {
  const { loginCode, email } = (await req.json()) as { loginCode: string; email: string };
  if (!loginCode || !email) return NextResponse.json({ error: '請輸入登入代碼與信箱' }, { status: 400 });

  const { data: account } = await supabaseAdmin
    .from('portal_accounts')
    .select('id, email')
    .eq('login_code', loginCode.trim().toUpperCase())
    .maybeSingle();

  if (!account || account.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return NextResponse.json({ error: '登入代碼與信箱不相符，請確認是否輸入正確或洽學校確認' }, { status: 403 });
  }

  const { error } = await supabaseAdmin.auth.signInWithOtp({
    email: email.trim(),
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${req.nextUrl.origin}/portal/login?code=${encodeURIComponent(loginCode.trim().toUpperCase())}`,
    },
  });

  if (error) {
    return NextResponse.json({ error: '驗證信寄送失敗：' + error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
