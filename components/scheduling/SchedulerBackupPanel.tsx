'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { SchedulerBackupRow, listSchedulerBackups, getSchedulerBackupData, saveSchedulerBackup, downloadSchedulerBackupAsFile } from '@/lib/schedulerBackupClient';

// 查課表／找代課請直接用排課工具內建的「查詢」「代課」分頁（即時資料，跟這裡的歷史存檔是兩件事）。
// 這裡只負責列出之前存過的版本，需要回頭看某次存檔內容、或想拿舊版本重新讀回排課工具繼續編輯時使用。
export default function SchedulerBackupPanel({ academicYear, term }: { academicYear: number; term: '上學期' | '下學期' }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<SchedulerBackupRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function load() {
    const { rows, error } = await listSchedulerBackups(academicYear, term);
    setRows(rows);
    setLoadError(error);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academicYear, term]);

  async function handleUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed?.GRADES || !parsed?.S) {
        setSaveMsg('這個檔案看起來不是排課工具「備份專案」匯出的 JSON 檔案，請確認後再試一次。');
        return;
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setSaveMsg('請重新登入');
        return;
      }
      const note = prompt('這筆存檔要加註什麼備註嗎？（選填，例如「開學初版」「第一次段考後調整」）', '') ?? undefined;
      const result = await saveSchedulerBackup(parsed, academicYear, term, note, accessToken);
      if (!result.success) {
        setSaveMsg('儲存失敗：' + result.error);
      } else {
        setSaveMsg('已存進系統。');
        load();
      }
    } catch (err: any) {
      setSaveMsg('讀取失敗：' + (err.message ?? '請確認這是排課工具「備份專案」匯出的 JSON 檔案'));
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDownload(row: SchedulerBackupRow) {
    const { data, error } = await getSchedulerBackupData(row.id);
    if (error || !data) {
      alert('讀取失敗：' + (error ?? '未知錯誤'));
      return;
    }
    const ts = row.saved_at.slice(0, 16).replace('T', '_').replace(':', '');
    downloadSchedulerBackupAsFile(data, `排課系統存檔_${row.academic_year}_${row.term}_${ts}.json`);
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        排課工具「💾 存檔到校務系統」按下去就會自動存一筆在這裡（不用手動操作）。
        如果手上有舊方式（工具內「備份專案」）下載的JSON檔想補存進來，也可以在這裡手動上傳。
        下載回來的JSON檔可以在排課工具用「上傳專案」讀回去繼續編輯。
      </p>

      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
          手動上傳排課工具「備份專案」下載的 JSON 檔（適用學年度：{academicYear}／{term}）：
        </label>
        <input ref={fileInputRef} type="file" accept=".json" onChange={handleUploadChange} disabled={saving} style={{ fontSize: 13 }} />
      </div>
      {saving && <p style={{ fontSize: 12, color: '#666' }}>儲存中…</p>}
      {saveMsg && <p style={{ fontSize: 12, color: saveMsg.startsWith('已存') ? '#3B6D11' : '#A32D2D', marginBottom: 8 }}>{saveMsg}</p>}

      {loadError && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>讀取存檔清單失敗：{loadError}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>存檔時間</th>
            <th style={{ textAlign: 'left', padding: 6 }}>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6, whiteSpace: 'nowrap' }}>{new Date(r.saved_at).toLocaleString()}</td>
              <td style={{ padding: 6, color: '#666' }}>{r.note || '—'}</td>
              <td style={{ padding: 6, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button onClick={() => handleDownload(r)} style={{ fontSize: 12, padding: '2px 8px' }}>
                  下載JSON
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                這個學年度／學期目前還沒有存檔
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
