'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';

// 學年學期中央管理主檔：目前系統其他表格（classes / class_schedule /
// submission_windows...）各自存一份 academic_year/term，沒有單一事實來源。
// 這頁讓開發人員（依 01_department_rbac_refactor.sql 對照表，academic_terms
// 歸屬「開發人員 dev」部門）維護「有哪些學年學期」與「目前生效的是哪一個」，
// 之後其他模組的學年學期下拉選單可以改成從 academic_terms 讀，不用各自寫死。
//
// ⚠️ 需先執行 handover/sql/05_academic_terms_and_substitute_teaching.sql，
// 資料表 academic_terms 才會存在。

type TermRow = {
  id: string;
  academic_year: number;
  term: '上學期' | '下學期';
  term_start_date: string | null;
  term_end_date: string | null;
  is_current: boolean;
  status: '規劃中' | '進行中' | '已結束';
};

const STATUS_LABEL: Record<TermRow['status'], string> = {
  規劃中: '規劃中',
  進行中: '進行中',
  已結束: '已結束',
};

export default function AcademicTermsPage() {
  const [isDev, setIsDev] = useState<boolean | null>(null);
  const [rows, setRows] = useState<TermRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newYear, setNewYear] = useState<number>(new Date().getFullYear());
  const [newTerm, setNewTerm] = useState<'上學期' | '下學期'>('上學期');
  const [busy, setBusy] = useState(false);

  async function load() {
    const appUser = await getCurrentAppUser();
    // 過渡期：舊角色 admin_a/system_admin_s 也先放行，避免部門名單還沒整理完成前這頁被鎖死。
    // app_user_departments 是否有 'dev' 這筆，交給 RLS 政策本身判斷即可，這裡前端只做粗略判斷
    // 決定要不要顯示「僅限開發人員」的提示，真正的權限控管在資料庫 RLS。
    const legacyAdmin = !!appUser && ['system_admin_s', 'admin_a'].includes(appUser.role);
    setIsDev(legacyAdmin || true); // 交由 RLS 實際擋下無權限的寫入；讀取本來就對所有校務人員開放

    const { data, error } = await supabase
      .from('academic_terms')
      .select('id, academic_year, term, term_start_date, term_end_date, is_current, status')
      .order('academic_year', { ascending: false })
      .order('term', { ascending: true });
    if (error) {
      setLoadError('讀取失敗：' + error.message + '（請確認 05_academic_terms_and_substitute_teaching.sql 是否已執行）');
      return;
    }
    setRows((data as TermRow[]) ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd() {
    setBusy(true);
    const { error } = await supabase.from('academic_terms').insert({ academic_year: newYear, term: newTerm });
    setBusy(false);
    if (error) {
      alert('新增失敗：' + error.message);
      return;
    }
    await load();
  }

  async function handleSetCurrent(row: TermRow) {
    setBusy(true);
    const { error } = await supabase.rpc('set_current_academic_term', {
      p_academic_year: row.academic_year,
      p_term: row.term,
    });
    setBusy(false);
    if (error) {
      alert('切換失敗：' + error.message);
      return;
    }
    await load();
  }

  async function handleUpdateDates(row: TermRow, field: 'term_start_date' | 'term_end_date', value: string) {
    const { error } = await supabase.from('academic_terms').update({ [field]: value || null }).eq('id', row.id);
    if (error) {
      alert('更新失敗：' + error.message);
      return;
    }
    await load();
  }

  async function handleUpdateStatus(row: TermRow, status: TermRow['status']) {
    const { error } = await supabase.from('academic_terms').update({ status }).eq('id', row.id);
    if (error) {
      alert('更新失敗：' + error.message);
      return;
    }
    await load();
  }

  return (
    <main style={{ maxWidth: 780, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學年學期中央管理主檔</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        管理系統內有哪些學年學期，以及「目前生效」的是哪一個。這是開發人員部門權限（依部門切割規則，
        只有開發人員或系統管理員可以新增/切換，一般校務人員只能讀取）。
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <input
          type="number"
          value={newYear}
          onChange={(e) => setNewYear(Number(e.target.value))}
          style={{ padding: 8, width: 100 }}
          placeholder="學年度"
        />
        <select value={newTerm} onChange={(e) => setNewTerm(e.target.value as '上學期' | '下學期')} style={{ padding: 8 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <button onClick={handleAdd} disabled={busy} style={{ padding: '8px 16px', fontSize: 13 }}>
          新增
        </button>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>學年度</th>
            <th style={{ padding: 8 }}>學期</th>
            <th style={{ padding: 8 }}>開始日期</th>
            <th style={{ padding: 8 }}>結束日期</th>
            <th style={{ padding: 8 }}>狀態</th>
            <th style={{ padding: 8 }}>目前生效</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: 8 }}>{row.academic_year}</td>
              <td style={{ padding: 8 }}>{row.term}</td>
              <td style={{ padding: 8 }}>
                <input
                  type="date"
                  defaultValue={row.term_start_date ?? ''}
                  onBlur={(e) => handleUpdateDates(row, 'term_start_date', e.target.value)}
                  style={{ padding: 4 }}
                />
              </td>
              <td style={{ padding: 8 }}>
                <input
                  type="date"
                  defaultValue={row.term_end_date ?? ''}
                  onBlur={(e) => handleUpdateDates(row, 'term_end_date', e.target.value)}
                  style={{ padding: 4 }}
                />
              </td>
              <td style={{ padding: 8 }}>
                <select value={row.status} onChange={(e) => handleUpdateStatus(row, e.target.value as TermRow['status'])} style={{ padding: 4 }}>
                  {Object.entries(STATUS_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ padding: 8 }}>
                {row.is_current ? (
                  <span style={{ color: '#2C6B2C', fontWeight: 600 }}>● 目前生效</span>
                ) : (
                  <button onClick={() => handleSetCurrent(row)} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>
                    設為目前生效
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 16, color: '#999', textAlign: 'center' }}>
                尚無資料，請先新增一筆學年學期。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
