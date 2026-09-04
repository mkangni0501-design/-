'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { ALL_MODULES } from '@/lib/adminModules';

// 對應反映事項「開發人員區增加一個教師登入首頁設定功能，這樣日後要調整大家登入後
// 首頁比較方便（目前為教師主選單）」：見 sql/65teacher_login_home_setting.sql、
// app/page.tsx 教師卡片登入那段（改成讀這個設定決定要 router.push 去哪）。
// 選項只列出「教師卡片本來就看得到」的功能（adminOnly:false），管理員專用功能
// 不適合當教師登入後的首頁；額外加一個「/admin（教師主選單，目前預設）」選項。
const DEFAULT_PATH = '/admin';
const PATH_OPTIONS = [
  { path: '/admin', label: '/admin（教師主選單，目前預設）' },
  ...ALL_MODULES.filter((m) => !m.adminOnly).map((m) => ({ path: m.href, label: `${m.href}（${m.label}）` })),
];

export default function TeacherLoginHomeSettingsPanel() {
  const [homePath, setHomePath] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('teacher_login_settings').select('home_path').eq('id', true).maybeSingle();
      if (error) {
        setError('讀取設定失敗：' + error.message);
        return;
      }
      const path = data?.home_path ?? DEFAULT_PATH;
      setHomePath(path);
      if (!PATH_OPTIONS.some((o) => o.path === path)) {
        setUseCustom(true);
        setCustomPath(path);
      }
    })();
  }, []);

  async function handleSave(nextPath: string) {
    if (!nextPath.trim() || !nextPath.startsWith('/')) {
      setError('路徑必須是 / 開頭（例如 /admin 或 /attendance/weekly）');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('teacher_login_settings')
      .update({ home_path: nextPath, updated_by: user?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', true);
    setSaving(false);
    if (error) {
      setError('更新失敗：' + error.message);
      return;
    }
    setHomePath(nextPath);
    setSaved(true);
  }

  if (homePath === null && !error) return <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>;

  return (
    <div>
      {error && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>{error}</p>}
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        教師（含導師）用「教師」卡片登入成功後會直接被導去這個網址。不影響「管理者」卡片登入（一律進 /admin）跟「家長」查詢入口。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
        <select
          value={useCustom ? '__custom__' : (homePath ?? DEFAULT_PATH)}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setUseCustom(true);
              return;
            }
            setUseCustom(false);
            handleSave(e.target.value);
          }}
          disabled={saving}
          style={{ padding: 8 }}
        >
          {PATH_OPTIONS.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
          <option value="__custom__">自訂網址…</option>
        </select>
        {useCustom && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/例如：/attendance/weekly"
              style={{ padding: 8, flex: 1 }}
            />
            <button type="button" onClick={() => handleSave(customPath)} disabled={saving} style={{ padding: '8px 16px' }}>
              儲存
            </button>
          </div>
        )}
      </div>
      {saved && <p style={{ fontSize: 12, color: '#3B6D11', marginTop: 8 }}>已儲存，目前設定：{homePath}</p>}
    </div>
  );
}
