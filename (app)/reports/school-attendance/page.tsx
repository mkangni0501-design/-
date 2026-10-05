'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getMyDepartments, hasDepartment } from '@/lib/departments';

type StudentRow = {
  student_no: string;
  name: string;
  className: string;
  absence_periods: number;
  personal_leave_periods: number;
  sick_leave_periods: number;
  truancy_periods: number;
};
type NotifRow = { student_no: string; decision: string; created_at: string; absence_count: number };

// 全校出缺席狀況總覽（僅管理員）：列出全校每位學生「事假+病假+曠課」累計節數，
// 達到門檻的會特別標示，並附上導師是否已寄送通知信的紀錄。
export default function SchoolAttendanceOverviewPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [threshold, setThreshold] = useState(3);
  const [examDeductionThreshold, setExamDeductionThreshold] = useState<number | null>(null);
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [notifByStudent, setNotifByStudent] = useState<Record<string, NotifRow>>({});
  const [keyword, setKeyword] = useState('');
  const [onlyOverThreshold, setOnlyOverThreshold] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      // 改用 isAdminInCurrentView()，讓「切換身分」對這頁也生效：管理員切到教師視角時，
      // 這個全校總覽頁應該跟著視為不可見，不然身分切換形同虛設。
      const admin = isAdminInCurrentView(appUser?.role);
      // 訓導部門（承辦人員／主管皆可）不是 admin_a/admin_b/system_admin_s，過去只檢查
      // isAdminInCurrentView() 會被判定「資格不足」看不到這頁——但全校出缺席總覽本來
      // 就是訓導處最主要會用到的頁面之一。這裡另外檢查是否身兼訓導部門（同樣尊重
      // 「切換身分」：管理員切到教師視角時 sessionStorage.viewMode==='teacher'，
      // 這時不查部門，維持跟其他管理頁一致的行為）。
      const viewingAsTeacher = typeof window !== 'undefined' && sessionStorage.getItem('viewMode') === 'teacher';
      let isDiscipline = false;
      if (!viewingAsTeacher && appUser?.id) {
        const depts = await getMyDepartments(appUser.id);
        isDiscipline = hasDepartment(depts, 'discipline');
      }
      const canView = admin || isDiscipline;
      setIsAdmin(canView);
      if (!canView) return;

      setLoading(true);
      const { data: settingRow } = await supabase
        .from('attendance_alert_settings')
        .select('threshold_periods, exam_deduction_absence_threshold')
        .eq('id', 1)
        .maybeSingle();
      if (settingRow) {
        setThreshold(settingRow.threshold_periods);
        setExamDeductionThreshold(settingRow.exam_deduction_absence_threshold ?? null);
      }

      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('student_no, students(name), classes(grade_level, class_name)')
        .eq('is_current', true);
      if (enrollErr) {
        setLoadError('讀取學生名冊失敗：' + enrollErr.message);
        setLoading(false);
        return;
      }

      const { data: absenceRows, error: absenceErr } = await supabase
        .from('student_absence_counts')
        .select('student_no, absence_periods, personal_leave_periods, sick_leave_periods, truancy_periods');
      if (absenceErr) {
        setLoadError('讀取出缺勤統計失敗：' + absenceErr.message);
        setLoading(false);
        return;
      }
      const absenceMap = new Map((absenceRows ?? []).map((r: any) => [r.student_no, r]));

      const studentRows: StudentRow[] = (enrollRows ?? []).map((e: any) => {
        const a = absenceMap.get(e.student_no);
        return {
          student_no: e.student_no,
          name: e.students?.name ?? e.student_no,
          className: `${e.classes?.grade_level ?? ''}${e.classes?.class_name ?? ''}`,
          absence_periods: a?.absence_periods ?? 0,
          personal_leave_periods: a?.personal_leave_periods ?? 0,
          sick_leave_periods: a?.sick_leave_periods ?? 0,
          truancy_periods: a?.truancy_periods ?? 0,
        };
      });
      studentRows.sort((a, b) => b.absence_periods - a.absence_periods);
      setRows(studentRows);

      const { data: notifRows } = await supabase
        .from('attendance_notifications')
        .select('student_no, decision, created_at, absence_count')
        .order('created_at', { ascending: false });
      const notifMap: Record<string, NotifRow> = {};
      (notifRows ?? []).forEach((n: any) => {
        if (!notifMap[n.student_no]) notifMap[n.student_no] = n; // 只留每位學生最新一筆
      });
      setNotifByStudent(notifMap);

      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) => {
    if (onlyOverThreshold && r.absence_periods < threshold) return false;
    if (keyword && !r.name.includes(keyword) && !r.student_no.includes(keyword)) return false;
    return true;
  });

  if (isAdmin === false) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>全校出缺席狀況總覽</h1>
        <p style={{ fontSize: 13, color: '#999' }}>本頁僅提供管理員或訓導部門人員使用。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>全校出缺席狀況總覽</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        目前示警門檻：事假＋病假＋曠課 累計達 {threshold} 節（可至「出缺席示警門檻設定」調整）。
        {examDeductionThreshold != null && <>　扣考參考門檻：{examDeductionThreshold} 節（達到會標示「扣考參考」，實際是否扣考仍由訓導處人工認定）。</>}
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="搜尋姓名或學號"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ padding: 8, flex: 1, minWidth: 160 }}
        />
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={onlyOverThreshold} onChange={(e) => setOnlyOverThreshold(e.target.checked)} />
          只顯示達門檻的學生
        </label>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
              <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
              <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
              <th style={{ textAlign: 'right', padding: 6 }}>事假+病假+曠課</th>
              <th style={{ textAlign: 'right', padding: 6 }}>事假</th>
              <th style={{ textAlign: 'right', padding: 6 }}>病假</th>
              <th style={{ textAlign: 'right', padding: 6 }}>曠課</th>
              <th style={{ textAlign: 'left', padding: 6 }}>導師最新處理紀錄</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const overThreshold = r.absence_periods >= threshold;
              const notif = notifByStudent[r.student_no];
              return (
                <tr
                  key={r.student_no}
                  style={{ borderTop: '1px solid #eee', background: overThreshold ? '#FBEFE9' : undefined }}
                >
                  <td style={{ padding: 6 }}>{r.student_no}</td>
                  <td style={{ padding: 6 }}>{r.name}</td>
                  <td style={{ padding: 6 }}>{r.className}</td>
                  <td style={{ padding: 6, textAlign: 'right', fontWeight: overThreshold ? 700 : 400, color: overThreshold ? '#A36A2D' : undefined }}>
                    {r.absence_periods}
                    {examDeductionThreshold != null && r.absence_periods >= examDeductionThreshold && (
                      <span style={{ marginLeft: 4, fontSize: 10, color: '#A32D2D', fontWeight: 700 }}>⚠扣考參考</span>
                    )}
                  </td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.personal_leave_periods}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.sick_leave_periods}</td>
                  <td style={{ padding: 6, textAlign: 'right' }}>{r.truancy_periods}</td>
                  <td style={{ padding: 6, fontSize: 12, color: '#666' }}>
                    {notif
                      ? `${notif.decision}（累計${notif.absence_count}節，${new Date(notif.created_at).toLocaleDateString('zh-TW')}）`
                      : '尚無紀錄'}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  沒有符合條件的學生
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
