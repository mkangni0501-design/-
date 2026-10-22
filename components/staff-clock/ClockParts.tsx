'use client';

import { DaySummary, DayStatus, RangeStats, STATUS_COLOR, WEEKDAY_LABEL, fmtHours, shiftMonth } from '@/lib/staffClock';

export const th: React.CSSProperties = { padding: '6px 8px', borderBottom: '2px solid #ddd', textAlign: 'left', whiteSpace: 'nowrap', background: '#fafafa' };
export const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee', verticalAlign: 'top' };
export const btn: React.CSSProperties = { padding: '6px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 };
export const btnPrimary: React.CSSProperties = { ...btn, background: '#2C2C2A', color: '#fff', border: '1px solid #2C2C2A' };
export const input: React.CSSProperties = { padding: '5px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 };

export function StatusBadge({ status }: { status: DayStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 10, fontSize: 12, whiteSpace: 'nowrap' }}>{status}</span>
  );
}

export function MonthPicker({ value, onChange }: { value: string; onChange: (ym: string) => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button style={btn} onClick={() => onChange(shiftMonth(value, -1))}>
        ◀
      </button>
      <input type="month" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} style={input} />
      <button style={btn} onClick={() => onChange(shiftMonth(value, 1))}>
        ▶
      </button>
    </span>
  );
}

export function StatsCards({ stats }: { stats: RangeStats }) {
  const items: { label: string; value: string | number; warn?: boolean }[] = [
    { label: '應到天數', value: stats.expectedDays },
    { label: '正常', value: stats.normal },
    { label: '遲到', value: stats.late, warn: stats.late > 0 },
    { label: '早退', value: stats.early, warn: stats.early > 0 },
    { label: '漏打卡', value: stats.missing, warn: stats.missing > 0 },
    { label: '缺勤', value: stats.absent, warn: stats.absent > 0 },
    { label: '請假', value: stats.leave },
    { label: '公出', value: stats.official },
    { label: '遲到合計', value: `${stats.lateMinutes} 分`, warn: stats.lateMinutes > 0 },
    { label: '在校時數', value: fmtHours(stats.workedMinutes) },
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
      {items.map((it) => (
        <div
          key={it.label}
          style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: '8px 12px', minWidth: 78, background: it.warn ? '#fff8f0' : '#fff' }}
        >
          <div style={{ fontSize: 11, color: '#888' }}>{it.label}</div>
          <div style={{ fontSize: 17, fontWeight: 600, color: it.warn ? '#c2410c' : '#222' }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

/** 每日明細表：上班/下班取自「班別時段內」的第一筆與最後一筆打卡，其餘打卡列在「全部打卡」 */
export function DayTable({ days, hideEmptyOffDays }: { days: DaySummary[]; hideEmptyOffDays?: boolean }) {
  const list = hideEmptyOffDays ? days.filter((d) => !(d.status === '非排班日' && d.punches.length === 0)) : days;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={th}>日期</th>
            <th style={th}>星期</th>
            <th style={th}>班別</th>
            <th style={th}>上班</th>
            <th style={th}>下班</th>
            <th style={th}>狀態</th>
            <th style={th}>全部打卡</th>
            <th style={th}>備註</th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.date} style={{ background: d.weekday >= 6 ? '#fcfcfc' : undefined }}>
              <td style={td}>{d.date.slice(5).replace('-', '/')}</td>
              <td style={{ ...td, color: d.weekday === 7 ? '#c00' : undefined }}>{WEEKDAY_LABEL[d.weekday]}</td>
              <td style={{ ...td, color: '#666' }}>{d.shiftLabel || '—'}</td>
              <td style={td}>{d.inTime ?? '—'}</td>
              <td style={td}>{d.outTime ?? '—'}</td>
              <td style={td}>
                <StatusBadge status={d.status} />
              </td>
              <td style={{ ...td, color: '#666' }}>{d.punches.join('、') || '—'}</td>
              <td style={{ ...td, color: '#666' }}>{d.note}</td>
            </tr>
          ))}
          {list.length === 0 && (
            <tr>
              <td style={{ ...td, color: '#999' }} colSpan={8}>
                這個月沒有資料
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
