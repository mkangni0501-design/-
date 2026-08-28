'use client';

export const dynamic = 'force-dynamic';
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

// 【2026-08-28 改版】家長／學生查詢入口改用「登入代碼＋手機號碼」一步登入，不再
// 需要信箱／驗證信這一段：手機號碼直接跟學籍資料/監護人資料裡登記的電話比對
// （見 app/api/portal/request-login/route.ts），核對成功就直接拿到登入 session，
// 不用再多一步「先收信、點連結、回來才輸入代碼綁定」。
function PortalLoginPageInner() {
  const [loginCode, setLoginCode] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      const codeFromUrl = searchParams.get('code');
      if (!session) {
        setChecking(false);
        if (codeFromUrl) setLoginCode(codeFromUrl);
        return;
      }

      // 反映事項「學生登入以後首頁是教師版」的防護：如果這台裝置/瀏覽器剛好還留著
      // 教職員沒登出的 session，不要把它當成這次家長/學生登入的身分，先登出、當作
      // 「還沒登入」處理，讓真正要查詢的人從乾淨的狀態重新輸入登入代碼與手機號碼。
      const { data: staffRow } = await supabase.from('app_users').select('id').eq('id', session.user.id).maybeSingle();
      if (staffRow) {
        await supabase.auth.signOut();
        setChecking(false);
        if (codeFromUrl) setLoginCode(codeFromUrl);
        return;
      }

      // 已經有登入中的家長/學生 session（例如之前登入過沒登出），且這次不是要
      // 綁定新的代碼（網址沒帶 code），就直接進查詢頁；否則留在這頁讓他繼續操作
      // （例如要換一個小孩的代碼查詢）。
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/request-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginCode, phone }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? '登入失敗');
        return;
      }
      const { error: setErr } = await supabase.auth.setSession({
        access_token: body.session.access_token,
        refresh_token: body.session.refresh_token,
      });
      if (setErr) {
        setError('登入失敗：' + setErr.message);
        return;
      }
      router.push('/portal');
    } finally {
      setSubmitting(false);
    }
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
        請輸入學校提供的登入代碼（家長為 HY+學號，學生本人為 HYS+學號）與登記在學籍資料裡的手機號碼，送出後即可直接進入查詢。
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          placeholder="登入代碼（例如 HY0123）"
          value={loginCode}
          onChange={(e) => setLoginCode(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        <input
          type="tel"
          placeholder="手機號碼"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: 12, background: submitting ? '#999' : '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
          {submitting ? '登入中…' : '登入'}
        </button>
        <p style={{ fontSize: 12, color: '#999' }}>手機號碼跟學校登記的不一致嗎？請洽學校更新學籍資料後再試。</p>
      </form>
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
