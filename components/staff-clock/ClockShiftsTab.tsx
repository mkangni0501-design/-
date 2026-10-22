'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { ClockHoliday, ClockShift, WEEKDAY_LABEL, addDays, bangkokNow, isoWeekday } from '@/lib/staffClock';
import { loadHolidays } from '@/lib/staffClockData';
import { btn, btnPrimary, input, td, th } from './ClockParts';

type Props = { shifts: ClockShift[]; onChanged: () => void };

const hhmm = (t: string) => t.slice(0, 5);

const emptyShift = {
  name: '',
  start_time: '17:00',
  end_time: '20:30',
  late_grace_min: 10,
  early_grace_min: 0,
  work_days: [1, 2, 3, 4, 5],
  window_before_min: 180,
  window_after_min: 240,
  active: true,
  sort_order: 0,
};

// 班別設定＋全校放假日。
// 遲到＝上班打卡晚於「上班時間＋遲到寬限」；早退＝下班打卡早於「下班時間－早退寬限」。
// 「打卡有效時段」：只有上班時間往前 X 分鐘～下班時間往後 Y 分鐘之內的打卡才算這個班別的打卡。
// 改設定之後，歷史月份會依新設定重新判斷（原始打卡紀錄不會動）。
export default function ClockShiftsTab({ shifts, onChanged }: Props) {
  const [drafts, setDrafts] = useState<Record<string, ClockShift>>({});
  const [form, setForm] = useState({ ...emptyShift, sort_order: shifts.length + 1 });
  const [message, setMessage] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<ClockHoliday[]>([]);
  const [hDate, setHDate] = useState('');
  const [hName, setHName] = useState('');
  const [quiet, setQuiet] = useState<{ day: string; people: number }[] | null>(null);

  async function loadHol() {
    try {
      setHolidays((await loadHolidays('2000-01-01', '2100-12-31')).sort((a, b) => b.holiday_date.localeCompare(a.holiday_date)));
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  useEffect(() => {
    loadHol();
  }, []);

  const cur = (s: ClockShift) => drafts[s.id] ?? s;
  const dirty = (s: ClockShift) => !!drafts[s.id] && JSON.stringify(drafts[s.id]) !== JSON.stringify(s);
  const patch = (s: ClockShift, p: Partial<ClockShift>) => setDrafts((prev) => ({ ...prev, [s.id]: { ...cur(s), ...p } }));
  const toggleDay = (days: number[], d: number) => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());

  async function saveShift(s: ClockShift) {
    const d = cur(s);
    if (!d.name.trim()) return setMessage('班別名稱不能空白');
    if (d.work_days.length === 0) return setMessage('請至少勾選一個上班日');
    const { error } = await supabase
      .from('clock_shifts')
      .update({
        name: d.name.trim(),
        start_time: d.start_time,
        end_time: d.end_time,
        late_grace_min: d.late_grace_min,
        early_grace_min: d.early_grace_min,
        work_days: d.work_days,
        window_before_min: d.window_before_min,
        window_after_min: d.window_after_min,
        active: d.active,
        sort_order: d.sort_order,
      })
      .eq('id', s.id);
    if (error) return setMessage('儲存失敗：' + error.message);
    setMessage('已儲存');
    setDrafts((p) => {
      const n = { ...p };
      delete n[s.id];
      return n;
    });
    onChanged();
  }

  async function addShift() {
    if (!form.name.trim()) return setMessage('請輸入班別名稱');
    if (form.work_days.length === 0) return setMessage('請至少勾選一個上班日');
    const { error } = await supabase.from('clock_shifts').insert({ ...form, name: form.name.trim() });
    if (error) return setMessage('新增失敗：' + error.message);
    setMessage('已新增班別');
    setForm({ ...emptyShift, sort_order: shifts.length + 2 });
    onChanged();
  }

  async function deleteShift(s: ClockShift) {
    // 專案慣例：LINE 內建瀏覽器會擋 window.confirm，所以這裡不刪除、改成「停用」，已掛這個班別的人員資料也不會遺失
    const { error } = await supabase.from('clock_shifts').update({ active: false }).eq('id', s.id);
    if (error) return setMessage('停用失敗：' + error.message);
    setMessage(`已停用「${s.name}」（已掛這個班別的人員不會再以它判斷；需要時可再勾回啟用）`);
    onChanged();
  }

  async function addHoliday() {
    if (!hDate) return setMessage('請選擇放假日期');
    const { error } = await supabase.from('clock_holidays').upsert({ holiday_date: hDate, name: hName.trim() || '放假' }, { onConflict: 'holiday_date' });
    if (error) return setMessage('新增放假日失敗：' + error.message);
    setHDate('');
    setHName('');
    loadHol();
  }
  // 偵測疑似放假日：近 180 天內「整天幾乎沒人打卡」的週一～週六，讓教務處確認後一鍵補進放假日
  async function detectQuietDays() {
    const today = bangkokNow().date;
    const { data, error } = await supabase.rpc('clock_quiet_days', { p_from: addDays(today, -180), p_to: today, p_max_people: 2 });
    if (error) return setMessage('偵測失敗：' + error.message + '（若是第一次使用，請確認已執行 sql/104staff_clock.sql）');
    setQuiet((data ?? []) as { day: string; people: number }[]);
    setMessage(null);
  }
  async function addQuietAsHolidays(days: string[]) {
    if (days.length === 0) return;
    const { error } = await supabase.from('clock_holidays').upsert(days.map((d) => ({ holiday_date: d, name: '放假（由打卡資料偵測）' })), { onConflict: 'holiday_date' });
    if (error) return setMessage('新增放假日失敗：' + error.message);
    setQuiet((q) => (q ? q.filter((x) => !days.includes(x.day)) : q));
    loadHol();
  }

  async function removeHoliday(d: string) {
    const { error } = await supabase.from('clock_holidays').delete().eq('holiday_date', d);
    if (error) return setMessage('刪除失敗：' + error.message);
    loadHol();
  }

  const DayChecks = ({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
        <label key={d} style={{ marginRight: 4, fontSize: 12 }}>
          <input type="checkbox" checked={days.includes(d)} onChange={() => onToggle(d)} />
          {WEEKDAY_LABEL[d]}
        </label>
      ))}
    </span>
  );
  const num = (v: string) => Math.max(0, Number(v) || 0);

  return (
    <div>
      {message && <p style={{ fontSize: 13, color: message.includes('失敗') || message.includes('請') ? '#c00' : '#2e7d32' }}>{message}</p>}
      <h3 style={{ fontSize: 15 }}>班別</h3>
      <p style={{ fontSize: 12, color: '#777', marginTop: 0 }}>
        同一個人可同時掛多個班別（例如「平日晚班」＋「週六早班」），某天只會採用「上班日」包含當天的那一個。預設兩個班別是依 2026/5–9 的實際打卡規律估的起始值，請依學校規定調整。
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              {['名稱', '上班', '下班', '遲到寬限(分)', '早退寬限(分)', '上班日', '有效時段：上班前(分)', '下班後(分)', '啟用', ''].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => {
              const d = cur(s);
              return (
                <tr key={s.id} style={{ background: dirty(s) ? '#fffdf0' : undefined, opacity: d.active ? 1 : 0.55 }}>
                  <td style={td}>
                    <input value={d.name} onChange={(e) => patch(s, { name: e.target.value })} style={{ ...input, width: 100 }} />
                  </td>
                  <td style={td}>
                    <input type="time" value={hhmm(d.start_time)} onChange={(e) => patch(s, { start_time: e.target.value })} style={input} />
                  </td>
                  <td style={td}>
                    <input type="time" value={hhmm(d.end_time)} onChange={(e) => patch(s, { end_time: e.target.value })} style={input} />
                  </td>
                  <td style={td}>
                    <input type="number" min={0} value={d.late_grace_min} onChange={(e) => patch(s, { late_grace_min: num(e.target.value) })} style={{ ...input, width: 60 }} />
                  </td>
                  <td style={td}>
                    <input type="number" min={0} value={d.early_grace_min} onChange={(e) => patch(s, { early_grace_min: num(e.target.value) })} style={{ ...input, width: 60 }} />
                  </td>
                  <td style={td}>
                    <DayChecks days={d.work_days} onToggle={(x) => patch(s, { work_days: toggleDay(d.work_days, x) })} />
                  </td>
                  <td style={td}>
                    <input type="number" min={0} value={d.window_before_min} onChange={(e) => patch(s, { window_before_min: num(e.target.value) })} style={{ ...input, width: 70 }} />
                  </td>
                  <td style={td}>
                    <input type="number" min={0} value={d.window_after_min} onChange={(e) => patch(s, { window_after_min: num(e.target.value) })} style={{ ...input, width: 70 }} />
                  </td>
                  <td style={td}>
                    <input type="checkbox" checked={d.active} onChange={(e) => patch(s, { active: e.target.checked })} />
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button style={dirty(s) ? btnPrimary : btn} disabled={!dirty(s)} onClick={() => saveShift(s)}>
                      儲存
                    </button>{' '}
                    {d.active && (
                      <button style={btn} onClick={() => deleteShift(s)}>
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr style={{ background: '#fafafa' }}>
              <td style={td}>
                <input placeholder="新班別名稱" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...input, width: 100 }} />
              </td>
              <td style={td}>
                <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} style={input} />
              </td>
              <td style={td}>
                <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} style={input} />
              </td>
              <td style={td}>
                <input type="number" min={0} value={form.late_grace_min} onChange={(e) => setForm({ ...form, late_grace_min: num(e.target.value) })} style={{ ...input, width: 60 }} />
              </td>
              <td style={td}>
                <input type="number" min={0} value={form.early_grace_min} onChange={(e) => setForm({ ...form, early_grace_min: num(e.target.value) })} style={{ ...input, width: 60 }} />
              </td>
              <td style={td}>
                <DayChecks days={form.work_days} onToggle={(x) => setForm({ ...form, work_days: toggleDay(form.work_days, x) })} />
              </td>
              <td style={td}>
                <input type="number" min={0} value={form.window_before_min} onChange={(e) => setForm({ ...form, window_before_min: num(e.target.value) })} style={{ ...input, width: 70 }} />
              </td>
              <td style={td}>
                <input type="number" min={0} value={form.window_after_min} onChange={(e) => setForm({ ...form, window_after_min: num(e.target.value) })} style={{ ...input, width: 70 }} />
              </td>
              <td style={td}></td>
              <td style={td}>
                <button style={btnPrimary} onClick={addShift}>
                  新增班別
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, marginTop: 28 }}>全校放假日</h3>
      <p style={{ fontSize: 12, color: '#777', marginTop: 0 }}>放假日當天不判缺勤、不計入應到天數（個別請假請到「補卡／更正」分頁）。</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} style={input} />
        <input placeholder="名稱（例如：佛誕日）" value={hName} onChange={(e) => setHName(e.target.value)} style={{ ...input, width: 180 }} />
        <button style={btnPrimary} onClick={addHoliday}>
          新增放假日
        </button>
      </div>
      <div style={{ margin: '8px 0 12px' }}>
        <button style={btn} onClick={detectQuietDays}>
          偵測疑似放假日（近 180 天整天幾乎沒人打卡）
        </button>
        {quiet && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {quiet.length === 0 ? (
              <span style={{ color: '#2e7d32' }}>沒有發現疑似放假日（或都已設定過）。</span>
            ) : (
              <>
                <div style={{ marginBottom: 6 }}>
                  找到 {quiet.length} 天（請確認後再加入）：{' '}
                  <button style={btnPrimary} onClick={() => addQuietAsHolidays(quiet.map((q) => q.day))}>
                    全部加入放假日
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {quiet.map((q) => (
                    <button key={q.day} style={btn} onClick={() => addQuietAsHolidays([q.day])} title="點一下加入放假日">
                      {q.day}（週{WEEKDAY_LABEL[isoWeekday(q.day)]}・{q.people}人打卡）＋
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          {holidays.slice(0, 60).map((h) => (
            <tr key={h.holiday_date}>
              <td style={td}>{h.holiday_date}</td>
              <td style={td}>{h.name}</td>
              <td style={td}>
                <button style={btn} onClick={() => removeHoliday(h.holiday_date)}>
                  刪除
                </button>
              </td>
            </tr>
          ))}
          {holidays.length === 0 && (
            <tr>
              <td style={{ ...td, color: '#999' }}>尚未設定放假日</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
