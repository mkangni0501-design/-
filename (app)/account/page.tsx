'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「請增加教師及管理者信箱更換功能」：任何已登入的教職員（不限管理員）
// 都可以在這裡自己更換登入信箱，不用麻煩管理員代為操作。
export default function AccountSettingsPage() {
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setCurrentEmail(data.user?.email ?? null);
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setError('請重新登入');
        return;
      }
      const res = await fetch('/api/account/update-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ newEmail, currentPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? '更換失敗');
        return;
      }
      setCurrentEmail(newEmail.trim());
      setNewEmail('');
      setCurrentPassword('');
      setSuccess(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: '40px auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>帳號設定</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 20 }}>目前登入信箱：{currentEmail ?? '載入中…'}</p>

      <h2 style={{ fontSize: 14, marginBottom: 8 }}>更換登入信箱</h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="email"
          placeholder="新信箱"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        <input
          type="password"
          placeholder="目前密碼（確認身分用）"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          style={{ padding: 10, borderRadius: 8, border: '1px solid #ccc' }}
          required
        />
        {error && <p style={{ color: '#A32D2D', fontSize: 13 }}>{error}</p>}
        {success && <p style={{ color: '#3B6D11', fontSize: 13 }}>信箱已更換，請記得下次改用新信箱登入。</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: 12, background: submitting ? '#999' : '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}
        >
          {submitting ? '更換中…' : '更換信箱'}
        </button>
      </form>
    </main>
  );
}
