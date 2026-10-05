'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type BackupRow = {
  id: string;
  created_at: string;
  created_by: string | null;
  kind: '自動' | '手動' | '上傳';
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
  const [backupProgress, setBackupProgress] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [uploadRestoring, setUploadRestoring] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  // 【本輪新增】反映事項「自動備份功能異常」——實際查過 vercel.json／
  // app/api/cron/daily-backup/route.ts，每日自動備份本身的程式邏輯沒有問題，
  // 最常見的原因是 Vercel 專案沒有設定 CRON_SECRET 環境變數，或這個環境變數
  // 是部署「之後」才加上去、還沒有觸發過重新部署，導致 Vercel Cron Jobs
  // 分頁裡根本沒有排上 /api/cron/daily-backup——這兩種情況都不會有任何前端畫面
  // 顯示錯誤，只有「backups 表一直沒有出現『自動』類型的新紀錄」這個徵兆，
  // 過去只能「找一天手動去 Supabase 後台檢查」才會發現，很容易不知不覺中斷。
  // 這裡把這個檢查搬到畫面上自動做：一進頁面就算「最新一筆『自動』備份，距離
  // 現在是不是超過 26 小時」（排程是每天一次，多留 2 小時緩衝），超過就直接
  // 顯示警訊，不用再手動去資料庫查。
  const latestAuto = rows.find((r) => r.kind === '自動');
  const autoBackupStaleHours = latestAuto ? (Date.now() - new Date(latestAuto.created_at).getTime()) / 3600000 : null;
  const autoBackupStale = rows.length > 0 && (!latestAuto || (autoBackupStaleHours !== null && autoBackupStaleHours > 26));

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

  // 【本輪修正，根因已確認】備份改成「分段執行」：這裡反覆呼叫 /api/admin/backup/create，
  // 每次伺服器只做約 20 秒就回傳進度（做到第幾張表），前端接著再呼叫下一段，直到
  // done=true。原本一次請求做完全部，資料量大了以後超過平台單次請求時間上限就會
  // 504（見 lib/backupJob.ts 開頭的說明）。每一段請求都很短，不會再被平台中止；
  // 中途如果網路斷掉，重新按一次「備份」也不用從頭來，伺服器端會記得進度。
  async function callBackupApi(token: string, payload: Record<string, unknown>) {
    const res = await fetch('/api/admin/backup/create', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      throw new Error(body?.error ?? `伺服器沒有回傳正常的內容（HTTP ${res.status}），請稍後再試一次，或聯絡開發人員查看伺服器端的執行紀錄`);
    }
    return body as {
      jobId: string;
      done: boolean;
      tableIdx: number;
      totalTables: number;
      currentTable: string | null;
      rowsInCurrentTable: number;
    };
  }

  async function handleRunBackup() {
    const token = await getToken();
    if (!token) {
      alert('請重新登入');
      return;
    }
    setRunning(true);
    setBackupProgress('準備中…');
    try {
      // 上次中斷的手動備份 jobId 記在瀏覽器裡，再按一次就接續，不用重頭撈
      let resumeJobId: string | null = null;
      try {
        resumeJobId = window.localStorage.getItem('backupJobId');
      } catch {}
      let progress = await callBackupApi(token, { action: 'start', resumeJobId });
      try {
        window.localStorage.setItem('backupJobId', progress.jobId);
      } catch {}
      let failures = 0;
      while (!progress.done) {
        setBackupProgress(
          `備份中… ${progress.tableIdx}/${progress.totalTables} 張資料表` +
            (progress.currentTable ? `（目前：${progress.currentTable}，已讀 ${progress.rowsInCurrentTable.toLocaleString()} 筆）` : '')
        );
        try {
          progress = await callBackupApi(token, { action: 'step', jobId: progress.jobId });
          failures = 0;
        } catch (e: any) {
          // 單一段落偶發失敗（網路抖動）自動重試，進度都存在伺服器端，不會丟失；連續失敗才放棄
          failures++;
          if (failures >= 3) throw e;
        }
      }
      try {
        window.localStorage.removeItem('backupJobId');
      } catch {}
      alert('已完成備份');
      load();
    } catch (e: any) {
      alert('備份失敗：' + (e?.message ?? '未知錯誤') + '\n（進度已保留，再按一次「備份」可以從中斷處接續，不用重頭開始。）');
    } finally {
      setRunning(false);
      setBackupProgress(null);
    }
  }

  // 【本輪修正】反映事項「備份失敗：未知錯誤」順便修正：備份內容現在可能存在
  // Storage 而不是 backups.tables 欄位（資料量大時，見 lib/backupRestore.ts
  // 的說明），原本直接用登入者身分查 tables 欄位的做法讀不到這種備份的內容，
  // 改成透過 /api/admin/backup/download 這支 API（service role）統一處理。
  async function handleDownload(row: BackupRow) {
    const token = await getToken();
    if (!token) {
      alert('請重新登入');
      return;
    }
    const res = await fetch(`/api/admin/backup/download?id=${row.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert('讀取備份內容失敗：' + (body.error ?? '未知錯誤'));
      return;
    }
    const blob = await res.blob();
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

  // 「上傳檔案還原」：給新系統／新的 Supabase 專案沒有任何 backups 紀錄可以選、
  // 但手上還留著先前用「下載」按鈕匯出的備份 JSON 檔時使用。檔案直接上傳到
  // Storage（不經過我們自己的 API），是因為備份檔很容易超過 Vercel 單次請求
  // 4.5MB 的本文大小上限，直接塞進 API 請求會被擋掉；還原 API 再從 Storage
  // 把檔案讀出來處理。
  async function handleUploadRestoreFile(file: File) {
    const confirmText = prompt(
      `即將用檔案「${file.name}」的內容「還原」資料庫。\n這會覆蓋掉目前所有校務資料（學生、班級、成績、出缺勤...等），且無法復原！\n如果這是要搬到全新的 Supabase 專案，部分關聯到帳號本身的欄位（例如各種「建立者」「異動者」）可能因為帳號 id 對不上而還原失敗，屬於已知限制。\n\n如果確定要繼續，請輸入「確定還原」四個字：`
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
    setUploadRestoring(true);
    try {
      const path = `${me?.id ?? 'unknown'}/${Date.now()}-${file.name}`;
      const { error: uploadErr } = await supabase.storage.from('backup-uploads').upload(path, file);
      if (uploadErr) {
        alert('上傳檔案失敗：' + uploadErr.message);
        return;
      }
      const res = await fetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uploadPath: path }),
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
      setUploadRestoring(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
      {autoBackupStale && (
        <p style={{ fontSize: 12, color: '#A32D2D', background: '#FBEFE9', padding: 8, borderRadius: 6, marginBottom: 12 }}>
          ⚠ 每日自動備份可能沒有正常執行：
          {latestAuto
            ? `最新一筆「自動」備份是 ${new Date(latestAuto.created_at).toLocaleString()}（超過 26 小時前）。`
            : '目前完全沒有任何「自動」類型的備份紀錄。'}
          最常見原因是 Vercel 專案沒有設定 <code>CRON_SECRET</code> 環境變數、或設定後還沒重新部署過，
          請到 Vercel 專案設定確認環境變數，並到「Cron Jobs」分頁確認 <code>/api/cron/daily-backup</code> 已排程，
          必要時可先點下面「立即備份」手動備一份。
        </p>
      )}
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        系統每天會自動備份一次校務資料（學生、班級、課表、成績、出缺勤...等），也可以在下面手動立即備份。
        備份不含登入帳號本身（帳號請到「帳號管理」頁處理），避免還原後造成無法登入的問題。
      </p>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
        {isSystemAdminS
          ? '您是系統管理員S，可以執行「還原」。如果這個系統本身還沒有任何備份紀錄（例如剛換到新的 Supabase 專案），可以用「上傳備份檔案還原」載入先前下載的備份 JSON 檔。'
          : '「還原」功能僅系統管理員S本人可以執行；您可以查看與下載備份。'}
      </p>

      <button
        onClick={handleRunBackup}
        disabled={running}
        style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, marginBottom: 20, marginRight: 8 }}
      >
        {running ? (backupProgress ?? '備份中…') : '立即備份'}
      </button>

      {isSystemAdminS && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUploadRestoreFile(file);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadRestoring}
            style={{ padding: '8px 16px', background: '#fff', color: '#A32D2D', border: '1px solid #A32D2D', borderRadius: 6, fontSize: 13, marginBottom: 20 }}
            title="用先前下載的備份 JSON 檔還原，適合新系統／新的 Supabase 專案沒有任何備份紀錄可以選的情況"
          >
            {uploadRestoring ? '還原中…' : '上傳備份檔案還原'}
          </button>
        </>
      )}

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
