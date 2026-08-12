'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type BackupRow = {
  id: string;
  created_at: string;
  created_by: string | null;
  kind: '自動' | '手動';
  table_counts: Record<string, number | null>;
  restored_at: string | null;
  restored_by: string | null;
};

// 備份與還原：本來是獨立的 /admin/backups 頁面，現在收進「開發人員區」裡面，
// 邏輯完全沒有改，只是搬了位置（原本的網址仍然可以用，會自動跳轉過來）。
export default function BackupRestorePanel() {
  const [me, setMe] = useState<{ id: string; name: string; role: string } | null>(null);
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from('backups')
      .select('id, created_at, created_by, kind, table_counts, restored_at, restored_by')
      .order('created_at', { ascending: false })
      .limit(60);
    setLoadError(error ? '讀取備份紀錄失敗：' + error.message : null);
    setRows((data ?? []) as BackupRow[]);
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      setMe(appUser);
    })();
    load();
  }, []);

  async function getToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function handleRunBackup() {
    const token = await getToken();
    if (!token) {
      alert('請重新登入');
      return;
    }
    setRunning(true);
    try {
      const res = await fetch('/api/admin/backup/create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('備份失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      alert('已完成備份');
      load();
    } finally {
      setRunning(false);
    }
  }

  async function handleDownload(row: BackupRow) {
    const { data, error } = await supabase.from('backups').select('tables').eq('id', row.id).single();
    if (error || !data) {
      alert('讀取備份內容失敗：' + (error?.message ?? '未知錯誤'));
      return;
    }
    const blob = new Blob([JSON.stringify(data.tables, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-${row.created_at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleRestore(row: BackupRow) {
    const confirmText = prompt(
      `即將把資料庫「還原」成 ${new Date(row.created_at).toLocaleString()} 這個時間點的狀態。\n這會覆蓋掉這之後所有校務資料（學生、班級、成績、出缺勤...等）的變動，且無法復原！\n\n如果確定要繼續，請輸入「確定還原」四個字：`
    );
    if (confirmText !== '確定還原') {
      if (confirmText !== null) alert('輸入不符，已取消');
      return;
    }
    const token = await getToken();
    if (!token) {
      alert('請重新登入');
      return;
    }
    setRestoringId(row.id);
    try {
      const res = await fetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backupId: row.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('還原失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      if (body.errors?.length > 0) {
        alert('還原完成，但部分資料表有問題：\n' + body.errors.join('\n'));
      } else {
        alert(`還原完成。已還原 ${body.restoredTables.length} 個資料表。`);
      }
      load();
    } finally {
      setRestoringId(null);
    }
  }

  const isSystemAdminS = me?.role === 'system_admin_s';
  const isAdmin = me && ['system_admin_s', 'admin_a', 'admin_b'].includes(me.role);

  if (me && !isAdmin) {
    return <p style={{ fontSize: 13, color: '#999' }}>只有管理員可以查看「備份與還原」。</p>;
  }

  return (
    <div>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        系統每天會自動備份一次校務資料（學生、班級、課表、成績、出缺勤...等），也可以在下面手動立即備份。
        備份不含登入帳號本身（帳號請到「帳號管理」頁處理），避免還原後造成無法登入的問題。
      </p>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
        {isSystemAdminS ? '您是系統管理員S，可以執行「還原」。' : '「還原」功能僅系統管理員S本人可以執行；您可以查看與下載備份。'}
      </p>

      <button
        onClick={handleRunBackup}
        disabled={running}
        style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, marginBottom: 20 }}
      >
        {running ? '備份中…' : '立即備份'}
      </button>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>時間</th>
              <th style={{ textAlign: 'left', padding: 6 }}>類型</th>
              <th style={{ textAlign: 'left', padding: 6 }}>資料筆數摘要</th>
              <th style={{ textAlign: 'left', padding: 6 }}>還原狀態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6, whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={{ padding: 6 }}>{r.kind}</td>
                <td style={{ padding: 6, fontSize: 11, color: '#666', maxWidth: 320 }}>
                  {Object.entries(r.table_counts)
                    .filter(([, c]) => c !== null)
                    .map(([t, c]) => `${t}:${c}`)
                    .join('　')}
                </td>
                <td style={{ padding: 6, fontSize: 11, color: '#999' }}>
                  {r.restored_at ? `曾於 ${new Date(r.restored_at).toLocaleString()} 被用來還原` : '—'}
                </td>
                <td style={{ padding: 6, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => handleDownload(r)} style={{ fontSize: 12, padding: '2px 8px', marginRight: 6 }}>
                    下載
                  </button>
                  {isSystemAdminS && (
                    <button
                      onClick={() => handleRestore(r)}
                      disabled={restoringId === r.id}
                      style={{ fontSize: 12, padding: '2px 8px', color: '#A32D2D' }}
                    >
                      {restoringId === r.id ? '還原中…' : '還原'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  尚無備份紀錄，請先點「立即備份」建立第一筆
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
