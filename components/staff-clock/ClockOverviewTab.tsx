'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ClockEmployee,
  ClockHoliday,
  ClockOverride,
  ClockRecord,
  ClockShift,
  DaySummary,
  RangeStats,
  bangkokNow,
  employeeLabel,
  fmtHours,
  monthRange,
  summarizeRange,
} from '@/lib/staffClock';
import { buildDays, loadClockRange, loadHolidays } from '@/lib/staffClockData';
import { DayTable, MonthPicker, StatsCards, StatusBadge, btn, input, td, th } from './ClockParts';

type Props = {
  employees: ClockEmployee[];
  teacherNames: Map<string, string>;
  shifts: ClockShift[];
};

type Row = { emp: ClockEmployee; label: string; days: DaySummary[]; stats: RangeStats };

// 出席總覽：① 整月統計（每人一列，點開看每日明細）② 單日名單（誰幾點到、誰沒打卡）。
export default function ClockOverviewTab({ employees, teacherNames, shifts }: Props) {
  const [mode, setMode] = useState<'month' | 'day'>('month');
  const [month, setMonth] = useState(() => bangkokNow().date.slice(0, 7));
  const [date, setDate] = useState(() => bangkokNow().date);
  const [showInactive, setShowInactive] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [records, setRecords] = useState<ClockRecord[]>([]);
  const [overrides, setOverrides] = useState<ClockOverride[]>([]);
  const [holidays, setHolidays] = useState<ClockHoliday[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<number | null>(null);

  // 單日模式只需要那一天；月模式撈整個月
  const range = useMemo(() => (mode === 'month' ? monthRange(month) : { from: date, to: date, dates: [date] }), [mode, month, date]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [r, h] = await Promise.all([loadClockRange(range.from, range.to), loadHolidays(range.from, range.to)]);
        if (!alive) return;
        setRecords(r.records);
        setOverrides(r.overrides);
        setHolidays(h);
      } catch (e: any) {
        if (alive) setError(e.message ?? String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range.from, range.to]);

  const rows: Row[] = useMemo(() => {
    const shiftsById = new Map(shifts.map((s) => [s.id, s]));
    const hol = new Map(holidays.map((h) => [h.holiday_date, h]));
    const recBy = new Map<number, ClockRecord[]>();
    for (const r of records) {
      const a = recBy.get(r.device_code) ?? [];
      a.push(r);
      recBy.set(r.device_code, a);
    }
    const ovBy = new Map<number, ClockOverride[]>();
    for (const o of overrides) {
      const a = ovBy.get(o.device_code) ?? [];
      a.push(o);
      ovBy.set(o.device_code, a);
    }
    return employees
      .filter((e) => showInactive || e.active)
      .map((emp) => {
        const days = buildDays({
          dates: range.dates,
          employee: emp,
          shiftsById,
          records: recBy.get(emp.device_code) ?? [],
          overrides: ovBy.get(emp.device_code) ?? [],
          holidays: hol,
        });
        return {
          emp,
          label: employeeLabel(emp, emp.teacher_id ? teacherNames.get(emp.teacher_id) : null),
          days,
          stats: summarizeRange(days),
        };
      });
  }, [employees, shifts, records, overrides, holidays, range.dates, showInactive, teacherNames]);

  const visibleRows = rows.filter((r) => {
    if (!onlyProblems) return true;
    return mode === 'month'
      ? r.stats.late + r.stats.early + r.stats.missing + r.stats.absent > 0
      : ['遲到', '早退', '遲到早退', '漏打卡', '缺勤'].includes(r.days[0]?.status);
  });

  async function exportExcel() {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    if (mode === 'month') {
      const sum = [['機號', '姓名', '應到', '正常', '遲到', '早退', '漏打卡', '缺勤', '請假', '公出', '遲到分鐘', '在校分鐘']];
      for (const r of visibleRows)
        sum.push([r.emp.device_code, r.label, r.stats.expectedDays, r.stats.normal, r.stats.late, r.stats.early, r.stats.missing, r.stats.absent, r.stats.leave, r.stats.official, r.stats.lateMinutes, r.stats.workedMinutes] as any);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), `${month} 統計`);
      const detail = [['機號', '姓名', '日期', '班別', '上班', '下班', '狀態', '全部打卡', '備註']];
      for (const r of visibleRows)
        for (const d of r.days)
          if (!(d.status === '非排班日' && d.punches.length === 0))
            detail.push([r.emp.device_code, r.label, d.date, d.shiftLabel, d.inTime ?? '', d.outTime ?? '', d.status, d.punches.join(' '), d.note] as any);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), `${month} 明細`);
      XLSX.writeFile(wb, `教職員打卡_${month}.xlsx`);
    } else {
      const sheet = [['機號', '姓名', '班別', '上班', '下班', '狀態', '全部打卡', '備註']];
      for (const r of visibleRows) {
        const d = r.days[0];
        if (d) sheet.push([r.emp.device_code, r.label, d.shiftLabel, d.inTime ?? '', d.outTime ?? '', d.status, d.punches.join(' '), d.note] as any);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), date);
      XLSX.writeFile(wb, `教職員打卡_${date}.xlsx`);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <span>
          <button style={{ ...btn, background: mode === 'month' ? '#eee' : '#fff' }} onClick={() => setMode('month')}>
            整月統計
          </button>{' '}
          <button style={{ ...btn, background: mode === 'day' ? '#eee' : '#fff' }} onClick={() => setMode('day')}>
            單日名單
          </button>
        </span>
        {mode === 'month' ? <MonthPicker value={month} onChange={setMonth} /> : <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={input} />}
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> 只看有異常
        </label>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 含停用人員
        </label>
        <button style={btn} onClick={exportExcel} disabled={loading || visibleRows.length === 0}>
          匯出 Excel
        </button>
      </div>

      {loading && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}
      {error && <p style={{ fontSize: 13, color: '#c00' }}>{error}</p>}

      {mode === 'month' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                {['機號', '姓名', '班別', '應到', '正常', '遲到', '早退', '漏打卡', '缺勤', '請假', '公出', '遲到(分)', '在校時數'].map((h) => (
                  <th key={h} style={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const open = openCode === r.emp.device_code;
                const warn = (n: number) => (n > 0 ? { color: '#c2410c', fontWeight: 600 } : undefined);
                return (
                  <Fragment key={r.emp.device_code}>
                    <tr onClick={() => setOpenCode(open ? null : r.emp.device_code)} style={{ cursor: 'pointer', background: open ? '#f6f8ff' : undefined, opacity: r.emp.active ? 1 : 0.5 }}>
                      <td style={td}>{r.emp.device_code}</td>
                      <td style={td}>
                        {open ? '▾ ' : '▸ '}
                        {r.label}
                        {!r.emp.teacher_id && <span style={{ color: '#b26a00', fontSize: 11 }}>　未對應帳號</span>}
                      </td>
                      <td style={{ ...td, color: '#666' }}>
                        {r.emp.shift_ids.length ? r.emp.shift_ids.map((id) => shifts.find((s) => s.id === id)?.name).filter(Boolean).join('、') : <span style={{ color: '#b26a00' }}>未設定</span>}
                      </td>
                      <td style={td}>{r.stats.expectedDays}</td>
                      <td style={td}>{r.stats.normal}</td>
                      <td style={{ ...td, ...warn(r.stats.late) }}>{r.stats.late}</td>
                      <td style={{ ...td, ...warn(r.stats.early) }}>{r.stats.early}</td>
                      <td style={{ ...td, ...warn(r.stats.missing) }}>{r.stats.missing}</td>
                      <td style={{ ...td, ...warn(r.stats.absent) }}>{r.stats.absent}</td>
                      <td style={td}>{r.stats.leave}</td>
                      <td style={td}>{r.stats.official}</td>
                      <td style={td}>{r.stats.lateMinutes}</td>
                      <td style={td}>{fmtHours(r.stats.workedMinutes)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={13} style={{ padding: 12, background: '#fbfcff', borderBottom: '1px solid #eee' }}>
                          <StatsCards stats={r.stats} />
                          <DayTable days={r.days} hideEmptyOffDays />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!loading && visibleRows.length === 0 && (
                <tr>
                  <td style={{ ...td, color: '#999' }} colSpan={13}>
                    沒有符合的資料（若剛建立系統，請先到「匯入與同步」上傳打卡機 CSV）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'day' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                {['機號', '姓名', '班別', '上班', '下班', '狀態', '全部打卡', '備註'].map((h) => (
                  <th key={h} style={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const d = r.days[0];
                if (!d) return null;
                return (
                  <tr key={r.emp.device_code} style={{ opacity: r.emp.active ? 1 : 0.5 }}>
                    <td style={td}>{r.emp.device_code}</td>
                    <td style={td}>{r.label}</td>
                    <td style={{ ...td, color: '#666' }}>{d.shiftLabel || '—'}</td>
                    <td style={td}>{d.inTime ?? '—'}</td>
                    <td style={td}>{d.outTime ?? '—'}</td>
                    <td style={td}>
                      <StatusBadge status={d.status} />
                    </td>
                    <td style={{ ...td, color: '#666' }}>{d.punches.join('、') || '—'}</td>
                    <td style={{ ...td, color: '#666' }}>{d.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
