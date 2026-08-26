'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';

// 家長／學生查詢入口「是否啟用信箱驗證」開關。關閉時，輸入登入代碼＋信箱送出後
// 直接進入查詢頁，不會寄驗證信──給目前還在用區域網路、連不到校外信箱的情境用；
// 之後恢復對外連線，記得回來打開。實際登入行為的判斷在
// app/api/portal/request-login/route.ts（伺服器端），這裡只是提供開關給管理者調整。
export default function PortalLoginSettingsPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.from('portal_login_settings').select('email_verification_enabled').eq('id', true).maybeSingle();
    if (error) {
      setLoadError('讀取設定失敗：' + error.message + '（可能是 sql/51portal_login_verification_toggle.sql 還沒執行）');
      return;
    }
    setEnabled(data?.email_verification_enabled ?? true);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleToggle() {
    if (enabled === null) return;
    setSaving(true);
    const appUser = await getCurrentAppUser();
    const { error } = await supabase
      .from('portal_login_settings')
      .update({ email_verification_enabled: !enabled, updated_by: appUser?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', true);
    setSaving(false);
    if (error) {
      alert('儲存失敗：' + error.message);
      return;
    }
    setEnabled(!enabled);
  }

  if (loadError) return <p style={{ fontSize: 13, color: '#A32D2D' }}>{loadError}</p>;
  if (enabled === null) return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} disabled={saving} onChange={handleToggle} style={{ width: 16, height: 16 }} />
        啟用信箱驗證（勾選：輸入代碼＋信箱後寄驗證信，需點信箱裡的連結才能登入；取消勾選：輸入完直接登入，不寄信）
      </label>
      {!enabled && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
          目前是關閉狀態：任何人只要知道正確的「登入代碼＋登記信箱」就能直接登入查詢，不需要真的收得到那個信箱的信。
          只建議在無法連外（例如純區域網路）、且信任使用環境的情況下關閉；恢復對外連線後，建議重新勾選。
        </p>
      )}
    </div>
  );
}
