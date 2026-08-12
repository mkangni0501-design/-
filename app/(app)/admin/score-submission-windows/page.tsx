'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';

// 成績上傳時間設定表
// ------------------------------------------------------------
// 2026-08-08 新增：修正「班級批次上傳成績,會無法顯示於其他排名頁面」。
// 追查發現 class_rankings / grade_rankings 這兩個排名view，是否顯示期中考/期末考/平時分，
// 要看 submission_windows 這張表對應那一格「是否已鎖定(is_locked)」——但過去整個系統
// 完全沒有畫面可以設定「期中考」「期末考」的鎖定（唯一的鎖定按鈕在「班級成績總表」頁，
// 而且只能鎖自己班的「平時分」），所以老師/管理員批次上傳期中考、期末考成績後，
// 排名頁面永遠看不到資料，就像這裡的資料完全消失了一樣。
//
// 這頁補上完整的設定畫面：可以用「全校」「部別」「班級」三種範圍設定開放/鎖定時間，
// 範圍優先順序是「班級 > 部別 > 全校」——沒有針對某個班級單獨設定時，會往上看部別、
// 再往上看全校的設定（sql/34fix_exam_type_locked_scope.sql 的 exam_type_locked() 函式）。
// 一般情況下，教務處可以直接設定「全校」一次搞定所有班級；如果某班需要個別處理
// （例如緩考、成績有疑義還沒確認），再對那個班單獨設定即可蓋過全校/部別的設定。

type DataType = '期中考' | '期末考' | '平時分' | '出缺勤';
type Scope = '全校' | '部別' | '班級';

type WindowRow = {
  id: string;
  academic_year: number;
  term: '上學期' | '下學期';
  data_type: DataType;
  scope: Scope;
  scope_ref: string | null;
  opens_at: string | null;
  closes_at: string | null;
  is_locked: boolean;
  set_by: string | null;
};

type ClassOption = { id: string; academic_year: number; department: string; grade_level: string; class_name: string };

const DATA_TYPES: DataType[] = ['期中考', '期末考', '平時分', '出缺勤'];

function scopeLabel(row: WindowRow, classMap: Record<string, ClassOption>) {
  if (row.scope === '全校') return '全校';
  if (row.scope === '部別') return row.scope_ref || '(未指定部別)';
  const cls = row.scope_ref ? classMap[row.scope_ref] : null;
  return cls ? `${cls.academic_year}學年度 ${cls.grade_level}${cls.class_name}` : '(找不到班級，可能已被刪除)';
}

function toLocalInputValue(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScoreSubmissionWindowsPage() {
  const perms = useDepartmentPermissions();
  const canManageAcademic = perms.isSystemAdmin || perms.myDepartments.some((d) => d.department === 'academic');
  const canManageDiscipline = perms.isSystemAdmin || perms.myDepartments.some((d) => d.department === 'discipline');

  const [rows, setRows] = useState<WindowRow[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [academicYear, setAcademicYear] = useState(new Date().getFullYear());
  const [term, setTerm] = useState<'上學期' | '下學期'>('上學期');
  const [dataType, setDataType] = useState<DataType>('期中考');
  const [scope, setScope] = useState<Scope>('全校');
  const [scopeRef, setScopeRef] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  const canManageCurrentType = dataType === '出缺勤' ? canManageDiscipline : canManageAcademic;

  const classMap = useMemo(() => {
    const m: Record<string, ClassOption> = {};
    classes.forEach((c) => (m[c.id] = c));
    return m;
  }, [classes]);

  const departments = useMemo(() => Array.from(new Set(classes.map((c) => c.department))).sort(), [classes]);
  const classesInYear = useMemo(() => classes.filter((c) => c.academic_year === academicYear), [classes, academicYear]);

  async function load() {
    setLoading(true);
    const [{ data: winData, error: winErr }, { data: clsData }] = await Promise.all([
      supabase.from('submission_windows').select('*').order('academic_year', { ascending: false }).order('term'),
      supabase.from('classes').select('id, academic_year, department, grade_level, class_name'),
    ]);
    setLoadError(winErr ? '讀取設定失敗：' + winErr.message : null);
    setRows((winData ?? []) as WindowRow[]);
    setClasses((clsData ?? []) as ClassOption[]);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  function resetScopeRef(nextScope: Scope) {
    setScope(nextScope);
    setScopeRef('');
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    if (scope !== '全校' && !scopeRef) {
      alert(scope === '部別' ? '請選擇部別' : '請選擇班級');
      return;
    }
    setSaving(true);
    const payload = {
      academic_year: academicYear,
      term,
      data_type: dataType,
      scope,
      // 全校固定存空字串（不存null）：因為資料庫的唯一限制在 scope_ref 是 null 時
      // 無法正確判斷「這是不是同一筆」，upsert 會失效、變成一直新增重複列。
      scope_ref: scope === '全校' ? '' : scopeRef,
      opens_at: opensAt ? new Date(opensAt).toISOString() : null,
      closes_at: closesAt ? new Date(closesAt).toISOString() : null,
      is_locked: isLocked,
      set_by: perms.userId,
    };
    const { error } = await supabase
      .from('submission_windows')
      .upsert(payload, { onConflict: 'academic_year,term,data_type,scope,scope_ref' });
    setSaving(false);
    if (error) {
      alert('儲存失敗：' + error.message);
      return;
    }
    setOpensAt('');
    setClosesAt('');
    setIsLocked(false);
    load();
  }

  async function handleToggleLock(row: WindowRow) {
    const { error } = await supabase.from('submission_windows').update({ is_locked: !row.is_locked }).eq('id', row.id);
    if (error) {
      alert('更新失敗：' + error.message);
      return;
    }
    load();
  }

  async function handleDelete(row: WindowRow) {
    if (!confirm(`確定要刪除「${row.academic_year}學年度${row.term} ${row.data_type} ${scopeLabel(row, classMap)}」這筆設定嗎？`)) return;
    const { error } = await supabase.from('submission_windows').delete().eq('id', row.id);
    if (error) alert('刪除失敗：' + error.message);
    load();
  }

  return (
    <main style={{ padding: 24, maxWidth: 1000 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>成績上傳時間設定表</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        設定「期中考／期末考／平時分／出缺勤」各自的開放時間、以及是否已鎖定。<br />
        <b>排名頁面（班排名/年級排名/總成績）要等對應的項目被鎖定(is_locked)後才會顯示對應欄位</b>
        ——這是刻意設計，確保老師還在陸續輸入成績的時候，排名不會顯示不完整的資料。
        範圍優先順序是「班級 &gt; 部別 &gt; 全校」：沒有對某班單獨設定時，會採用該班部別或全校的設定；
        一般直接設定「全校」即可，個別班級需要延後鎖定時再對那個班單獨設定。
      </p>

      {loadError && <p style={{ color: '#A32D2D' }}>{loadError}</p>}

      <form onSubmit={handleSave} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 20, background: '#fafafa' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          <label>
            學年度
            <input type="number" value={academicYear} onChange={(e) => setAcademicYear(Number(e.target.value))} style={inputStyle} />
          </label>
          <label>
            學期
            <select value={term} onChange={(e) => setTerm(e.target.value as any)} style={inputStyle}>
              <option value="上學期">上學期</option>
              <option value="下學期">下學期</option>
            </select>
          </label>
          <label>
            類別
            <select value={dataType} onChange={(e) => setDataType(e.target.value as DataType)} style={inputStyle}>
              {DATA_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            範圍
            <select value={scope} onChange={(e) => resetScopeRef(e.target.value as Scope)} style={inputStyle}>
              <option value="全校">全校</option>
              <option value="部別">部別</option>
              <option value="班級">班級</option>
            </select>
          </label>
          {scope === '部別' && (
            <label>
              選擇部別
              <select value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} style={inputStyle}>
                <option value="">請選擇</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          )}
          {scope === '班級' && (
            <label>
              選擇班級
              <select value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} style={inputStyle}>
                <option value="">請選擇</option>
                {classesInYear.map((c) => (
                  <option key={c.id} value={c.id}>{c.grade_level}{c.class_name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            開放起始（可留白）
            <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} style={inputStyle} />
          </label>
          <label>
            開放結束（可留白）
            <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 18 }}>
            <input type="checkbox" checked={isLocked} onChange={(e) => setIsLocked(e.target.checked)} /> 已鎖定（排名頁面才會顯示）
          </label>
        </div>
        <button
          type="submit"
          disabled={saving || !canManageCurrentType}
          style={{ marginTop: 12, padding: '6px 16px', fontSize: 13, cursor: canManageCurrentType ? 'pointer' : 'not-allowed' }}
        >
          {saving ? '儲存中…' : '新增／更新這筆設定'}
        </button>
        {!canManageCurrentType && (
          <p style={{ fontSize: 12, color: '#A32D2D', marginTop: 6 }}>
            {dataType === '出缺勤' ? '出缺勤的設定需要訓導處或系統管理員權限。' : '成績類的設定需要教務處或系統管理員權限。'}
          </p>
        )}
      </form>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              {['學年度', '學期', '類別', '範圍', '開放起始', '開放結束', '狀態', ''].map((h) => (
                <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rowManageable = r.data_type === '出缺勤' ? canManageDiscipline : canManageAcademic;
              return (
                <tr key={r.id}>
                  <td style={tdStyle}>{r.academic_year}</td>
                  <td style={tdStyle}>{r.term}</td>
                  <td style={tdStyle}>{r.data_type}</td>
                  <td style={tdStyle}>{r.scope}／{scopeLabel(r, classMap)}</td>
                  <td style={tdStyle}>{r.opens_at ? toLocalInputValue(r.opens_at).replace('T', ' ') : ''}</td>
                  <td style={tdStyle}>{r.closes_at ? toLocalInputValue(r.closes_at).replace('T', ' ') : ''}</td>
                  <td style={{ ...tdStyle, color: r.is_locked ? '#2C6E9E' : '#999', fontWeight: r.is_locked ? 700 : 400 }}>
                    {r.is_locked ? '已鎖定' : '未鎖定'}
                  </td>
                  <td style={tdStyle}>
                    <button type="button" disabled={!rowManageable} onClick={() => handleToggleLock(r)} style={{ fontSize: 12, marginRight: 8, cursor: rowManageable ? 'pointer' : 'not-allowed' }}>
                      {r.is_locked ? '解鎖' : '鎖定'}
                    </button>
                    <button type="button" disabled={!rowManageable} onClick={() => handleDelete(r)} style={{ fontSize: 12, color: '#A32D2D', cursor: rowManageable ? 'pointer' : 'not-allowed' }}>
                      刪除
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...tdStyle, color: '#999', textAlign: 'center' }}>目前沒有任何設定</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}

const inputStyle: React.CSSProperties = { display: 'block', width: '100%', padding: 5, fontSize: 13, boxSizing: 'border-box', marginTop: 3 };
const tdStyle: React.CSSProperties = { border: '1px solid #eee', padding: 6 };
