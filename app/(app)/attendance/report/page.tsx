'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import { resolveCurrentTerm } from '@/lib/academicTerm';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = { id: string; label: string };
type StudentRow = { student_no: string; seat_no: number; name: string };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;

function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 查看學生出席紀錄（月報／學期）：讓導師與管理員快速確認某個班級的出缺勤統計，
// 不用像「學生出缺席登錄（一週）」頁面一樣一週一週翻查。
function AttendanceReportPageInner() {
  const searchParams = useSearchParams();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isHomeroom, setIsHomeroom] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(searchParams?.get('classId') ?? null);
  const [className, setClassName] = useState('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [viewMode, setViewMode] = useState<'month' | 'term'>('month');
  const [monthValue, setMonthValue] = useState(currentMonthValue());
  const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [noClass, setNoClass] = useState(false);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      // 改用 isAdminInCurrentView()，讓「切換身分」在這頁也生效（見 attendance/mobile 同樣的修正）
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        const { data, error } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        if (error) {
          setLoadError('讀取班級清單失敗：' + error.message);
          return;
        }
        const options = (data ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
        setClassOptions(options);
        if (!classId && options.length > 0) setClassId(options[0].id);
        if (options.length === 0) setNoClass(true);
        return;
      }

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (!teacherRow) {
        setNoClass(true);
        return;
      }
      const { data: cls } = await supabase
        .from('classes')
        .select('id, class_name, grade_level')
        .eq('homeroom_teacher_id', teacherRow.id)
        .maybeSingle();
      if (!cls) {
        setNoClass(true);
        return;
      }
      setIsHomeroom(true);
      setClassId(cls.id);
      setClassName(`${cls.grade_level}${cls.class_name}`);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      setLoadError(null);

      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }

      const { data: enrollRowsRaw, error: enrollErr } = await supabase
        .from('enrollments')
        .select('seat_no, student_no')
        .eq('class_id', classId)
        .order('seat_no');
      if (enrollErr) {
        setLoadError('讀取學生名單失敗：' + enrollErr.message);
        setLoading(false);
        return;
      }
      // 【本輪新增】理由見 lib/hiddenStudents.ts 的說明（管理員切換教師視角
      // 預覽時，RLS 不會過濾隱藏名單，這裡在前端補一層過濾）。
      const hiddenNos = isAdmin ? new Set<string>() : await getHiddenStudentNos((enrollRowsRaw ?? []).map((r: any) => r.student_no));
      const enrollRows = (enrollRowsRaw ?? []).filter((r: any) => !hiddenNos.has(r.student_no));
      const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
      const { data: studentRows } = await supabase
        .from('students')
        .select('student_no, name')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__']);
      const nameByStudentNo = new Map((studentRows ?? []).map((s: any) => [s.student_no, s.name]));
      const rows: StudentRow[] = (enrollRows ?? []).map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: nameByStudentNo.get(r.student_no) ?? '（找不到姓名）',
      }));
      setStudents(rows);

      // 【本輪修正】反映事項「只有少部分學生有資料，例如某生出缺席狀況只有病假2節、
      // 出席卻是0」——根因跟 attendance/subject-view 頁之前修過的問題完全一樣：
      // attendance 這張表只有老師「實際點過、跟預設值不同」的節次才會存成一筆紀錄，
      // 「出席」只是畫面上沒存檔時的預設值，資料庫裡幾乎不會有 status='出席' 的列
      // （只要老師沒特別把某節從出席改回出席存檔，那一節根本不會有紀錄）。原本這裡
      // 是直接數「資料庫裡實際有幾列 status='出席'」，全校每個學生的出席數字因此
      // 幾乎一定是 0，不是只有這一位學生的問題。修法跟 subject-view 一致：不要數
      // 「資料庫有幾列」，改成先把這個班級「這學期課表」對應的每一次課（依課表的
      // 星期幾＋第幾節，從學期開學日或所選月份逐日推算到今天為止）都列出來，每一
      // 位學生每一次都算一格，資料庫有紀錄就用那筆的狀態，沒有紀錄就當作「出席」，
      // 這樣不管老師有沒有每次都手動存檔，總節數都是「到目前為止實際上了幾次課」。
      const currentTerm = await resolveCurrentTerm();
      let termStart: string | null = null;
      if (currentTerm) {
        const { data: termRow } = await supabase
          .from('academic_terms')
          .select('term_start_date')
          .eq('academic_year', currentTerm.academic_year)
          .eq('term', currentTerm.term)
          .maybeSingle();
        termStart = termRow?.term_start_date ?? null;
      }
      const todayStr = toDateStr(new Date());

      let rangeStart: string | null;
      let rangeEnd: string;
      if (viewMode === 'month') {
        const [y, m] = monthValue.split('-').map(Number);
        rangeStart = toDateStr(new Date(y, m - 1, 1));
        const monthEnd = toDateStr(new Date(y, m, 0));
        rangeEnd = monthEnd < todayStr ? monthEnd : todayStr; // 還沒發生的日期不算「已出席」
      } else {
        rangeStart = termStart;
        rangeEnd = todayStr;
      }

      let scheduleRows: { weekday: number; period_no: number }[] = [];
      if (currentTerm) {
        const { data: scheduleData, error: scheduleErr } = await supabase
          .from('class_schedule')
          .select('weekday, period_no')
          .eq('class_id', classId)
          .eq('academic_year', currentTerm.academic_year)
          .eq('term', currentTerm.term);
        if (scheduleErr) {
          setLoadError('讀取課表失敗：' + scheduleErr.message);
          setLoading(false);
          return;
        }
        scheduleRows = scheduleData ?? [];
      }

      const scheduledDates: { dateStr: string; period_no: number }[] = [];
      if (rangeStart && scheduleRows.length > 0) {
        const cursor = new Date(`${rangeStart}T00:00:00`);
        const end = new Date(`${rangeEnd}T00:00:00`);
        while (cursor <= end) {
          const weekday = cursor.getDay() || 7; // 0(週日)->7
          const dateStr = toDateStr(cursor);
          scheduleRows.forEach((s) => {
            if (s.weekday === weekday) scheduledDates.push({ dateStr, period_no: s.period_no });
          });
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      const { data: attRows, error: attErr } = await supabase
        .from('attendance')
        .select('student_no, record_date, period_no, status')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__'])
        .gte('record_date', rangeStart ?? '1900-01-01')
        .lte('record_date', rangeEnd);
      if (attErr) {
        setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        setLoading(false);
        return;
      }
      const existingByKey: Record<string, string> = {};
      (attRows ?? []).forEach((r: any) => {
        existingByKey[`${r.student_no}|${r.record_date}|${r.period_no}`] = r.status;
      });

      const map: Record<string, Record<string, number>> = {};
      rows.forEach((s) => {
        map[s.student_no] = {};
        scheduledDates.forEach(({ dateStr, period_no }) => {
          const status = existingByKey[`${s.student_no}|${dateStr}|${period_no}`] ?? '出席';
          map[s.student_no][status] = (map[s.student_no][status] ?? 0) + 1;
        });
      });
      setSummary(map);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, viewMode, monthValue, isAdmin]);

  if (noClass) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>學生出席紀錄查詢</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（本頁僅提供導師與管理員使用）。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 學生出席紀錄</h1>
      <ErrorBanner message={loadError} />

      {isAdmin && classOptions.length > 0 && (
        <select
          value={classId ?? ''}
          onChange={(e) => setClassId(e.target.value)}
          style={{ padding: 8, marginBottom: 12, width: '100%', maxWidth: 320 }}
        >
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" checked={viewMode === 'month'} onChange={() => setViewMode('month')} />
          月報
        </label>
        {viewMode === 'month' && (
          <input type="month" value={monthValue} onChange={(e) => setMonthValue(e.target.value)} style={{ padding: 6 }} />
        )}
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" checked={viewMode === 'term'} onChange={() => setViewMode('term')} />
          學期（累計目前已登錄的紀錄）
        </label>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
              <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
              {STATUS_OPTIONS.map((s) => (
                <th key={s} style={{ textAlign: 'right', padding: 6 }}>
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.student_no} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>{s.seat_no}</td>
                <td style={{ padding: 6 }}>{s.name}</td>
                {STATUS_OPTIONS.map((opt) => (
                  <td key={opt} style={{ padding: 6, textAlign: 'right' }}>
                    {summary[s.student_no]?.[opt] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={2 + STATUS_OPTIONS.length} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  這個班級目前沒有在學學生
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default function AttendanceReportPage() {
  return (
    <Suspense fallback={null}>
      <AttendanceReportPageInner />
    </Suspense>
  );
}
