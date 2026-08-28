import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 【2026-08-28 改版】家長／學生查詢入口改用「登入代碼＋手機號碼」登入，不再需要
// 信箱：手機號碼直接比對學籍資料裡本來就有的欄位——學生本人代碼比對
// students.phone，家長代碼比對這個學生底下任一位監護人（guardians）登記的
// phone——校方不用再另外幫每個學生/家長手動建立一筆「登入帳號」、也不用維護一份
// 額外的登入信箱，手機號碼本來就是學籍資料/監護人資料的一部分，改資料的地方也只有
// 一處（學籍資料維護頁），不會有「學籍資料改了電話、但登入帳號沒有跟著改」這種
// 兩邊不同步的問題。
//
// 第一次「登入代碼＋手機號碼」核對成功時，才自動建立/更新 portal_accounts 這筆
// 綁定紀錄（不用校方事先手動建立帳號），之後同一個瀏覽器就有登入 session，不用每次
// 都重新核對。
//
// 核發登入憑證的技術做法：Supabase 的帳號終究要有個信箱/手機才能建立
// session，這裡用「登入代碼」本身組一個固定、外部不會用到的內部信箱
// （例如 hy0123@portal.internal），透過 admin.generateLink()＋verifyOtp() 這組
// Supabase 官方提供、給後台系統直接核發登入憑證用的標準做法建立 session，
// 不會真的寄送任何信件，也不需要簡訊服務。因為這個內部信箱是系統自己組出來的、
// 固定用 @portal.internal 這個不對外的假網域，不可能跟任何教職員真正在用的
// 學校信箱重複，從源頭就避免了之前「學生登入卻核發到教職員帳號」那個問題
// （見下面仍保留的 app_users 檢查，屬於第二層保險，正常情況不會觸發）。
function buildPortalShadowEmail(loginCode: string): string {
  return `${loginCode.trim().toLowerCase()}@portal.internal`;
}

// 手機號碼比對：只看數字，並且容忍「有沒有打國碼(+66/66)、有沒有開頭的 0」這兩種
// 常見的打法差異——例如 0812345678／+66812345678／66812345678 這三種打法其實是
// 同一支號碼，拿掉國碼跟開頭的 0 之後應該都變成同一串「用戶號碼本身」（812345678）。
// 這裡刻意不用「比對末幾碼」這種寬鬆做法：早期版本用「比對最後 8 碼」，但泰國
// 手機號碼開頭 0 之後只有 9 碼，末 8 碼只忽略了第一碼（門號業者碼），會讓
// 0812345678 跟 0912345678 這種第二碼不同、其餘全部剛好相同的兩支「不同」號碼
// 被誤判成同一支——這是會讓不該登入的人核對成功的安全問題，所以改成只拿掉
// 「國碼」「開頭的0」這兩種明確、有意義的格式差異，其餘數字必須完全一致才算對。
function normalizeDigits(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}
function canonicalPhone(s: string): string {
  let d = normalizeDigits(s);
  if (d.startsWith('66') && d.length > 9) d = d.slice(2); // 去掉泰國國碼 66（+66 的 + 已經被 normalizeDigits 拿掉了）
  if (d.startsWith('0')) d = d.slice(1); // 去掉開頭的 0（國內慣用打法）
  return d;
}
function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalPhone(a ?? '');
  const cb = canonicalPhone(b ?? '');
  if (ca.length < 8 || cb.length < 8) return false; // 太短的不算數，避免誤判
  return ca === cb;
}

export async function POST(req: NextRequest) {
  const { loginCode, phone } = (await req.json()) as { loginCode: string; phone: string };
  if (!loginCode || !phone) return NextResponse.json({ error: '請輸入登入代碼與手機號碼' }, { status: 400 });

  const code = loginCode.trim().toUpperCase();
  let relation: '學生本人' | '家長';
  let studentNo: string;
  if (code.startsWith('HYS')) {
    relation = '學生本人';
    studentNo = code.slice(3);
  } else if (code.startsWith('HY')) {
    relation = '家長';
    studentNo = code.slice(2);
  } else {
    return NextResponse.json({ error: '登入代碼格式不正確，請確認學校提供的代碼（例如 HY0123 或 HYS0123）' }, { status: 400 });
  }
  if (!studentNo) {
    return NextResponse.json({ error: '登入代碼格式不正確，請確認學校提供的代碼（例如 HY0123 或 HYS0123）' }, { status: 400 });
  }

  let phoneMatched = false;
  if (relation === '學生本人') {
    const { data: studentRow } = await supabaseAdmin.from('students').select('phone').eq('student_no', studentNo).maybeSingle();
    phoneMatched = !!studentRow && phonesMatch(studentRow.phone, phone);
  } else {
    const { data: guardianRows } = await supabaseAdmin.from('guardians').select('phone').eq('student_no', studentNo);
    phoneMatched = (guardianRows ?? []).some((g: any) => phonesMatch(g.phone, phone));
  }

  // 不論是「查無此學號」「這位學生/家長沒有登記手機號碼」還是「手機號碼真的對不上」，
  // 一律回覆同一句籠統的訊息，不細分原因——避免有心人士靠著錯誤訊息的差異，反過來
  // 猜出「這個學號存不存在」之類的資訊。
  if (!phoneMatched) {
    return NextResponse.json(
      { error: '登入代碼與手機號碼不相符，請確認是否輸入正確；如果手機號碼有變更，請洽學校更新學籍資料後再試' },
      { status: 403 }
    );
  }

  const shadowEmail = buildPortalShadowEmail(code);
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: shadowEmail,
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

  // 第二層保險：理論上 @portal.internal 這個內部假網域不會跟任何教職員的真實學校
  // 信箱重複，這裡還是保留檢查，萬一有人手動把教職員帳號的信箱也設成這個網域，
  // 一樣整個擋下來，不核發、不綁定。
  const { data: staffRow } = await supabaseAdmin.from('app_users').select('id').eq('id', verifyData.session.user.id).maybeSingle();
  if (staffRow) {
    await supabaseAdmin.auth.admin.signOut(verifyData.session.access_token).catch(() => {});
    return NextResponse.json({ error: '登入時發生帳號衝突，請聯絡系統管理員協助處理。' }, { status: 409 });
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('portal_accounts')
    .upsert(
      {
        student_no: studentNo,
        login_code: code,
        relation,
        auth_user_id: verifyData.session.user.id,
      },
      { onConflict: 'login_code' }
    );
  if (upsertErr) {
    return NextResponse.json({ error: '綁定失敗：' + upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    session: {
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    },
    studentNo,
  });
}
