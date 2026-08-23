'use client';

export const dynamic = 'force-dynamic';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

function PortalLoginPageInner() {
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [verificationEnabled, setVerificationEnabled] = useState(true);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    (async () => {
      // 提前查一次「是否啟用信箱驗證」，只是用來調整畫面上的說明文字跟按鈕文字
      // （關閉時不用讓人誤以為還要去收信），真正決定行為的判斷在伺服器端
      // （app/api/portal/request-login/route.ts），這裡查不到就當作維持預設（啟用）。
      const { data: settingsRow } = await supabase.from('portal_login_settings').select('email_verification_enabled').eq('id', true).maybeSingle();
      if (settingsRow) setVerificationEnabled(settingsRow.email_verification_enabled);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      // 從驗證信連結回來時，網址會帶著當初輸入的登入代碼，先幫忙帶入
      const codeFromUrl = searchParams.get('code');
      if (!session) {
        setChecking(false);
        if (codeFromUrl) setLoginCode(codeFromUrl);
        return;
      }
      setSignedInEmail(session.user.email ?? null);

      // 【修正】家長如果有兩個以上小孩，每個小孩各自有獨立的登入代碼，但綁定的是
      // 同一個 auth_user_id（同一個信箱帳號）。原本這裡有兩個問題：
      // 1. 用 .maybeSingle() 查「是否已經綁定過」，一旦這個信箱已經綁過兩個以上小孩
      //    （對到兩筆以上 portal_accounts），.maybeSingle() 會回傳錯誤，導致誤判、
      //    卡在奇怪的中間狀態，這就是家長反映「兩個以上小孩、建立完成後登入會出錯」
      //    的根因。這裡改成用一般查詢＋看筆數，不管綁過幾個小孩都不會出錯。
      // 2. 只要「綁過任何一個小孩」就直接導去 /portal，完全沒機會繼續綁第二個小孩——
      //    只有當網址沒有帶新的登入代碼時，才代表這次只是單純回來查詢、可以直接進入；
      //    如果網址帶著新的登入代碼（例如正在新增第二個小孩、點的是新的驗證信連結），
      //    就算已經綁過其他小孩，也要留在這一頁讓他把新代碼繼續綁下去。
      if (!codeFromUrl) {
        const { data: existing } = await supabase.from('portal_accounts').select('id').eq('auth_user_id', session.user.id).limit(1);
        if (existing && existing.length > 0) {
          router.push('/portal');
          return;
        }
      }
      if (codeFromUrl) setLoginCode(codeFromUrl);
      setChecking(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRequestLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/portal/request-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginCode, email }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? '寄送失敗');
      return;
    }
    // 【2026-08-19】開發人員區把「信箱驗證」關掉時，這支 API 不會寄信，而是直接
    // 回傳一組已經登入好的 session——這裡直接把它設成目前的登入狀態，跳過「寄信/
    // 等待點連結」那一步，符合「輸入完直接登入」的要求。
    if (body.verificationEnabled === false && body.session) {
      const { error: setErr } = await supabase.auth.setSession({
        access_token: body.session.access_token,
        refresh_token: body.session.refresh_token,
      });
      if (setErr) {
        setError('登入失敗：' + setErr.message);
        return;
      }
      router.push('/portal');
      return;
    }
    setSent(true);
  }

  async function handleLinkAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('請先完成信箱驗證');
      return;
    }
    const res = await fetch('/api/portal/link-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ loginCode }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? '綁定失敗');
      return;
    }
    router.push('/portal');
  }

  if (checking) return <main style={{ padding: 24 }}>載入中…</main>;

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <button
        onClick={() => router.push('/')}
        style={{ background: 'none', border: 'none', color: '#999', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 16 }}
      >
        ‹ 返回選擇身分
      </button>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>家長／學生查詢入口</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>
        {verificationEnabled
          ? '請輸入學校提供的登入代碼（格式為 HY+學號）與登記的信箱，系統會寄一封驗證信到該信箱，點開連結即可完成登入。'
          : '請輸入學校提供的登入代碼（格式為 HY+學號）與登記的信箱，送出後即可直接進入查詢。'}
      </p>

      {!signedInEmail ? (
        !sent ? (
          <form onSubmit={handleRequestLink} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              placeholder="登入代碼（例如 HY0123）"
              value={loginCode}
              onChange={(e) => setLoginCode(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
              required
            />
            <input
              type="email"
              placeholder="登記的信箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
              required
            />
            {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
            <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
              {verificationEnabled ? '寄送登入驗證信' : '登入'}
            </button>
          </form>
        ) : (
          <p style={{ fontSize: 14 }}>已寄出驗證信到 {email}，請到信箱點擊連結完成登入。</p>
        )
      ) : (
        <form onSubmit={handleLinkAccount} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#666' }}>目前登入信箱：{signedInEmail}</p>
          <input
            placeholder="登入代碼（例如 HY0123）"
            value={loginCode}
            onChange={(e) => setLoginCode(e.target.value)}
            style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
            required
          />
          {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
          <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
            確認查詢
          </button>
        </form>
      )}
    </main>
  );
}

export default function PortalLoginPage() {
  return (
    <Suspense fallback={null}>
      <PortalLoginPageInner />
    </Suspense>
  );
}
