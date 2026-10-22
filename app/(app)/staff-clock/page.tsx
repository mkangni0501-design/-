'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { hasDepartment } from '@/lib/departments';
import {
  ClockEmployee,
  ClockHoliday,
  ClockOverride,
  ClockRecord,
  ClockShift,
  bangkokNow,
  employeeLabel,
  monthRange,
  summarizeRange,
  shiftLabel,
} from '@/lib/staffClock';
import { buildDays, loadClockRange, loadEmployees, loadHolidays, loadLastDataAt, loadShifts } from '@/lib/staffClockData';
import { DayTable, MonthPicker, StatsCards, input } from '@/components/staff-clock/ClockParts';

// 我的打卡紀錄：每位教職員只查得到「對應到自己」的打卡（資料庫 RLS 把關，不是只靠畫面隱藏）。
// 教務處／系統管理員S／管理員A 另外可以在上方下拉選單切換查看任何人。
// 每日的上班/下班/遲到/早退都是依「班別設定」當場推算，不是機器直接給的。
export default function MyStaffClockPage() {
  const perms = useDepartmentPermissions();
  const [roleManage, setRoleManage] = useState(false);
  const canManage = roleManage || hasDepartment(perms.myDepartments, 'academic');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<ClockEmployee[]>([]);
  const [teacherNames, setTeacherNames] = useState<Map<string, string>>(new Map());
  const [myTeacherIds, setMyTeacherIds] = useState<string[]>([]);
  const [shifts, setShifts] = useState<ClockShift[]>([]);
  const [selectedCode, setSelectedCode] = useState<number | null>(null);
  const [month, setMonth] = useState(() => bangkokNow().date.slice(0, 7));
  const [records, setRecords] = useState<ClockRecord[]>([]);
  const [overrides, setOverrides] = useState<ClockOverride[]>([]);
  const [holidays, setHolidays] = useState<ClockHoliday[]>([]);
  const [lastDataAt, setLastDataAt] = useState<string | null>(null);

  // 1) 基本資料：我是誰、我對應到哪些打卡機代碼
  useEffect(() => {
    (async () => {
      try {
        const me = await getCurrentAppUser();
        if (!me) {
          setError('尚未登入');
          return;
        }
        setRoleManage(isAdminInCurrentView(me.role) && (me.role === 'system_admin_s' || me.role === 'admin_a'));
        const [emps, shiftList, last, tRes] = await Promise.all([
          loadEmployees(),
          loadShifts(),
          loadLastDataAt(),
          supabase.from('teachers').select('id, name'),
        ]);
        const names = new Map<string, string>();
        const mine: string[] = [];
        for (const t of (tRes.data ?? []) as { id: string; name: string }[]) names.set(t.id, t.name);
        const { data: myT } = await supabase.from('teachers').select('id').eq('app_user_id', me.id);
        for (const t of (myT ?? []) as { id: string }[]) mine.push(t.id);
        setTeacherNames(names);
        setMyTeacherIds(mine);
        setEmployees(emps);
        setShifts(shiftList);
        setLastDataAt(last);
        const myEmp = emps.find((e) => e.teacher_id && mine.includes(e.teacher_id));
        setSelectedCode(myEmp ? myEmp.device_code : null);
      } catch (e: any) {
        setError(e.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const myEmployees = useMemo(() => employees.filter((e) => e.teacher_id && myTeacherIds.includes(e.teacher_id)), [employees, myTeacherIds]);
  const selectable = canManage ? employees.filter((e) => e.active) : myEmployees;
  const selected = employees.find((e) => e.device_code === selectedCode) ?? null;
  const { from, to, dates } = useMemo(() => monthRange(month), [month]);

  // 2) 選到的人／月份變動時，重新讀取當月資料
  useEffect(() => {
    if (selectedCode == null) return;
    let alive = true;
    (async () => {
      try {
        const [range, hol] = await Promise.all([loadClockRange(from, to, [selectedCode]), loadHolidays(from, to)]);
        if (!alive) return;
        setRecords(range.records);
        setOverrides(range.overrides);
        setHolidays(hol);
      } catch (e: any) {
        if (alive) setError(e.message ?? String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedCode, from, to]);

  const days = useMemo(() => {
    if (!selected) return [];
    return buildDays({
      dates,
      employee: selected,
      shiftsById: new Map(shifts.map((s) => [s.id, s])),
      records,
      overrides,
      holidays: new Map(holidays.map((h) => [h.holiday_date, h])),
    });
  }, [selected, dates, shifts, records, overrides, holidays]);
  const stats = useMemo(() => summarizeRange(days), [days]);
  const myShifts = selected ? (selected.shift_ids.map((id) => shifts.find((s) => s.id === id)).filter(Boolean) as ClockShift[]) : [];
  const lastLabel = lastDataAt ? new Date(lastDataAt).toLocaleString('zh-TW', { timeZone: 'Asia/Bangkok', hour12: false }) : null;

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>我的打卡紀錄</h1>
      <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>
        打卡機資料由學校電腦每天自動更新{lastLabel ? `，目前資料最新到 ${lastLabel}（泰國時間）` : ''}。上班／下班依「班別設定」的時段推算；如有錯漏請洽教務處補卡或更正。
      </p>

      {loading && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}
      {error && <p style={{ fontSize: 13, color: '#c00' }}>{error}</p>}

      {!loading && !error && selectable.length === 0 && (
        <div style={{ border: '1px solid #f0d9a8', background: '#fffbf0', padding: 16, borderRadius: 8, fontSize: 14 }}>
          您的帳號還沒有對應到任何打卡機人員，所以查不到打卡紀錄。請洽教務處，請他們在「教職員打卡管理 → 人員對照」把您的教師帳號對應到打卡機上的人員編號。
        </div>
      )}

      {!loading && selectable.length > 0 && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', margin: '12px 0' }}>
            <MonthPicker value={month} onChange={setMonth} />
            {canManage && (
              <label style={{ fontSize: 13 }}>
                查看人員：
                <select value={selectedCode ?? ''} onChange={(e) => setSelectedCode(Number(e.target.value))} style={{ ...input, marginLeft: 4 }}>
                  {selectedCode == null && <option value="">請選擇</option>}
                  {selectable.map((e) => (
                    <option key={e.device_code} value={e.device_code}>
                      {employeeLabel(e, e.teacher_id ? teacherNames.get(e.teacher_id) : null)}（機號 {e.device_code}）
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!canManage && myEmployees.length > 1 && (
              <select value={selectedCode ?? ''} onChange={(e) => setSelectedCode(Number(e.target.value))} style={input}>
                {myEmployees.map((e) => (
                  <option key={e.device_code} value={e.device_code}>
                    機號 {e.device_code}（{e.device_name}）
                  </option>
                ))}
              </select>
            )}
          </div>

          {selected && (
            <>
              <div style={{ fontSize: 13, color: '#555' }}>
                {employeeLabel(selected, selected.teacher_id ? teacherNames.get(selected.teacher_id) : null)}　班別：
                {myShifts.length ? myShifts.map(shiftLabel).join('；') : '尚未設定'}
              </div>
              <StatsCards stats={stats} />
              <DayTable days={days} hideEmptyOffDays />
            </>
          )}
          {!selected && canManage && <p style={{ fontSize: 13, color: '#888' }}>請選擇要查看的人員。</p>}
        </>
      )}
    </main>
  );
}
