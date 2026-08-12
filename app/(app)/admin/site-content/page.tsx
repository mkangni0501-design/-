'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { ALL_MODULES } from '@/lib/adminModules';
import { getSiteContentMap, saveSiteContentMap, getSiteSetting, saveSiteSetting, SITE_CONTENT_DEFAULTS, moduleLabelKey } from '@/lib/siteContent';

// 這幾個 key 對應到畫面上顯示的中文標籤，方便系統管理員S知道自己在改的是哪一段文字，
// 不用去記 key 字串本身代表什麼。
const CONTENT_LABELS: Record<string, string> = {
  'category_hint.academic': '首頁分類說明：教務',
  'category_hint.discipline': '首頁分類說明：訓輔',
  'category_hint.general': '首頁分類說明：總務',
  'category_hint.teacher': '首頁分類說明：教師',
  'category_hint.parent_student': '首頁分類說明：家長／學生',
  'category_hint.dev': '首頁分類說明：開發／除錯',
  'page_hint.scores_entry': '成績登錄頁：批次上傳說明',
  'page_hint.attendance_mobile_legend': '出缺勤登錄頁：顏色圖例收合標題',
  'page_hint.attendance_subject_view': '任課班級出席查詢頁：說明文字',
};

export default function SiteContentAdminPage() {
  const [allowed, setAllowed] = useState<'checking' | 'yes' | 'no'>('checking');
  const [values, setValues] = useState<Record<string, string>>(SITE_CONTENT_DEFAULTS);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [musicStatus, setMusicStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      // 這頁是全站設定（不分部門），刻意只給系統管理員S用，跟部門管理員（A/B）能看到
      // 的其他分類設定頁不一樣範圍，所以這裡不是照 ADMIN_ROLES 三種都放行，是額外多檢查一層。
      if (!appUser || appUser.role !== 'system_admin_s') {
        setAllowed('no');
        return;
      }
      setAllowed('yes');
      const map = await getSiteContentMap();
      setValues(map);
      const url = await getSiteSetting('background_music_url');
      setMusicUrl(url);
    })();
  }, []);

  async function handleSaveContent() {
    setSaveStatus('saving');
    const error = await saveSiteContentMap(values);
    if (error) {
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
  }

  async function handleUploadMusic(file: File) {
    setMusicStatus('uploading');
    const path = `background-music/${Date.now()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from('site-assets').upload(path, file);
    if (uploadError) {
      setMusicStatus('error');
      alert('上傳失敗：' + uploadError.message);
      return;
    }
    const { data: publicUrlData } = supabase.storage.from('site-assets').getPublicUrl(path);
    const saveError = await saveSiteSetting('background_music_url', publicUrlData.publicUrl);
    if (saveError) {
      setMusicStatus('error');
      alert(saveError);
      return;
    }
    setMusicUrl(publicUrlData.publicUrl);
    setMusicStatus('idle');
  }

  async function handleRemoveMusic() {
    const error = await saveSiteSetting('background_music_url', null);
    if (error) {
      alert(error);
      return;
    }
    setMusicUrl(null);
  }

  if (allowed === 'checking') {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  if (allowed === 'no') {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>系統文字與背景音樂設定</h1>
        <p style={{ fontSize: 13, color: '#999' }}>此頁僅系統管理員可使用。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>系統文字與背景音樂設定</h1>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
        目前只涵蓋下面這幾段文字（首頁六個分類說明＋成績登錄／出缺勤登錄／出席查詢這幾頁的說明），
        還沒涵蓋系統裡其他寫死在畫面上的文字；之後要擴大範圍可以再請開發人員把其他頁面接上這套機制。
      </p>

      <h2 id="bgm" style={{ fontSize: 14, marginBottom: 8 }}>背景音樂</h2>
      {musicUrl ? (
        <div style={{ marginBottom: 8 }}>
          <audio controls src={musicUrl} style={{ width: '100%', marginBottom: 8 }} />
          <button onClick={handleRemoveMusic} style={{ padding: '4px 12px', fontSize: 12, color: '#A32D2D' }}>
            移除目前的背景音樂
          </button>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>目前尚未設定背景音樂。</p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUploadMusic(file);
        }}
        style={{ fontSize: 12 }}
      />
      {musicStatus === 'uploading' && <p style={{ fontSize: 12, color: '#999' }}>上傳中…</p>}
      <p style={{ fontSize: 11, color: '#999', marginTop: 4, marginBottom: 20 }}>
        上傳後所有登入的人在畫面右上角都會看到播放鍵；瀏覽器規定不能自動播放有聲音的內容，
        每個人要自己按一次播放鍵才會開始播放（這不是本系統的限制，是 Chrome／Safari 的規定）。
      </p>

      <h2 id="card-labels" style={{ fontSize: 14, marginBottom: 8 }}>功能卡片名稱</h2>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>
        這是每個功能在首頁卡片、教學作業清單上顯示的名稱（例如「排課系統（自動排課工具）」），改這裡就會直接改掉畫面上顯示的文字。
      </p>
      <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 10, marginBottom: 20 }}>
        {ALL_MODULES.map((m) => {
          const key = moduleLabelKey(m.key);
          return (
            <div key={m.key} style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 11, color: '#999', marginBottom: 2 }}>{m.href}</label>
              <input
                value={values[key] ?? m.label}
                onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                style={{ width: '100%', padding: 8, boxSizing: 'border-box', fontSize: 13 }}
              />
            </div>
          );
        })}
      </div>

      <h2 id="other-text" style={{ fontSize: 14, marginBottom: 8 }}>其他說明文字</h2>
      {Object.keys(SITE_CONTENT_DEFAULTS)
        .filter((key) => !key.startsWith('module_label.'))
        .map((key) => (
        <div key={key} style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>{CONTENT_LABELS[key] ?? key}</label>
          <textarea
            value={values[key] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            rows={2}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box', fontSize: 13 }}
          />
        </div>
      ))}

      <button
        onClick={handleSaveContent}
        disabled={saveStatus === 'saving'}
        style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#2C2C2A', color: '#fff', cursor: 'pointer' }}
      >
        {saveStatus === 'saving' ? '儲存中…' : '儲存文字內容'}
      </button>
      {saveStatus === 'saved' && <p style={{ fontSize: 12, color: '#3B6D11', marginTop: 8 }}>已儲存</p>}
      {saveStatus === 'error' && (
        <p style={{ fontSize: 12, color: '#A32D2D', marginTop: 8 }}>
          儲存失敗，請確認資料庫已執行 sql/39site_content_settings_assets.sql
        </p>
      )}
    </main>
  );
}
