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
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) {
        setChecking(false);
        // 從驗證信連結回來時，網址會帶著當初輸入的登入代碼，先幫忙帶入
        const codeFromUrl = searchParams.get('code');
        if (codeFromUrl) setLoginCode(codeFromUrl);
        return;
      }
      setSignedInEmail(session.user.email ?? null);

      // 已經綁定過，直接進入
      const { data: existing } = await supabase.from('portal_accounts').select('id').eq('auth_user_id', session.user.id).maybeSingle();
      if (existing) {
        router.push('/portal');
        return;
      }
      const codeFromUrl = searchParams.get('code');
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
        請輸入學校提供的登入代碼（格式為 HY+學號）與登記的信箱，系統會寄一封驗證信到該信箱，點開連結即可完成登入。
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
              寄送登入驗證信
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
