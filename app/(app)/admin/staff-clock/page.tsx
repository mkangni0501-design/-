'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { hasDepartment } from '@/lib/departments';
import { ClockEmployee, ClockShift } from '@/lib/staffClock';
import { loadEmployees, loadShifts } from '@/lib/staffClockData';
import ClockOverviewTab from '@/components/staff-clock/ClockOverviewTab';
import ClockMappingTab from '@/components/staff-clock/ClockMappingTab';
import ClockShiftsTab from '@/components/staff-clock/ClockShiftsTab';
import ClockCorrectionsTab from '@/components/staff-clock/ClockCorrectionsTab';
import ClockImportTab from '@/components/staff-clock/ClockImportTab';
import { btn } from '@/components/staff-clock/ClockParts';

type TabKey = 'overview' | 'mapping' | 'shifts' | 'corrections' | 'import';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '出席總覽' },
  { key: 'mapping', label: '人員對照' },
  { key: 'shifts', label: '班別與放假日' },
  { key: 'corrections', label: '補卡／更正' },
  { key: 'import', label: '匯入與同步' },
];

// 教職員打卡管理：只有「系統管理員S、系統管理員A、教務部門成員」進得來
// （資料庫 RLS 的 can_manage_staff_clock() 是同一套規則，畫面擋不住的人在資料庫也讀寫不到）。
// 一般教職員請用「我的打卡紀錄」（/staff-clock）查自己的。
export default function AdminStaffClockPage() {
  const perms = useDepartmentPermissions();
  const [roleOk, setRoleOk] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [employees, setEmployees] = useState<ClockEmployee[]>([]);
  const [shifts, setShifts] = useState<ClockShift[]>([]);
  const [teachers, setTeachers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getCurrentAppUser().then((me) => setRoleOk(!!me && isAdminInCurrentView(me.role) && (me.role === 'system_admin_s' || me.role === 'admin_a')));
  }, []);

  const canManage = (roleOk ?? false) || hasDepartment(perms.myDepartments, 'academic');
  const ready = roleOk !== null && !perms.loading;

  const reload = useCallback(async () => {
    try {
      const [emps, sh, tRes] = await Promise.all([loadEmployees(), loadShifts(), supabase.from('teachers').select('id, name').order('name')]);
      setEmployees(emps);
      setShifts(sh);
      setTeachers((tRes.data ?? []) as { id: string; name: string }[]);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (ready && canManage) reload();
  }, [ready, canManage, reload]);

  if (!ready) return <main style={{ padding: 24 }}><p style={{ fontSize: 13, color: '#999' }}>載入中…</p></main>;

  if (!canManage) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 8 }}>沒有權限</h1>
        <p style={{ fontSize: 13, color: '#999' }}>
          教職員打卡管理只開放給系統管理員S、系統管理員A與教務處成員。想查自己的打卡紀錄，請到「我的打卡紀錄」。
        </p>
      </main>
    );
  }

  const teacherNames = new Map(teachers.map((t) => [t.id, t.name]));

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>教職員打卡管理</h1>
      <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>查詢全校教職員出席、設定班別、對照打卡機人員、補卡更正、匯入打卡資料。</p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0 16px', borderBottom: '1px solid #ddd', paddingBottom: 8 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{ ...btn, background: tab === t.key ? '#2C2C2A' : '#fff', color: tab === t.key ? '#fff' : '#222', border: '1px solid #2C2C2A' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p style={{ fontSize: 13, color: '#c00' }}>{error}（若是第一次使用，請先在 Supabase 執行 sql/104staff_clock.sql）</p>}
      {!loaded && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}

      {loaded && !error && (
        <>
          {tab === 'overview' && <ClockOverviewTab employees={employees} teacherNames={teacherNames} shifts={shifts} />}
          {tab === 'mapping' && <ClockMappingTab employees={employees} teachers={teachers} shifts={shifts} onChanged={reload} />}
          {tab === 'shifts' && <ClockShiftsTab shifts={shifts} onChanged={reload} />}
          {tab === 'corrections' && <ClockCorrectionsTab employees={employees} teacherNames={teacherNames} userId={perms.userId} />}
          {tab === 'import' && <ClockImportTab onImported={reload} />}
        </>
      )}
    </main>
  );
}
