'use client';

import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { ClockEmployee, ClockShift, shiftLabel } from '@/lib/staffClock';
import { btn, btnPrimary, input, td, th } from './ClockParts';

type Teacher = { id: string; name: string };
type Props = { employees: ClockEmployee[]; teachers: Teacher[]; shifts: ClockShift[]; onChanged: () => void };

type Draft = Pick<ClockEmployee, 'display_name' | 'teacher_id' | 'shift_ids' | 'active' | 'note'>;

// 人員對照：打卡機只認「機號＋拼音名字」，這裡把每個機號對應到學校系統的教師帳號（才能「自己查自己」），
// 並指定班別（才能判斷遲到／早退／缺勤）。匯入時沒看過的機號會自動出現在這裡，teacher 先留空。
export default function ClockMappingTab({ employees, teachers, shifts, onChanged }: Props) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [filter, setFilter] = useState('');
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [busy, setBusy] = useState<number | 'bulk' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const activeShifts = shifts.filter((s) => s.active);
  const draftOf = (e: ClockEmployee): Draft =>
    drafts[e.device_code] ?? { display_name: e.display_name, teacher_id: e.teacher_id, shift_ids: e.shift_ids, active: e.active, note: e.note };
  const isDirty = (e: ClockEmployee) => {
    const d = drafts[e.device_code];
    return !!d && JSON.stringify(d) !== JSON.stringify({ display_name: e.display_name, teacher_id: e.teacher_id, shift_ids: e.shift_ids, active: e.active, note: e.note });
  };
  function patch(e: ClockEmployee, p: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [e.device_code]: { ...draftOf(e), ...p } }));
  }

  const teacherUse = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      const t = (drafts[e.device_code]?.teacher_id ?? e.teacher_id) || null;
      if (t) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [employees, drafts]);

  const list = employees.filter((e) => {
    if (onlyUnmapped && (drafts[e.device_code]?.teacher_id ?? e.teacher_id)) return false;
    if (!filter.trim()) return true;
    const f = filter.trim().toLowerCase();
    const tName = teachers.find((t) => t.id === e.teacher_id)?.name ?? '';
    return String(e.device_code).includes(f) || e.device_name.toLowerCase().includes(f) || (e.display_name ?? '').toLowerCase().includes(f) || tName.toLowerCase().includes(f);
  });

  async function save(e: ClockEmployee) {
    setBusy(e.device_code);
    setMessage(null);
    const d = draftOf(e);
    const { error } = await supabase
      .from('clock_employee_map')
      .update({ display_name: d.display_name?.trim() || null, teacher_id: d.teacher_id || null, shift_ids: d.shift_ids, active: d.active, note: d.note?.trim() || null })
      .eq('device_code', e.device_code);
    setBusy(null);
    if (error) {
      setMessage(`機號 ${e.device_code} 儲存失敗：${error.message}`);
      return;
    }
    setDrafts((prev) => {
      const n = { ...prev };
      delete n[e.device_code];
      return n;
    });
    onChanged();
  }

  // 一鍵：把「所有啟用中的班別」套給目前在職、還沒設班別的人（平日晚班＋週六早班這種最常見的情況）
  async function applyDefaultShifts() {
    const targets = employees.filter((e) => e.active && e.shift_ids.length === 0);
    if (targets.length === 0) {
      setMessage('沒有「在職且尚未設定班別」的人員。');
      return;
    }
    setBusy('bulk');
    setMessage(null);
    const ids = activeShifts.map((s) => s.id);
    const { error } = await supabase.from('clock_employee_map').update({ shift_ids: ids }).in('device_code', targets.map((t) => t.device_code));
    setBusy(null);
    if (error) {
      setMessage('套用失敗：' + error.message);
      return;
    }
    setMessage(`已把「${activeShifts.map((s) => s.name).join('、')}」套用給 ${targets.length} 位尚未設定班別的人員。`);
    onChanged();
  }

  const unmapped = employees.filter((e) => e.active && !e.teacher_id).length;
  const noShift = employees.filter((e) => e.active && e.shift_ids.length === 0).length;

  return (
    <div>
      <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
        共 {employees.length} 個打卡機號；<b style={{ color: unmapped ? '#b26a00' : undefined }}>{unmapped}</b> 個在職機號尚未對應教師帳號（對應後這個人才查得到自己的打卡）、
        <b style={{ color: noShift ? '#b26a00' : undefined }}>{noShift}</b> 個尚未設定班別（沒設班別就不會判斷遲到／缺勤）。
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <input placeholder="搜尋機號／名字" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...input, width: 180 }} />
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} /> 只看未對應帳號
        </label>
        <button style={btn} disabled={busy === 'bulk' || activeShifts.length === 0} onClick={applyDefaultShifts}>
          一鍵套用班別給「尚未設定班別」的在職人員
        </button>
      </div>
      {message && <p style={{ fontSize: 13, color: message.includes('失敗') ? '#c00' : '#2e7d32' }}>{message}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>機號</th>
              <th style={th}>打卡機上的名字</th>
              <th style={th}>對應教師帳號</th>
              <th style={th}>顯示名稱（選填）</th>
              <th style={th}>班別</th>
              <th style={th}>在職</th>
              <th style={th}>備註</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => {
              const d = draftOf(e);
              const dup = d.teacher_id ? (teacherUse.get(d.teacher_id) ?? 0) > 1 : false;
              return (
                <tr key={e.device_code} style={{ background: isDirty(e) ? '#fffdf0' : undefined }}>
                  <td style={td}>{e.device_code}</td>
                  <td style={td}>{e.device_name}</td>
                  <td style={td}>
                    <select value={d.teacher_id ?? ''} onChange={(ev) => patch(e, { teacher_id: ev.target.value || null })} style={{ ...input, maxWidth: 170 }}>
                      <option value="">（未對應）</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {dup && <div style={{ fontSize: 11, color: '#b26a00' }}>同一位教師對應到多個機號</div>}
                  </td>
                  <td style={td}>
                    <input value={d.display_name ?? ''} onChange={(ev) => patch(e, { display_name: ev.target.value })} style={{ ...input, width: 110 }} />
                  </td>
                  <td style={td}>
                    {activeShifts.map((s) => (
                      <label key={s.id} style={{ display: 'block', whiteSpace: 'nowrap', fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={d.shift_ids.includes(s.id)}
                          onChange={(ev) => patch(e, { shift_ids: ev.target.checked ? [...d.shift_ids, s.id] : d.shift_ids.filter((x) => x !== s.id) })}
                        />{' '}
                        {shiftLabel(s)}
                      </label>
                    ))}
                  </td>
                  <td style={td}>
                    <input type="checkbox" checked={d.active} onChange={(ev) => patch(e, { active: ev.target.checked })} />
                  </td>
                  <td style={td}>
                    <input value={d.note ?? ''} onChange={(ev) => patch(e, { note: ev.target.value })} style={{ ...input, width: 120 }} />
                  </td>
                  <td style={td}>
                    <button style={isDirty(e) ? btnPrimary : btn} disabled={!isDirty(e) || busy === e.device_code} onClick={() => save(e)}>
                      儲存
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td style={{ ...td, color: '#999' }} colSpan={8}>
                  沒有資料。匯入打卡機 CSV 後，機號會自動出現在這裡。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
