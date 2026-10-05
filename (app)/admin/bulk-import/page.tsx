'use client';

import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  downloadAllSetupTemplate,
  GRADING_RULES_SHEET_NAME,
  STUDENTS_IMPORT_SHEET_NAME,
} from '@/lib/excelTemplates';
import { uploadGradingRulesSheet, uploadStudentsImportSheet } from '@/lib/bulkHandlers';

type SheetResult = { sheet: string; successCount: number; errors: string[] };
const WIPE_CONFIRM_TEXT = '確定清空';

// 新學期開學設定：一次下載包含「整體佔比與加扣分規則／既有學生快速建檔」兩張工作表的範本，填好後一次上傳。
// 「班級與導師設定」「科目與比重設定（節數部分）」「任課教師設定」「節次設定」已改由
// 【排課系統（自動排課工具）】匯出Excel後在「排課系統」頁自動匯入，這裡不再重複提供。
// 成績、出缺輸入表也不包含在這裡，因為那是每班每學期持續登錄的資料，不是一次性建置。
export default function BulkImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SheetResult[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  const [wipeYear, setWipeYear] = useState(new Date().getFullYear());
  const [wipeTerm, setWipeTerm] = useState<'上學期' | '下學期'>('上學期');
  const [wipeConfirmText, setWipeConfirmText] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState<{ removed: Record<string, number>; errors: string[]; skippedBackup?: boolean } | null>(null);
  // 「略過清空前備份」：預設關閉（維持原本較安全的行為），只有想快速清掉測試資料、
  // 本來就不在乎有沒有備份的情境才勾選——資料量大時，清空前的全校完整備份很容易撞到
  // 伺服器執行時間上限，導致清空整個逾時失敗，勾選這個可以跳過備份、直接刪除，更快也更不容易逾時。
  const [wipeSkipBackup, setWipeSkipBackup] = useState(false);

  async function handleWipe() {
    if (wipeConfirmText !== WIPE_CONFIRM_TEXT) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setWiping(true);
    setWipeResult(null);
    try {
      const res = await fetch('/api/admin/wipe-term-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ academicYear: wipeYear, term: wipeTerm, skipBackup: wipeSkipBackup }),
      });
      const bodyText = await res.text();
      const body = (() => {
        try {
          return JSON.parse(bodyText);
        } catch {
          return {};
        }
      })();
      if (!res.ok) {
        // 平台逾時（例如 Vercel 504）回傳的不是 JSON，body.error 會是 undefined，
        // 這裡改顯示 HTTP 狀態碼＋原始回應內容，才看得出「其實是逾時」而不是單純「未知錯誤」。
        const detail = body.error ?? bodyText.slice(0, 200) ?? '未知錯誤';
        alert(`清空失敗（HTTP ${res.status}）：${detail}`);
        return;
      }
      setWipeResult({ removed: body.removed, errors: body.errors, skippedBackup: body.skippedBackup });
      setWipeConfirmText('');
    } finally {
      setWiping(false);
    }
  }

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResults(null);
    setSkipped([]);

    try {
      const yearInput = prompt('這批資料主要適用哪個學年度？（例如 2026；「整體佔比與加扣分規則」需要用到）');
      const academicYear = Number(yearInput);
      const termInput = prompt('這批資料主要適用哪個學期？請輸入「上學期」或「下學期」（「整體佔比與加扣分規則」需要用到）', '上學期');
      if (!academicYear || (termInput !== '上學期' && termInput !== '下學期')) {
        setResults([{ sheet: '（全部）', successCount: 0, errors: ['學年度或學期未正確輸入，已取消整批上傳'] }]);
        return;
      }

      const buf = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'array' });
      const rowsOf = (name: string) => {
        const sheet = wb.Sheets[name];
        if (!sheet) return null;
        return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][];
      };

      const plan: { name: string; run: (rows: any[][]) => Promise<{ successCount: number; errors: string[] }> }[] = [
        { name: GRADING_RULES_SHEET_NAME, run: (rows) => uploadGradingRulesSheet(rows, academicYear, termInput) },
        { name: STUDENTS_IMPORT_SHEET_NAME, run: (rows) => uploadStudentsImportSheet(rows) },
      ];

      const collected: SheetResult[] = [];
      const notFound: string[] = [];

      for (const step of plan) {
        const rows = rowsOf(step.name);
        if (!rows) {
          notFound.push(step.name);
          continue;
        }
        const r = await step.run(rows);
        collected.push({ sheet: step.name, ...r });
      }

      setResults(collected);
      setSkipped(notFound);
    } catch (err: any) {
      setResults([{ sheet: '（全部）', successCount: 0, errors: [err.message ?? '解析失敗'] }]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>新學期開學設定（整批下載／上傳）</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        每學期開學前要一次設定「整體佔比與加扣分規則」「既有學生建檔」時，
        可以先下載一份合併範本，兩張工作表一次填完，再一次上傳，不用逐頁、逐筆手動輸入。
        <br />
        「班級與導師設定」「科目與比重設定（節數）」「任課教師設定」「節次設定」請改到「排課系統」頁，
        用【排課系統（自動排課工具）】排課完成後匯出Excel自動匯入。
        <br />
        （成績、出缺勤輸入不包含在這份範本裡，那是每班每學期持續登錄的資料，請到「學生成績輸入」「學生出缺席輸入」頁分別下載/上傳。）
      </p>

      <div style={{ marginBottom: 20 }}>
        <button
          type="button"
          onClick={downloadAllSetupTemplate}
          style={{
            padding: '8px 16px',
            background: '#fff',
            color: '#2C6E9E',
            border: '1px solid #2C6E9E',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          ↓ 下載整批設定範本（2張工作表）
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>填好後，選擇檔案一次上傳：</label>
        <input ref={inputRef} type="file" accept=".xlsx" onChange={handleChange} disabled={busy} style={{ fontSize: 13 }} />
      </div>

      {busy && <p style={{ fontSize: 12, color: '#666' }}>處理中，資料量大時可能要等一下…</p>}

      {results && (
        <div style={{ fontSize: 13, marginTop: 12 }}>
          {results.map((r) => (
            <div key={r.sheet} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
              <p style={{ fontWeight: 'bold', marginBottom: 4 }}>{r.sheet}</p>
              <p style={{ color: '#3B6D11' }}>成功匯入 {r.successCount} 筆</p>
              {r.errors.length > 0 && (
                <ul style={{ color: '#A32D2D', paddingLeft: 18, fontSize: 12 }}>
                  {r.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {r.errors.length > 20 && <li>…還有 {r.errors.length - 20} 筆錯誤</li>}
                </ul>
              )}
            </div>
          ))}
          {skipped.length > 0 && (
            <p style={{ fontSize: 12, color: '#999' }}>
              檔案中沒有這些工作表，已略過：{skipped.join('、')}
            </p>
          )}
        </div>
      )}

      <div style={{ marginTop: 40, paddingTop: 20, borderTop: '2px solid #A32D2D' }}>
        <h2 style={{ fontSize: 14, color: '#A32D2D', marginBottom: 4 }}>危險區域：一鍵清空</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          把選定「學年度＋學期」的班級名冊、成績、評語、課表、科目與比重、整體佔比規則、加扣分規則、鎖定期間設定全部刪除，
          只保留在「備份與還原」頁的備份資料裡（執行前會自動先做一次完整備份）。
          <br />
          <b>不會刪除</b>：班級本身（同一學年度橫跨兩學期共用）、學生基本資料、出缺勤紀錄（出缺勤沒有明確的學期邊界，無法安全地只清單一學期，如需清除請個別處理）。
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <input
            type="number"
            value={wipeYear}
            onChange={(e) => setWipeYear(Number(e.target.value))}
            style={{ width: 90, padding: 6 }}
          />
          <select value={wipeTerm} onChange={(e) => setWipeTerm(e.target.value as '上學期' | '下學期')} style={{ padding: 6 }}>
            <option value="上學期">上學期</option>
            <option value="下學期">下學期</option>
          </select>
        </div>

        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, color: '#666', marginBottom: 12 }}>
          <input type="checkbox" checked={wipeSkipBackup} onChange={(e) => setWipeSkipBackup(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            略過清空前備份（加快速度、比較不容易逾時，<b>清空後就無法從備份還原這批資料</b>；
            只建議在清除測試資料、本來就不需要保留備份時勾選，正式資料請保持不勾選）
          </span>
        </label>

        <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
          請輸入「{WIPE_CONFIRM_TEXT}」以啟用下方按鈕：
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input
            value={wipeConfirmText}
            onChange={(e) => setWipeConfirmText(e.target.value)}
            placeholder={WIPE_CONFIRM_TEXT}
            style={{ padding: 6, width: 160 }}
          />
          <button
            onClick={handleWipe}
            disabled={wipeConfirmText !== WIPE_CONFIRM_TEXT || wiping}
            style={{
              padding: '8px 16px',
              background: wipeConfirmText === WIPE_CONFIRM_TEXT ? '#A32D2D' : '#ccc',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {wiping ? '清空中…' : `清空 ${wipeYear} ${wipeTerm}`}
          </button>
        </div>

        {wipeResult && (
          <div style={{ fontSize: 12 }}>
            <p style={{ color: '#3B6D11', marginBottom: 4 }}>已清空：{wipeResult.skippedBackup && '（已略過清空前備份）'}</p>
            <ul style={{ paddingLeft: 18, marginBottom: 8 }}>
              {Object.entries(wipeResult.removed).map(([table, n]) => (
                <li key={table}>
                  {table}：{n} 筆
                </li>
              ))}
            </ul>
            {wipeResult.errors.length > 0 && (
              <ul style={{ color: '#A32D2D', paddingLeft: 18 }}>
                {wipeResult.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
