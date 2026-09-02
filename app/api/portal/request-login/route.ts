import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// ⚠️ 這裡故意「不」直接對 lib/supabaseAdmin.ts 匯出的那個共用 supabaseAdmin 呼叫
// auth.verifyOtp()：那個 client 是整個伺服器行程共用的單一個 instance（module-level
// singleton），呼叫 verifyOtp() 之後，這個 instance 內部記住的 session 會從「service
// role」變成「剛剛核發的那個學生/家長帳號」，導致同一個 supabaseAdmin 之後所有
// .from(...) 查詢送出的 Authorization 都變成用那個學生/家長的 JWT，而不是 service
// role key——不但讓後面 portal_accounts 這種本來要用管理權限寫入的動作反而被 RLS
// 擋下來（表現成「new row violates row-level security policy」），因為同一個
// instance 是整個伺服器共用的，理論上還會有「不同使用者幾乎同時登入時互相污染彼此
// session」的更嚴重問題。因此這裡另外開一個「只在這次請求內使用、不共用」的 client
// 專門負責 generateLink／verifyOtp 這段核發登入憑證的流程，驗證完就地丟棄，不會
// 影響到 supabaseAdmin 之後查資料庫用的 service role 權限。
function createRequestScopedAuthClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

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
  let rawStudentNo: string;
  if (code.startsWith('HYS')) {
    relation = '學生本人';
    rawStudentNo = code.slice(3);
  } else if (code.startsWith('HY')) {
    relation = '家長';
    rawStudentNo = code.slice(2);
  } else {
    return NextResponse.json({ error: '登入代碼格式不正確，請確認學校提供的代碼（例如 HY0123 或 HYS0123）' }, { status: 400 });
  }
  if (!rawStudentNo) {
    return NextResponse.json({ error: '登入代碼格式不正確，請確認學校提供的代碼（例如 HY0123 或 HYS0123）' }, { status: 400 });
  }

  // 學號比對要用「不分大小寫」：登入代碼在上面被整段轉成大寫（方便使用者不用在意
  // HY/HYS 開頭大小寫），但 students.student_no 是自由輸入的文字欄位，學籍資料建檔
  // 當時打的英文字母大小寫不一定跟登入代碼裡的一致（例如學號存的是 S0140，但代碼
  // 轉大寫後比對的是 S0140 沒錯，可是萬一原始學號是 s0140 這種小寫就會比對不到）。
  // 純數字學號不受影響，但只要學號帶英文字母就可能發生「手機號碼明明填對、卻怎麼
  // 都登入不了」的狀況，且系統只會回覆籠統的「代碼與手機不符」，很難排查。這裡先
  // 用不分大小寫查詢找出資料庫裡實際的學號（含原始大小寫），後續查詢/寫入都改用
  // 這個「資料庫實際值」，不要再用使用者輸入轉大寫後的版本。
  const { data: studentByNo } = await supabaseAdmin
    .from('students')
    .select('student_no, phone')
    .ilike('student_no', rawStudentNo)
    .maybeSingle();
  const studentNo = studentByNo?.student_no ?? rawStudentNo;

  let phoneMatched = false;
  if (relation === '學生本人') {
    phoneMatched = !!studentByNo && phonesMatch(studentByNo.phone, phone);
  } else {
    const { data: guardianRows } = await supabaseAdmin.from('guardians').select('phone').ilike('student_no', rawStudentNo);
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

  // 【本輪修正】反映事項「家裡有好幾個小孩在本校就讀的家長，是否能同時查看所有
  // 小孩的資料」——原本這裡固定用「這次登入代碼本身」組出來的影子信箱
  // （hy0123@portal.internal）去核發登入憑證，每個學號各自對應一個獨立的
  // Supabase 帳號身分。家長如果有好幾個小孩，用小孩A的代碼登入一次、小孩B的
  // 代碼再登入一次，會拿到兩個「不同」的身分（auth_user_id 不一樣），portal_
  // accounts 這兩筆各自綁在不同身分下——即使 app/(app)/portal/page.tsx 那邊
  // 本來就有處理「同一個身分綁定好幾個學生」的邏輯（一次查出 auth_user_id
  // 底下所有 portal_accounts、下拉選單切換），因為身分從一開始就沒有共用，
  // 這段邏輯永遠只會看到一個學生。
  // 修正做法（只套用在「家長」登入，「學生本人」維持各自獨立身分不變，因為
  // 學生本人就是不同的真人，不該共用）：先查「同一支手機號碼」還對應著哪些
  // 其他學生（透過 guardians.phone 比對，判斷這支手機底下同時是好幾個小孩的
  // 監護人），如果那些學生裡，已經有任何一個的家長查詢帳號綁過登入身分了，
  // 這次改成沿用「那個」身分的影子信箱去核發登入憑證（Supabase 對同一個信箱
  // 核發 magic link 一定會核發回同一個帳號身分），讓這次登入延續同一個身分，
  // 而不是每個小孩各自建立一個獨立身分——這樣同一個家長無論用哪個小孩的代碼
  // 登入，最終都會收斂成同一個身分，/portal 那邊原本就有的多學生切換功能
  // 自然就能正常運作。第一次登入（還沒有任何小孩綁過身分）時，維持用這次的
  // 登入代碼本身當身分起點，之後其他小孩的登入才會沿用這個起點。
  let identityShadowEmail = buildPortalShadowEmail(code);
  if (relation === '家長') {
    const { data: siblingGuardianRows } = await supabaseAdmin.from('guardians').select('student_no, phone');
    const siblingStudentNos = (siblingGuardianRows ?? [])
      .filter((g: any) => phonesMatch(g.phone, phone))
      .map((g: any) => g.student_no);
    if (siblingStudentNos.length > 0) {
      const siblingLoginCodes = siblingStudentNos.map((no: string) => 'HY' + no);
      const { data: existingBound } = await supabaseAdmin
        .from('portal_accounts')
        .select('login_code, auth_user_id, created_at')
        .in('login_code', siblingLoginCodes)
        .not('auth_user_id', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1);
      if (existingBound && existingBound.length > 0) {
        identityShadowEmail = buildPortalShadowEmail(existingBound[0].login_code);
      }
    }
  }

  const shadowEmail = identityShadowEmail;
  const authClient = createRequestScopedAuthClient();
  const { data: linkData, error: linkErr } = await authClient.auth.admin.generateLink({
    type: 'magiclink',
    email: shadowEmail,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    return NextResponse.json({ error: '建立登入憑證失敗：' + (linkErr?.message ?? '未知錯誤') }, { status: 500 });
  }
  const { data: verifyData, error: verifyErr } = await authClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });
  if (verifyErr || !verifyData.session) {
    return NextResponse.json({ error: '建立登入憑證失敗：' + (verifyErr?.message ?? '未知錯誤') }, { status: 500 });
  }

  // 第二層保險：理論上 @portal.internal 這個內部假網域不會跟任何教職員的真實學校
  // 信箱重複，這裡還是保留檢查，萬一有人手動把教職員帳號的信箱也設成這個網域，
  // 一樣整個擋下來，不核發、不綁定。這裡跟下面的 upsert 都刻意繼續用最上面 import
  // 進來的共用 supabaseAdmin（service role），不要用剛剛那個 authClient，
  // 才不會被套用學生/家長本人的 RLS 權限。
  const { data: staffRow } = await supabaseAdmin.from('app_users').select('id').eq('id', verifyData.session.user.id).maybeSingle();
  if (staffRow) {
    await authClient.auth.admin.signOut(verifyData.session.access_token).catch(() => {});
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
