'use client';

import { Fragment, useEffect, useState } from 'react';
import type * as XLSXNS from 'xlsx';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import {
  LetterCategory,
  ServiceCertRow,
  MergedAppointmentRow,
  downloadServiceCertTemplate,
  downloadAppointmentLetterTemplate,
  uploadServiceCertSheet,
  uploadAppointmentLetterSheet,
  fetchCurrentServiceCertSheet,
  fetchCurrentAppointmentLetterSheet,
  listServiceCertRows,
  listMergedAppointmentRows,
  saveServiceCertRow,
  saveMergedAppointmentRow,
  deleteServiceCertRow,
  deleteAppointmentLetterRow,
  computeServiceDuration,
  defaultTermDatesForCategory,
} from '@/lib/teacherLetters';
import { getTeacherLetterSettings, saveTeacherLetterSettings, TeacherLetterSettings } from '@/lib/teacherLetterSettings';
import { buildCertificateContent, buildAppointmentContent } from '@/lib/teacherLetterContent';
import { supabase } from '@/lib/supabaseClient';

// 開發人員區「聘書」：把「0808.xlsm」（原本用Excel VBA巨集手動列印）的邏輯搬到網頁上，
// 「歷年教師資料」「自聘教師資料」「當年教師資料」3張資料表改成網頁管理，提供「下載範本」
// 「下載目前資料」「批次上傳（同姓名重複上傳＝批次修正既有資料，不會產生重複列）」
// 「逐筆編輯／刪除」，取代原本要開Excel按巨集的流程。
// 「自聘教師資料」「當年教師資料」的姓名/職位/性別直接來自「歷年教師資料」的自聘勾選結果
// （自聘勾了就出現在自聘教師資料、沒勾且沒有離職才出現在當年教師資料），不用另外重複輸入
// 一次姓名資料，只需要各自補聘期/起迄/發聘時間這些聘書專屬欄位（聘期起迄有預設值，見
// lib/teacherLetters.ts 的 defaultTermDatesForCategory）。「歷年教師資料」會自動結算在職
// 總年數/月數/日數（比照原檔R/S/T三欄公式，見 lib/teacherLetters.ts 的 computeServiceDuration）。
// 「在職證明」「自聘教師聘書」「當年聘書」這三份文件合併在下方的「列印」分頁，直接產生
// PDF／Word（不是Excel），文字內容逐條比對「0808.xlsm」的公式搬過來（見
// lib/teacherLetterContent.ts），校名/校長/董事長/電話/地址這些固定資料在「列印」分頁可以
// 直接編輯、存進資料庫（見 lib/teacherLetterSettings.ts），不用再改程式碼。

const CATEGORIES: { key: LetterCategory | '歷年教師資料' | '列印'; label: string }[] = [
  { key: '歷年教師資料', label: '歷年教師資料' },
  { key: '自聘教師聘書', label: '自聘教師資料' },
  { key: '當年教師聘書', label: '當年教師資料' },
  { key: '列印', label: '列印' },
];

async function downloadSheet(sheet: { name: string; aoa: any[][] }) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  XLSX.writeFile(wb, `${sheet.name}.xlsx`);
}

async function readFirstSheetRows(file: File): Promise<any[][]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][];
}

export default function TeacherLettersPanel({ userId }: { userId: string | null }) {
  const [tab, setTab] = useState<LetterCategory | '歷年教師資料' | '列印'>('歷年教師資料');

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTab(c.key)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #2C6E9E',
              background: tab === c.key ? '#2C6E9E' : '#fff',
              color: tab === c.key ? '#fff' : '#2C6E9E',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {tab === '歷年教師資料' ? (
        <ServiceCertSection userId={userId} />
      ) : tab === '列印' ? (
        <PrintSection userId={userId} />
      ) : (
        <AppointmentLetterSection category={tab} userId={userId} />
      )}
    </div>
  );
}

/* ============================================================ */
/* 歷年教師資料（原「在職證明」）                                          */
/* ============================================================ */

const EMPTY_CERT: ServiceCertRow = {
  seq_no: null, self_hired: false, resigned: false, name: '', birth_date: null, nationality: null,
  gender: null, department: null, title: null,
  start_date_1: null, end_date_1: null, start_date_2: null, end_date_2: null, start_date_3: null, end_date_3: null,
  note: null,
};

function ServiceCertSection({ userId }: { userId: string | null }) {
  const [rows, setRows] = useState<ServiceCertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ServiceCertRow | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    setRows(await listServiceCertRows());
    setLoading(false);
  }
  useEffect(() => {
    reload();
  }, []);

  async function handleUploadFile(file: File) {
    const rowsRaw = await readFirstSheetRows(file);
    const result = await uploadServiceCertSheet(rowsRaw, userId);
    reload();
    return result;
  }

  async function handleDownloadCurrent() {
    const sheet = await fetchCurrentServiceCertSheet();
    downloadSheet(sheet);
  }

  async function handleSave(row: ServiceCertRow) {
    if (!row.name.trim()) {
      alert('姓名必填');
      return;
    }
    const { error } = await saveServiceCertRow(row, userId);
    if (error) {
      alert('儲存失敗：' + error);
      return;
    }
    setEditing(null);
    setAdding(false);
    reload();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`確定要刪除「${name}」這筆歷年教師資料嗎？`)) return;
    const { error } = await deleteServiceCertRow(id);
    if (error) alert('刪除失敗：' + error);
    reload();
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        欄位比照原「教師資料+VBA列印」活頁簿的「在職證明」工作表（已改名「歷年教師資料」）：
        任職/離職日期最多3段（供中途離職又回聘的情況使用），下方列表的「在職時間」欄位是自動結算的總年數/月數/日數。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <TemplateDownloadButton label="下載歷年教師資料範本" onClick={downloadServiceCertTemplate} />
        <TemplateDownloadButton label="下載目前資料(現況)" onClick={handleDownloadCurrent} />
      </div>
      <ExcelUploadButton label="批次上傳／修正歷年教師資料（同姓名重複上傳＝更新既有資料，不會產生重複列）" onFile={handleUploadFile} />

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setEditing({ ...EMPTY_CERT });
          }}
          style={{ padding: '6px 14px', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}
        >
          ＋ 新增一筆
        </button>

        {adding && editing && (
          <ServiceCertForm row={editing} onChange={setEditing} onSave={() => handleSave(editing)} onCancel={() => { setAdding(false); setEditing(null); }} />
        )}

        {loading ? (
          <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  {['序號', '自聘', '離職', '姓名', '國籍', '性別', '服務部門', '職稱', '任職期間', '在職時間', ''].map((h) => (
                    <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td style={tdStyle}>{r.seq_no ?? ''}</td>
                      <td style={tdStyle}>{r.self_hired ? 'V' : ''}</td>
                      <td style={tdStyle}>{r.resigned ? 'V' : ''}</td>
                      <td style={tdStyle}>{r.name}</td>
                      <td style={tdStyle}>{r.nationality}</td>
                      <td style={tdStyle}>{r.gender}</td>
                      <td style={tdStyle}>{r.department}</td>
                      <td style={tdStyle}>{r.title}</td>
                      <td style={tdStyle}>
                        {r.start_date_1 ?? ''} ~ {r.end_date_1 ?? '(在職)'}
                        {r.start_date_2 ? `；${r.start_date_2} ~ ${r.end_date_2 ?? '(在職)'}` : ''}
                        {r.start_date_3 ? `；${r.start_date_3} ~ ${r.end_date_3 ?? '(在職)'}` : ''}
                      </td>
                      <td style={tdStyle}>{computeServiceDuration(r, new Date()).label}</td>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          onClick={() => { setAdding(false); setEditing(editing?.id === r.id ? null : { ...r }); }}
                          style={{ fontSize: 12, marginRight: 6, cursor: 'pointer' }}
                        >
                          {editing?.id === r.id ? '取消' : '編輯'}
                        </button>
                        <button type="button" onClick={() => r.id && handleDelete(r.id, r.name)} style={{ fontSize: 12, color: '#A32D2D', cursor: 'pointer' }}>
                          刪除
                        </button>
                      </td>
                    </tr>
                    {!adding && editing?.id === r.id && (
                      <tr>
                        <td colSpan={11}>
                          <ServiceCertForm row={editing} onChange={setEditing} onSave={() => handleSave(editing)} onCancel={() => setEditing(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} style={{ ...tdStyle, color: '#999', textAlign: 'center' }}>目前沒有資料</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const tdStyle: React.CSSProperties = { border: '1px solid #eee', padding: 6 };
const inputStyle: React.CSSProperties = { padding: 4, fontSize: 12, width: '100%', boxSizing: 'border-box' };

function ServiceCertForm({
  row, onChange, onSave, onCancel,
}: {
  row: ServiceCertRow;
  onChange: (r: ServiceCertRow) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ServiceCertRow>) => onChange({ ...row, ...patch });
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 12, background: '#fafafa' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        <label>歷年序號<input style={inputStyle} type="number" value={row.seq_no ?? ''} onChange={(e) => set({ seq_no: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>姓名*<input style={inputStyle} value={row.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>國籍<input style={inputStyle} value={row.nationality ?? ''} onChange={(e) => set({ nationality: e.target.value || null })} /></label>
        <label>性別<input style={inputStyle} value={row.gender ?? ''} onChange={(e) => set({ gender: e.target.value || null })} /></label>
        <label>服務部門<input style={inputStyle} value={row.department ?? ''} onChange={(e) => set({ department: e.target.value || null })} /></label>
        <label>職稱<input style={inputStyle} value={row.title ?? ''} onChange={(e) => set({ title: e.target.value || null })} /></label>
        <label>出生日期<input style={inputStyle} type="date" value={row.birth_date ?? ''} onChange={(e) => set({ birth_date: e.target.value || null })} /></label>
        <label>
          <input type="checkbox" checked={row.self_hired} onChange={(e) => set({ self_hired: e.target.checked })} /> 自聘
        </label>
        <label>
          <input type="checkbox" checked={row.resigned} onChange={(e) => set({ resigned: e.target.checked })} /> 離職
        </label>
        <label>任職日期1<input style={inputStyle} type="date" value={row.start_date_1 ?? ''} onChange={(e) => set({ start_date_1: e.target.value || null })} /></label>
        <label>離職日期1<input style={inputStyle} type="date" value={row.end_date_1 ?? ''} onChange={(e) => set({ end_date_1: e.target.value || null })} /></label>
        <label>任職日期2<input style={inputStyle} type="date" value={row.start_date_2 ?? ''} onChange={(e) => set({ start_date_2: e.target.value || null })} /></label>
        <label>離職日期2<input style={inputStyle} type="date" value={row.end_date_2 ?? ''} onChange={(e) => set({ end_date_2: e.target.value || null })} /></label>
        <label>任職日期3<input style={inputStyle} type="date" value={row.start_date_3 ?? ''} onChange={(e) => set({ start_date_3: e.target.value || null })} /></label>
        <label>離職日期3<input style={inputStyle} type="date" value={row.end_date_3 ?? ''} onChange={(e) => set({ end_date_3: e.target.value || null })} /></label>
        <label style={{ gridColumn: '1 / -1' }}>備註<input style={inputStyle} value={row.note ?? ''} onChange={(e) => set({ note: e.target.value || null })} /></label>
      </div>
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={onSave} style={{ padding: '5px 14px', fontSize: 12, marginRight: 8, cursor: 'pointer' }}>儲存</button>
        <button type="button" onClick={onCancel} style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer' }}>取消</button>
      </div>
    </div>
  );
}

/* ============================================================ */
/* 自聘教師聘書 ／ 當年教師聘書                                        */
/* ============================================================ */

// 聘期預設值套用邏輯（自聘＝下一年1/1~12/31；當年＝今年5/1~明年4/30）已經統一放在
// lib/teacherLetters.ts 的 defaultTermDatesForCategory()（批次上傳沒填起迄時也是用同一套），
// 這裡只負責「使用者點開編輯、尚未填過聘期資料時」把預設值先帶進表單，不會覆蓋已填的資料。
function applyDefaultTermDates(row: MergedAppointmentRow): MergedAppointmentRow {
  if (row.start_date || row.end_date) return { ...row };
  return { ...row, ...defaultTermDatesForCategory(row.category) };
}

function AppointmentLetterSection({ category, userId }: { category: LetterCategory; userId: string | null }) {
  const [rows, setRows] = useState<MergedAppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<MergedAppointmentRow | null>(null);
  const eligibleLabel = category === '自聘教師聘書' ? '自聘' : '未離職（當年，含自聘）';

  async function reload() {
    setLoading(true);
    setRows(await listMergedAppointmentRows(category));
    setLoading(false);
  }
  useEffect(() => {
    reload();
    setEditingName(null);
    setEditingRow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function handleUploadFile(file: File) {
    const rowsRaw = await readFirstSheetRows(file);
    const result = await uploadAppointmentLetterSheet(rowsRaw, category, userId);
    reload();
    return result;
  }

  async function handleDownloadCurrent() {
    const sheet = await fetchCurrentAppointmentLetterSheet(category);
    downloadSheet(sheet);
  }

  async function handleSave(row: MergedAppointmentRow) {
    const { error } = await saveMergedAppointmentRow(row, userId);
    if (error) {
      alert('儲存失敗：' + error);
      return;
    }
    setEditingName(null);
    setEditingRow(null);
    reload();
  }

  async function handleDeleteLetterData(row: MergedAppointmentRow) {
    if (!row.letter_id) return;
    if (!confirm(`確定要清除「${row.name}」的聘期/起迄資料嗎？（不會刪除「歷年教師資料」裡的教師本身，這位教師還是會留在這份清單裡，只是聘書欄位變空白）`)) return;
    const { error } = await deleteAppointmentLetterRow(row.letter_id);
    if (error) alert('清除失敗：' + error);
    reload();
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        這份名單直接來自「歷年教師資料」勾選「自聘」的結果（{category === '自聘教師聘書' ? '有勾選自聘' : '沒有勾選自聘'}的教師才會出現在這裡），姓名/職位/性別/離職狀態都以「歷年教師資料」為準；這裡只需要補聘期/起迄{category === '自聘教師聘書' ? '/發聘時間' : ''}這些聘書專屬欄位，不用重新輸入一次姓名資料。
        如果少了應該出現的人，請先到「歷年教師資料」確認該教師的「自聘」勾選狀態。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <TemplateDownloadButton label={`下載${category === '自聘教師聘書' ? '自聘教師資料' : '當年教師資料'}範本`} onClick={() => downloadAppointmentLetterTemplate(category)} />
        <TemplateDownloadButton label="下載目前資料(現況)" onClick={handleDownloadCurrent} />
      </div>
      <ExcelUploadButton label={`批次上傳／修正${category === '自聘教師聘書' ? '自聘教師資料' : '當年教師資料'}（聘期/起迄${category === '自聘教師聘書' ? '/發聘時間' : ''}）`} onFile={handleUploadFile} />

      <div style={{ marginTop: 16 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  {['序號', '姓名', '職位', '性別', '聘期', '起', '迄', ...(category === '自聘教師聘書' ? ['離職', '發聘時間'] : []), ''].map((h) => (
                    <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.cert_id}>
                    <tr>
                      <td style={tdStyle}>{r.seq_no ?? ''}</td>
                      <td style={tdStyle}>{r.name}</td>
                      <td style={tdStyle}>{r.title}</td>
                      <td style={tdStyle}>{r.gender}</td>
                      <td style={tdStyle}>{r.term_no ?? ''}</td>
                      <td style={tdStyle}>{r.start_date}</td>
                      <td style={tdStyle}>{r.end_date}</td>
                      {category === '自聘教師聘書' && <td style={tdStyle}>{r.resigned ? 'V' : ''}</td>}
                      {category === '自聘教師聘書' && <td style={tdStyle}>{r.issued_date}</td>}
                      <td style={tdStyle}>
                        <button
                          type="button"
                          onClick={() => {
                            if (editingName === r.name) {
                              setEditingName(null);
                              setEditingRow(null);
                            } else {
                              setEditingName(r.name);
                              setEditingRow(applyDefaultTermDates(r));
                            }
                          }}
                          style={{ fontSize: 12, marginRight: 6, cursor: 'pointer' }}
                        >
                          {editingName === r.name ? '取消' : '編輯聘期'}
                        </button>
                        {r.letter_id && (
                          <button type="button" onClick={() => handleDeleteLetterData(r)} style={{ fontSize: 12, color: '#A32D2D', cursor: 'pointer' }}>
                            清除聘期資料
                          </button>
                        )}
                      </td>
                    </tr>
                    {editingName === r.name && editingRow && (
                      <tr>
                        <td colSpan={category === '自聘教師聘書' ? 10 : 8}>
                          <AppointmentLetterForm
                            row={editingRow}
                            showSelfHiredFields={category === '自聘教師聘書'}
                            onChange={setEditingRow}
                            onSave={() => handleSave(editingRow)}
                            onCancel={() => { setEditingName(null); setEditingRow(null); }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={category === '自聘教師聘書' ? 10 : 8} style={{ ...tdStyle, color: '#999', textAlign: 'center' }}>
                      「歷年教師資料」目前沒有{eligibleLabel}的教師
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PrintSection({ userId }: { userId: string | null }) {
  const [category, setCategory] = useState<LetterCategory | '在職證明'>('在職證明');
  const [certOptions, setCertOptions] = useState<ServiceCertRow[]>([]);
  const [letterOptions, setLetterOptions] = useState<MergedAppointmentRow[]>([]);
  // 選單一律用 cert_id（歷年教師資料每一筆保證唯一的主鍵）當value，不要用姓名或序號
  // ——序號可能是null、也可能重複，用它當value之前發生過選A印出B（或印出空白）的問題。
  const [selectedCertId, setSelectedCertId] = useState('');
  const [generating, setGenerating] = useState<'' | 'pdf' | 'docx'>('');

  const [settings, setSettings] = useState<TeacherLetterSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    getTeacherLetterSettings().then(setSettings);
  }, []);

  useEffect(() => {
    (async () => {
      if (category === '在職證明') {
        const rows = await listServiceCertRows();
        setCertOptions(rows);
        setSelectedCertId(rows[0]?.id ?? '');
      } else {
        const rows = await listMergedAppointmentRows(category);
        setLetterOptions(rows);
        setSelectedCertId(rows[0]?.cert_id ?? '');
      }
    })();
  }, [category]);

  async function handleSaveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    const { error } = await saveTeacherLetterSettings(settings, userId);
    setSavingSettings(false);
    if (error) alert('儲存失敗：' + error);
  }

  async function handleGenerate(format: 'pdf' | 'docx') {
    if (!selectedCertId || !settings) {
      alert('請選擇要列印的教師');
      return;
    }
    // 【2026-08-19】PDF 改成呼叫伺服器端 API（見 app/api/reports/teacher-letter/route.tsx
    // 的說明：原本在瀏覽器端直接產生 PDF，中文字型在瀏覽器環境讀不到，是「Unknown font
    // format」的根因）。這裡也順便把「強制下載」改成「開新分頁預覽（可以直接列印）」，
    // 跟成績單的列印功能一致；window.open 一樣要在還沒有任何 await 之前先同步呼叫，
    // 不然會被瀏覽器的彈出視窗封鎖機制擋掉又沒有任何提示（同一個坑，見成績單那邊的
    // 說明）。docx 檔案本來就是「下載」而不是「預覽列印」的性質，維持原本下載的做法。
    const printWindow = format === 'pdf' ? window.open('', '_blank') : null;
    if (format === 'pdf' && !printWindow) {
      alert('瀏覽器擋下了新分頁（彈出視窗封鎖），請到瀏覽器網址列允許本網站開啟彈出視窗後再試一次。');
      return;
    }
    if (printWindow) {
      printWindow.document.write('<p style="font-family:sans-serif;padding:24px">正在產生 PDF，請稍候…</p>');
    }
    setGenerating(format);
    try {
      const calcDate = new Date();
      let fileBase = '';
      let blob: Blob;
      let pdfKind: 'certificate' | 'appointment' | null = null;
      let pdfContent: any = null;

      if (category === '在職證明') {
        const row = certOptions.find((r) => r.id === selectedCertId);
        if (!row) throw new Error('找不到選取的教師，請重新選擇');
        const content = buildCertificateContent(row, settings, calcDate);
        fileBase = `在職證明_${row.name}`;
        if (format === 'pdf') {
          pdfKind = 'certificate';
          pdfContent = content;
        } else {
          const { buildCertificateDocxBlob } = await import('@/lib/TeacherLetterDocx');
          blob = await buildCertificateDocxBlob(content);
        }
      } else {
        const row = letterOptions.find((r) => r.cert_id === selectedCertId);
        if (!row) throw new Error('找不到選取的教師，請重新選擇');
        if (!row.start_date || !row.end_date) {
          throw new Error(`「${row.name}」還沒有聘期起迄，請先到「${category === '自聘教師聘書' ? '自聘教師資料' : '當年教師資料'}」分頁編輯聘期`);
        }
        const content = buildAppointmentContent(row, settings, calcDate);
        fileBase = `${category}_${row.name}`;
        if (format === 'pdf') {
          pdfKind = 'appointment';
          pdfContent = content;
        } else {
          const { buildAppointmentDocxBlob } = await import('@/lib/TeacherLetterDocx');
          blob = await buildAppointmentDocxBlob(content);
        }
      }

      if (format === 'pdf' && pdfKind) {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          printWindow?.close();
          alert('請重新登入');
          return;
        }
        const res = await fetch('/api/reports/teacher-letter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ kind: pdfKind, content: pdfContent, fileBase }),
        });
        if (!res.ok) {
          printWindow?.close();
          const body = await res.json().catch(() => ({}));
          alert(`產生列印檔失敗，狀態碼 ${res.status}${body.error ? '：' + body.error : ''}`);
          return;
        }
        blob = await res.blob();
        if (printWindow) {
          printWindow.location.href = URL.createObjectURL(blob);
        }
        return;
      }

      const url = URL.createObjectURL(blob!);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBase}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      printWindow?.close();
      alert('產生列印檔失敗：' + err.message);
    } finally {
      setGenerating('');
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        文字內容比對「0808.xlsm」的「印在職證明」「印自聘教師聘書」「印當年聘書」逐條實作，直接產生 PDF 或 Word 檔（不是Excel），下載後就是完整格式，不需要再另外開Excel計算公式。
      </p>

      {settings && (
        <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 12, marginBottom: 16, background: '#fafafa' }}>
          <p style={{ fontSize: 13, marginBottom: 8, fontWeight: 600 }}>學校固定資料（校名/校長/董事長/電話/地址，所有人列印都會用這裡的值）</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 8 }}>
            <label>校名<input style={inputStyle} value={settings.school_name_zh} onChange={(e) => setSettings({ ...settings, school_name_zh: e.target.value })} /></label>
            <label>校長姓名<input style={inputStyle} value={settings.principal_name} onChange={(e) => setSettings({ ...settings, principal_name: e.target.value })} /></label>
            <label>董事長姓名<input style={inputStyle} value={settings.chairman_name} onChange={(e) => setSettings({ ...settings, chairman_name: e.target.value })} /></label>
            <label>聯絡電話<input style={inputStyle} value={settings.phone} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} /></label>
            <label style={{ gridColumn: '1 / -1' }}>地址<input style={inputStyle} value={settings.address} onChange={(e) => setSettings({ ...settings, address: e.target.value })} /></label>
          </div>
          <button type="button" onClick={handleSaveSettings} disabled={savingSettings} style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer' }}>
            {savingSettings ? '儲存中…' : '儲存'}
          </button>
          <p style={{ fontSize: 11, color: '#999', marginTop: 6 }}>
            說明：印自聘教師聘書／當年聘書時，如果被印的人剛好就是「校長姓名」本人，落款會自動改成「董事長」簽署（原本活頁簿就是這樣設計的，避免校長替自己簽聘書）。
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['在職證明', '自聘教師聘書', '當年教師聘書'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            style={{
              padding: '5px 12px', borderRadius: 6, border: '1px solid #2C6E9E', fontSize: 12, cursor: 'pointer',
              background: category === c ? '#2C6E9E' : '#fff', color: category === c ? '#fff' : '#2C6E9E',
            }}
          >
            {c}
          </button>
        ))}
      </div>

      {category === '在職證明' ? (
        <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          選擇要列印的教師
          <select value={selectedCertId} onChange={(e) => setSelectedCertId(e.target.value)} style={{ ...inputStyle, width: 260 }}>
            {certOptions.map((r) => (
              <option key={r.id} value={r.id}>{r.name}（{r.title ?? ''}）</option>
            ))}
          </select>
        </label>
      ) : (
        <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          選擇要列印的教師
          <select value={selectedCertId} onChange={(e) => setSelectedCertId(e.target.value)} style={{ ...inputStyle, width: 260 }}>
            {letterOptions.map((r) => (
              <option key={r.cert_id} value={r.cert_id}>{r.seq_no ?? '(尚無序號)'}　{r.name}（{r.title ?? ''}）</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => handleGenerate('pdf')} disabled={generating !== ''} style={{ padding: '7px 16px', fontSize: 13, cursor: 'pointer' }}>
          {generating === 'pdf' ? '產生中…' : '下載 PDF'}
        </button>
        <button type="button" onClick={() => handleGenerate('docx')} disabled={generating !== ''} style={{ padding: '7px 16px', fontSize: 13, cursor: 'pointer' }}>
          {generating === 'docx' ? '產生中…' : '下載 Word'}
        </button>
      </div>
    </div>
  );
}

function AppointmentLetterForm({
  row, showSelfHiredFields, onChange, onSave, onCancel,
}: {
  row: MergedAppointmentRow;
  showSelfHiredFields: boolean;
  onChange: (r: MergedAppointmentRow) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<MergedAppointmentRow>) => onChange({ ...row, ...patch });
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 12, background: '#fafafa' }}>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        {row.name}（{row.title ?? '—'}／{row.gender ?? '—'}{row.resigned ? '／已離職' : ''}）——姓名/職位/性別/離職狀態要修改請到「歷年教師資料」分頁，這裡只能編輯下面的聘書專屬欄位。
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        <label>序號<input style={inputStyle} type="number" value={row.seq_no ?? ''} onChange={(e) => set({ seq_no: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>聘期<input style={inputStyle} type="number" value={row.term_no ?? ''} onChange={(e) => set({ term_no: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>起<input style={inputStyle} type="date" value={row.start_date ?? ''} onChange={(e) => set({ start_date: e.target.value || null })} /></label>
        <label>迄<input style={inputStyle} type="date" value={row.end_date ?? ''} onChange={(e) => set({ end_date: e.target.value || null })} /></label>
        {showSelfHiredFields && (
          <label>發聘時間<input style={inputStyle} type="date" value={row.issued_date ?? ''} onChange={(e) => set({ issued_date: e.target.value || null })} /></label>
        )}
        <label style={{ gridColumn: '1 / -1' }}>備註<input style={inputStyle} value={row.note ?? ''} onChange={(e) => set({ note: e.target.value || null })} /></label>
      </div>
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={onSave} style={{ padding: '5px 14px', fontSize: 12, marginRight: 8, cursor: 'pointer' }}>儲存</button>
        <button type="button" onClick={onCancel} style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer' }}>取消</button>
      </div>
    </div>
  );
}
