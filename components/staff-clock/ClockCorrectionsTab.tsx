'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { ClockEmployee, ClockOverride, ClockRecord, bangkokNow, employeeLabel, monthRange, toBangkok, minToHHMM } from '@/lib/staffClock';
import { loadClockRange } from '@/lib/staffClockData';
import { MonthPicker, btn, btnPrimary, input, td, th } from './ClockParts';

type Props = { employees: ClockEmployee[]; teacherNames: Map<string, string>; userId: string | null };

const OVERRIDE_STATUS: ClockOverride['status'][] = ['請假', '公出', '正常', '休假'];

// 補卡／更正（教務處、系統管理員S/A）：
//  ① 補打卡：忘記打卡、機器故障時，補一筆打卡時間（標記為「補卡」，保留是誰補的、為什麼補）。
//  ② 作廢打卡：誤刷的打卡可以作廢（不是刪除，仍保留紀錄與原因，可還原）。
//  ③ 單日更正：整天標成「請假／公出／視為正常／休假」，覆蓋自動判定。
export default function ClockCorrectionsTab({ employees, teacherNames, userId }: Props) {
  const staff = employees.filter((e) => e.active);
  const [code, setCode] = useState<number | null>(staff[0]?.device_code ?? null);
  const [month, setMonth] = useState(() => bangkokNow().date.slice(0, 7));
  const [records, setRecords] = useState<ClockRecord[]>([]);
  const [overrides, setOverrides] = useState<ClockOverride[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addDate, setAddDate] = useState(() => bangkokNow().date);
  const [addTime, setAddTime] = useState('17:00');
  const [addReason, setAddReason] = useState('');
  const [ovDate, setOvDate] = useState(() => bangkokNow().date);
  const [ovStatus, setOvStatus] = useState<ClockOverride['status']>('請假');
  const [ovNote, setOvNote] = useState('');
  const [voidReason, setVoidReason] = useState<Record<string, string>>({});

  useEffect(() => {
    if (code == null && staff[0]) setCode(staff[0].device_code);
  }, [staff.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reload() {
    if (code == null) return;
    try {
      const { from, to } = monthRange(month);
      const r = await loadClockRange(from, to, [code]);
      setRecords(r.records);
      setOverrides(r.overrides.sort((a, b) => a.punch_date.localeCompare(b.punch_date)));
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  useEffect(() => {
    reload();
  }, [code, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (m: string, e: { message: string }) => setMessage(`${m}：${e.message}`);

  async function addManual() {
    if (code == null) return;
    if (!addReason.trim()) return setMessage('請填寫補卡原因（例如：忘記打卡、機器故障），方便日後查核。');
    setBusy(true);
    const emp = employees.find((e) => e.device_code === code)!;
    const { error } = await supabase.from('clock_records').insert({
      device_code: code,
      device_name: emp.device_name,
      punched_at: `${addDate}T${addTime}:00+07:00`,
      punch_date: addDate,
      method: 'MANUAL',
      source: 'manual',
      machine_no: 0,
      note: addReason.trim(),
      created_by: userId,
    });
    setBusy(false);
    if (error) return fail(error.code === '23505' ? '這個時間已經有一筆補卡' : '補卡失敗', error);
    setMessage(`已補上 ${addDate} ${addTime} 的打卡`);
    setAddReason('');
    reload();
  }

  async function setVoided(r: ClockRecord, voided: boolean) {
    const reason = (voidReason[r.id] ?? '').trim();
    if (voided && !reason) return setMessage('作廢打卡請先填寫原因。');
    setBusy(true);
    const { error } = await supabase
      .from('clock_records')
      .update(voided ? { voided: true, voided_reason: reason, voided_by: userId, voided_at: new Date().toISOString() } : { voided: false, voided_reason: null, voided_by: null, voided_at: null })
      .eq('id', r.id);
    setBusy(false);
    if (error) return fail('操作失敗', error);
    reload();
  }

  async function saveOverride() {
    if (code == null) return;
    setBusy(true);
    const { error } = await supabase
      .from('clock_day_overrides')
      .upsert({ device_code: code, punch_date: ovDate, status: ovStatus, note: ovNote.trim() || null, created_by: userId }, { onConflict: 'device_code,punch_date' });
    setBusy(false);
    if (error) return fail('儲存失敗', error);
    setMessage(`已把 ${ovDate} 標成「${ovStatus}」`);
    setOvNote('');
    reload();
  }

  async function removeOverride(o: ClockOverride) {
    const { error } = await supabase.from('clock_day_overrides').delete().eq('id', o.id);
    if (error) return fail('刪除失敗', error);
    reload();
  }

  const timeOf = (iso: string) => minToHHMM(toBangkok(iso).minutes);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          人員：
          <select value={code ?? ''} onChange={(e) => setCode(Number(e.target.value))} style={input}>
            {staff.map((e) => (
              <option key={e.device_code} value={e.device_code}>
                {employeeLabel(e, e.teacher_id ? teacherNames.get(e.teacher_id) : null)}（機號 {e.device_code}）
              </option>
            ))}
          </select>
        </label>
        <MonthPicker value={month} onChange={setMonth} />
      </div>
      {message && <p style={{ fontSize: 13, color: /失敗|請|已經/.test(message) ? '#c00' : '#2e7d32' }}>{message}</p>}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', margin: '12px 0 20px' }}>
        <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 12 }}>
          <b style={{ fontSize: 14 }}>① 補打卡</b>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            <input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} style={input} />
            <input type="time" value={addTime} onChange={(e) => setAddTime(e.target.value)} style={input} />
          </div>
          <input placeholder="補卡原因（必填）" value={addReason} onChange={(e) => setAddReason(e.target.value)} style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
          <button style={{ ...btnPrimary, marginTop: 8 }} disabled={busy || code == null} onClick={addManual}>
            補上這筆打卡
          </button>
        </div>
        <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 12 }}>
          <b style={{ fontSize: 14 }}>③ 單日更正（請假／公出／視為正常／休假）</b>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
            <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} style={input} />
            <select value={ovStatus} onChange={(e) => setOvStatus(e.target.value as ClockOverride['status'])} style={input}>
              {OVERRIDE_STATUS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <input placeholder="備註（選填，例如：病假、外出開會）" value={ovNote} onChange={(e) => setOvNote(e.target.value)} style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
          <button style={{ ...btnPrimary, marginTop: 8 }} disabled={busy || code == null} onClick={saveOverride}>
            儲存單日更正
          </button>
        </div>
      </div>

      <b style={{ fontSize: 14 }}>已設定的單日更正（{month}）</b>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, margin: '6px 0 20px' }}>
        <tbody>
          {overrides.map((o) => (
            <tr key={o.id}>
              <td style={td}>{o.punch_date}</td>
              <td style={td}>{o.status}</td>
              <td style={{ ...td, color: '#666' }}>{o.note}</td>
              <td style={td}>
                <button style={btn} onClick={() => removeOverride(o)}>
                  移除
                </button>
              </td>
            </tr>
          ))}
          {overrides.length === 0 && (
            <tr>
              <td style={{ ...td, color: '#999' }}>這個月沒有單日更正</td>
            </tr>
          )}
        </tbody>
      </table>

      <b style={{ fontSize: 14 }}>② 這個月的所有打卡（可作廢誤刷的打卡）</b>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, marginTop: 6 }}>
          <thead>
            <tr>
              {['日期', '時間', '來源', '備註／作廢原因', '操作'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} style={{ opacity: r.voided ? 0.5 : 1, textDecoration: r.voided ? 'line-through' : undefined }}>
                <td style={td}>{r.punch_date}</td>
                <td style={td}>{timeOf(r.punched_at)}</td>
                <td style={td}>{r.source === 'manual' ? '補卡' : r.method === 'FACE' ? '人臉' : r.method === 'FP' ? '指紋' : r.method ?? ''}</td>
                <td style={{ ...td, color: '#666', textDecoration: 'none' }}>{r.voided ? r.voided_reason : r.note}</td>
                <td style={{ ...td, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  {r.voided ? (
                    <button style={btn} disabled={busy} onClick={() => setVoided(r, false)}>
                      還原
                    </button>
                  ) : (
                    <>
                      <input
                        placeholder="作廢原因"
                        value={voidReason[r.id] ?? ''}
                        onChange={(e) => setVoidReason({ ...voidReason, [r.id]: e.target.value })}
                        style={{ ...input, width: 110 }}
                      />{' '}
                      <button style={btn} disabled={busy} onClick={() => setVoided(r, true)}>
                        作廢
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td style={{ ...td, color: '#999' }} colSpan={5}>
                  這個月沒有打卡紀錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
