'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { decodeClockCsvBytes } from '@/lib/staffClock';
import { loadLastDataAt } from '@/lib/staffClockData';
import { btnPrimary, td, th } from './ClockParts';

type LogRow = {
  id: string;
  created_at: string;
  source: string;
  file_name: string | null;
  rows_received: number;
  rows_inserted: number;
  rows_duplicate: number;
  rows_invalid: number;
  new_codes: number[];
  last_punch: string | null;
  error: string | null;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Bangkok', hour12: false }) : '—');
const SOURCE_LABEL: Record<string, string> = { sync: '本機自動同步', upload: '手動上傳' };

// 匯入與同步：
// - 日常：學校電腦上的同步程式（tools/clock-sync）每天自動把打卡機 CSV 的新資料送進來，這裡可以看到每次結果。
// - 備援：自動同步壞掉、或第一次建置時，可以直接在這裡上傳整份 CSV（重複的打卡會自動略過，不會重複計算）。
export default function ClockImportTab({ onImported }: { onImported: () => void }) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [{ data }, last] = await Promise.all([
      supabase.from('clock_import_log').select('*').order('created_at', { ascending: false }).limit(30),
      loadLastDataAt(),
    ]);
    setLogs((data ?? []) as LogRow[]);
    setLastAt(last);
  }
  useEffect(() => {
    reload();
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const text = decodeClockCsvBytes(new Uint8Array(await file.arrayBuffer()));
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('登入已過期，請重新登入');
      const res = await fetch(`/api/clock/import?file=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv; charset=utf-8' },
        body: text,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `上傳失敗（HTTP ${res.status}）`);
      setResult(
        `讀到 ${json.received} 筆打卡：新增 ${json.inserted} 筆、重複略過 ${json.duplicates} 筆、格式不符 ${json.invalid} 筆` +
          (json.newCodes?.length ? `；發現新機號 ${json.newCodes.join('、')}，請到「人員對照」設定。` : '。')
      );
      await reload();
      onImported();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const stale = lastAt ? Date.now() - new Date(lastAt).getTime() > 3 * 86400000 : true;

  return (
    <div>
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 12, marginBottom: 16, background: stale ? '#fffbf0' : '#f7fbf7' }}>
        <div style={{ fontSize: 13 }}>
          資料庫中最新一筆打卡：<b>{fmt(lastAt)}</b>（泰國時間）
        </div>
        {stale && <div style={{ fontSize: 12, color: '#b26a00', marginTop: 4 }}>已超過 3 天沒有新資料。請確認學校電腦的自動同步（排程工作）是否正常執行，或在下方手動上傳。</div>}
      </div>

      <div style={{ marginBottom: 20 }}>
        <b style={{ fontSize: 14 }}>手動上傳打卡機 CSV</b>
        <p style={{ fontSize: 12, color: '#777', margin: '4px 0 8px' }}>
          直接選打卡機匯出的檔案即可（泰文編碼會自動辨識；整份歷史資料也可以，重複的打卡會自動略過）。
        </p>
        <label style={{ ...btnPrimary, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
          {busy ? '上傳中…' : '選擇 CSV 檔案上傳'}
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload(f);
            }}
          />
        </label>
        {result && <p style={{ fontSize: 13, color: '#2e7d32' }}>{result}</p>}
        {error && <p style={{ fontSize: 13, color: '#c00' }}>{error}</p>}
      </div>

      <b style={{ fontSize: 14 }}>最近 30 次匯入紀錄</b>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, marginTop: 6 }}>
          <thead>
            <tr>
              {['時間（泰國）', '來源', '檔名', '讀到', '新增', '重複', '不符', '新機號', '資料最新到', '結果'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td style={td}>{fmt(l.created_at)}</td>
                <td style={td}>{SOURCE_LABEL[l.source] ?? l.source}</td>
                <td style={{ ...td, color: '#666' }}>{l.file_name ?? ''}</td>
                <td style={td}>{l.rows_received}</td>
                <td style={td}>{l.rows_inserted}</td>
                <td style={td}>{l.rows_duplicate}</td>
                <td style={td}>{l.rows_invalid}</td>
                <td style={td}>{l.new_codes?.join('、')}</td>
                <td style={td}>{fmt(l.last_punch)}</td>
                <td style={{ ...td, color: l.error ? '#c00' : '#2e7d32' }}>{l.error ?? '成功'}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td style={{ ...td, color: '#999' }} colSpan={10}>
                  還沒有匯入紀錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 20, fontSize: 13, color: '#444' }}>
        <summary style={{ cursor: 'pointer' }}>如何設定「每天自動從電腦讀取」？</summary>
        <ol style={{ lineHeight: 1.8 }}>
          <li>在 Vercel 專案的環境變數新增 <code>CLOCK_SYNC_TOKEN</code>（自己編一串 30 字以上的亂碼），重新部署。</li>
          <li>把專案裡的 <code>tools/clock-sync</code> 資料夾複製到放打卡機匯出檔的那台 Windows 電腦（需安裝 Node.js 18 以上）。</li>
          <li>複製 <code>config.example.json</code> 為 <code>config.json</code>，填入網站網址、同樣的 token、CSV 檔案（或所在資料夾）路徑。</li>
          <li>雙擊 <code>run-sync.bat</code> 測試一次；成功後雙擊 <code>install-windows-task.bat</code> 建立每天自動執行的排程。</li>
        </ol>
        <p>詳細步驟見 <code>tools/clock-sync/README.md</code>。</p>
      </details>
    </div>
  );
}
