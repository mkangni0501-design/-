'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員處增加【第一次登入強制更改密碼】功能並可以勾選是否開啟」：
// 開啟後，之後用【帳號管理】頁「管理員直接設定初始密碼」建立的新帳號，第一次登入
// 就會被導去 /change-password 頁強制先改密碼才能繼續使用（見
// app/(app)/layout.tsx、app/api/admin/invite-user/route.ts）。用「寄邀請信」建立
// 的帳號不受影響（對方本來就是自己設定第一組密碼）。
export default function PasswordPolicySettingsPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('password_policy_settings').select('force_change_on_first_login').eq('id', true).maybeSingle();
      if (error) {
        setError('讀取設定失敗：' + error.message);
        return;
      }
      setEnabled(data?.force_change_on_first_login ?? false);
    })();
  }, []);

  async function handleToggle() {
    if (enabled === null) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('password_policy_settings')
      .update({ force_change_on_first_login: next, updated_by: user?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', true);
    setSaving(false);
    if (error) {
      setError('更新失敗：' + error.message);
      return;
    }
    setEnabled(next);
  }

  if (enabled === null && !error) return <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>;

  return (
    <div>
      {error && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>{error}</p>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!enabled} onChange={handleToggle} disabled={saving} />
        新帳號第一次登入強制要求先改密碼
      </label>
      <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        只影響【帳號管理】頁「管理員直接設定初始密碼」建立的新帳號（用寄邀請信建立的帳號，對方本來就是自己設第一組密碼，不受影響）。
      </p>
    </div>
  );
}
