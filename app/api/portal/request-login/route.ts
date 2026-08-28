import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 家長輸入「登入代碼＋信箱」後，先在這裡檢查兩者是否對得上，
// 對得上才真的寄驗證信；不對就直接告知失敗，不會寄信給不相符的信箱。
//
// 【2026-08-19 新增】「是否啟用信箱驗證」開關（portal_login_settings，開發人員區
// 可以調整）：目前學校用區域網路、連不到校外，寄驗證信這條路走不通，關掉這個開關
// 之後，這裡改成「不寄信，直接在伺服器端幫這個信箱建立一個已登入的 session」，
// 用的是 Supabase 官方提供、給後台系統使用、不會觸發寄信的 admin.generateLink()
// 搭配 verifyOtp() 這個標準做法（在 Supabase 的機制裡，這是「伺服器端直接核發登入
// 憑證」的正規流程，不是繞過安全機制的土砲寫法），順便直接把 portal_accounts 的
// auth_user_id 綁好，前端拿到 session 之後就能直接進「家長/學生查詢」頁，不用
// 再多一個步驟去呼叫 link-account。
export async function POST(req: NextRequest) {
  const { loginCode, email } = (await req.json()) as { loginCode: string; email: string };
  if (!loginCode || !email) return NextResponse.json({ error: '請輸入登入代碼與信箱' }, { status: 400 });

  const { data: account } = await supabaseAdmin
    .from('portal_accounts')
    .select('id, email, student_no')
    .eq('login_code', loginCode.trim().toUpperCase())
    .maybeSingle();

  if (!account || account.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return NextResponse.json({ error: '登入代碼與信箱不相符，請確認是否輸入正確或洽學校確認' }, { status: 403 });
  }

  const { data: settings } = await supabaseAdmin.from('portal_login_settings').select('email_verification_enabled').eq('id', true).maybeSingle();
  // 資料表還沒建（sql/51 還沒執行）或查不到資料時，安全預設值是「維持原本要驗證」，
  // 不會因為這張表意外是空的，就悄悄變成人人可以不驗證信箱直接登入。
  const verificationEnabled = settings?.email_verification_enabled ?? true;

  if (!verificationEnabled) {
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: email.trim(),
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return NextResponse.json({ error: '建立登入憑證失敗：' + (linkErr?.message ?? '未知錯誤') }, { status: 500 });
    }
    const { data: verifyData, error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
      type: 'magiclink',
      token_hash: linkData.properties.hashed_token,
    });
    if (verifyErr || !verifyData.session) {
      return NextResponse.json({ error: '建立登入憑證失敗：' + (verifyErr?.message ?? '未知錯誤') }, { status: 500 });
    }

    // 【2026-08-28 修正】反映事項「學生登入以後首頁是教師版」的根因：Supabase 的帳號是
    // 用「信箱」認的，全站只有一個命名空間——如果這個信箱剛好也是某位教職員登入用的
    // 信箱（例如老師自己也是某個學生的家長、登記時填了跟教職員帳號同一個信箱；或資料
    // 建檔時不小心填錯），上面 generateLink()／verifyOtp() 這兩步「核發登入憑證」核發
    // 到的，就會是「那位教職員原本那個帳號」的 session，不是一個新的、乾淨的家長/學生
    // 專用身分——因為 Supabase 認的是信箱，不是「這次是要核發哪一種用途的憑證」。
    // 這裡等於把教職員帳號的完整權限，原封不動核發給任何一個知道「登入代碼＋這個
    // 信箱」的人，讓他們可以在【家長/學生查詢】這個入口拿到一個貨真價實的教職員登入
    // session，之後只要瀏覽器網址直接打 /admin，看到的就是完整的教師/管理後台——
    // 這就是「學生登入卻看到教師版首頁」實際發生的機制，不是畫面顯示邏輯寫錯。
    // 修法：核發憑證之後，先檢查這個信箱背後的帳號是不是教職員帳號（app_users 有沒有
    // 這筆），有的話整個擋下來，不綁定 portal_accounts、也不把這組 session 交給前端，
    // 並提醒學校去改這位學生/家長登記的信箱（不能跟任何教職員帳號共用同一個信箱）。
    const { data: staffRow } = await supabaseAdmin.from('app_users').select('id').eq('id', verifyData.session.user.id).maybeSingle();
    if (staffRow) {
      await supabaseAdmin.auth.admin.signOut(verifyData.session.access_token).catch(() => {});
      return NextResponse.json(
        {
          error:
            '這個信箱同時是教職員登入使用的信箱，不能用來登入家長/學生查詢入口（會拿到教職員帳號的權限）。' +
            '請聯絡學校，將這位學生/家長登記的信箱改成跟教職員帳號不同的信箱後再試一次。',
        },
        { status: 409 }
      );
    }

    const { error: bindErr } = await supabaseAdmin
      .from('portal_accounts')
      .update({ auth_user_id: verifyData.session.user.id })
      .eq('id', account.id);
    if (bindErr) {
      return NextResponse.json({ error: '綁定失敗：' + bindErr.message }, { status: 500 });
    }
    return NextResponse.json({
      verificationEnabled: false,
      session: {
        access_token: verifyData.session.access_token,
        refresh_token: verifyData.session.refresh_token,
      },
      studentNo: account.student_no,
    });
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

  return NextResponse.json({ verificationEnabled: true, success: true });
}

