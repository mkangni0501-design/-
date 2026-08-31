'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員處增加【第一次登入強制更改密碼】功能」：開關開啟時，
// 新建立的教職員帳號會被標記 must_change_password=true（見
// app/api/admin/invite-user/route.ts），app/(app)/layout.tsx 會攔截所有教職員頁面、
// 導來這裡，改完密碼才能繼續使用系統。
export default function ChangePasswordPage() {
  const [checking, setChecking] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace('/');
        return;
      }
      setChecking(false);
    })();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) {
      setError('密碼至少要6個字元');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('兩次輸入的密碼不一致');
      return;
    }
    setSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setError('請重新登入');
        return;
      }
      const res = await fetch('/api/account/complete-password-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ newPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? '更新失敗');
        return;
      }
      router.push('/admin');
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) return <main style={{ padding: 24 }}>載入中…</main>;

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>請先設定新密碼</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 24 }}>
        這是您第一次登入（或密碼剛被管理員重設），系統要求先自己設定一組新密碼，才能繼續使用。
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="password"
          placeholder="新密碼（至少6碼）"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        <input
          type="password"
          placeholder="再輸入一次新密碼"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: 12, background: submitting ? '#999' : '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}
        >
          {submitting ? '更新中…' : '更新密碼並繼續'}
        </button>
      </form>
    </main>
  );
}
