'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';

// 修正／解鎖紀錄查詢頁
// ------------------------------------------------------------
// 僅系統管理員S、管理員A看得到（資料庫層級的 RLS 也已經限制成只有這兩種角色查得到，
// 這裡的畫面判斷是第二層防護，不是唯一防線）。
// 內容分兩塊：
//   1. 出缺勤修改紀錄：導師/管理員對 attendance 表的每一筆新增／修改，都會被資料庫的
//      trigger 自動記一筆（見 sql/40score_attendance_audit_and_autolock.sql）。
//   2. 成績/出缺勤鎖定 解鎖紀錄：「成績上傳時間設定表」裡，一筆設定從「已鎖定」被重新
//      打開時，會自動記一筆（含操作者與原因）。

type AttendanceAuditRow = {
  id: string;
  changed_at: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  attendance_id: string;
};

// 成績修改紀錄：對應 sql/41score_entry_fixes.sql 新增的 trg_log_score_change trigger。
// score_id 指向 scores.id——如果那筆分數後來被刪除，score_id 會變成「指向一筆已經不存在
// 的資料」（scores.id 沒有設 on delete cascade），這種情況畫面上會顯示「（找不到，可能已刪除）」。
type ScoreAuditRow = {
  id: string;
  changed_at: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  score_id: string;
};

type WindowAuditRow = {
  id: string;
  changed_at: string;
  academic_year: number;
  term: string;
  data_type: string;
  scope: string;
  scope_ref: string | null;
  old_is_locked: boolean;
  new_is_locked: boolean;
  old_closes_at: string | null;
  new_closes_at: string | null;
  changed_by: string | null;
  reason: string | null;
};

function formatDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AuditLogsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'attendance' | 'score' | 'window'>('attendance');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [attRows, setAttRows] = useState<AttendanceAuditRow[]>([]);
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [attendanceInfo, setAttendanceInfo] = useState<Record<string, { student_no: string; record_date: string; period_no: number }>>({});
  const [studentNames, setStudentNames] = useState<Record<string, string>>({});

  const [winRows, setWinRows] = useState<WindowAuditRow[]>([]);
  const [appUserNames, setAppUserNames] = useState<Record<string, string>>({});

  const [scoreRows, setScoreRows] = useState<ScoreAuditRow[]>([]);
  const [scoreInfo, setScoreInfo] = useState<Record<string, { student_no: string; subject: string; exam_type: string }>>({});
  const [scoreStudentNames, setScoreStudentNames] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const me = await getCurrentAppUser();
      setAllowed(!!me && (me.role === 'system_admin_s' || me.role === 'admin_a'));
    })();
  }, []);

  useEffect(() => {
    if (allowed !== true) return;
    (async () => {
      setLoading(true);
      if (tab === 'attendance') {
        const { data, error } = await supabase
          .from('attendance_audit_log')
          .select('id, changed_at, old_value, new_value, changed_by, attendance_id')
          .order('changed_at', { ascending: false })
          .limit(500);
        setLoadError(error ? '讀取出缺勤修改紀錄失敗：' + error.message : null);
        const rows = (data ?? []) as AttendanceAuditRow[];
        setAttRows(rows);

        const teacherIds = Array.from(new Set(rows.map((r) => r.changed_by).filter((v): v is string => !!v)));
        if (teacherIds.length > 0) {
          const { data: teacherRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          setTeacherNames(Object.fromEntries((teacherRows ?? []).map((t: any) => [t.id, t.name])));
        }

        const attIds = Array.from(new Set(rows.map((r) => r.attendance_id)));
        if (attIds.length > 0) {
          const { data: attInfoRows } = await supabase.from('attendance').select('id, student_no, record_date, period_no').in('id', attIds);
          const infoMap: Record<string, { student_no: string; record_date: string; period_no: number }> = {};
          (attInfoRows ?? []).forEach((r: any) => (infoMap[r.id] = r));
          setAttendanceInfo(infoMap);

          const studentNos = Array.from(new Set((attInfoRows ?? []).map((r: any) => r.student_no)));
          if (studentNos.length > 0) {
            const { data: studentRows } = await supabase.from('students').select('student_no, name').in('student_no', studentNos);
            setStudentNames(Object.fromEntries((studentRows ?? []).map((s: any) => [s.student_no, s.name])));
          }
        }
      } else if (tab === 'score') {
        const { data, error } = await supabase
          .from('score_audit_log')
          .select('id, changed_at, old_value, new_value, changed_by, score_id')
          .order('changed_at', { ascending: false })
          .limit(500);
        setLoadError(error ? '讀取成績修改紀錄失敗：' + error.message : null);
        const rows = (data ?? []) as ScoreAuditRow[];
        setScoreRows(rows);

        const teacherIds = Array.from(new Set(rows.map((r) => r.changed_by).filter((v): v is string => !!v)));
        if (teacherIds.length > 0) {
          const { data: teacherRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          setTeacherNames((prev) => ({ ...prev, ...Object.fromEntries((teacherRows ?? []).map((t: any) => [t.id, t.name])) }));
        }

        const scoreIds = Array.from(new Set(rows.map((r) => r.score_id)));
        if (scoreIds.length > 0) {
          const { data: scoreInfoRows } = await supabase.from('scores').select('id, enrollment_id, subject, exam_type').in('id', scoreIds);
          const infoMap: Record<string, { student_no: string; subject: string; exam_type: string }> = {};
          const enrollmentIds = Array.from(new Set((scoreInfoRows ?? []).map((r: any) => r.enrollment_id)));
          let studentNoByEnrollment: Record<string, string> = {};
          if (enrollmentIds.length > 0) {
            const { data: enrollRows } = await supabase.from('enrollments').select('id, student_no').in('id', enrollmentIds);
            studentNoByEnrollment = Object.fromEntries((enrollRows ?? []).map((e: any) => [e.id, e.student_no]));
          }
          (scoreInfoRows ?? []).forEach((r: any) => {
            infoMap[r.id] = { student_no: studentNoByEnrollment[r.enrollment_id] ?? '', subject: r.subject, exam_type: r.exam_type };
          });
          setScoreInfo(infoMap);

          const studentNos = Array.from(new Set(Object.values(infoMap).map((i) => i.student_no).filter(Boolean)));
          if (studentNos.length > 0) {
            const { data: studentRows } = await supabase.from('students').select('student_no, name').in('student_no', studentNos);
            setScoreStudentNames(Object.fromEntries((studentRows ?? []).map((s: any) => [s.student_no, s.name])));
          }
        }
      } else {
        const { data, error } = await supabase
          .from('submission_window_audit_log')
          .select('*')
          .order('changed_at', { ascending: false })
          .limit(500);
        setLoadError(error ? '讀取解鎖紀錄失敗：' + error.message : null);
        const rows = (data ?? []) as WindowAuditRow[];
        setWinRows(rows);

        const userIds = Array.from(new Set(rows.map((r) => r.changed_by).filter((v): v is string => !!v)));
        if (userIds.length > 0) {
          const { data: userRows } = await supabase.from('app_users').select('id, name').in('id', userIds);
          setAppUserNames(Object.fromEntries((userRows ?? []).map((u: any) => [u.id, u.name])));
        }
      }
      setLoading(false);
    })();
  }, [allowed, tab]);

  if (allowed === null) return <main style={{ padding: 24 }}>載入中…</main>;
  if (allowed === false) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ fontSize: 13, color: '#A32D2D' }}>此頁僅系統管理員S、管理員A可以查看。</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>修正／解鎖紀錄</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        僅系統管理員S、管理員A看得到。分別是：導師/管理員對出缺勤紀錄的每一筆修改；教師對成績的每一筆新增/修改/刪除
        （含「鎖定又解開後」教師再次修改的內容）；以及「成績上傳時間設定表」裡，設定從「已鎖定」被重新打開的紀錄
        （含操作者與原因）。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setTab('attendance')}
          style={{
            fontSize: 13, padding: '6px 14px', borderRadius: 999, border: '1px solid #ccc',
            background: tab === 'attendance' ? '#2C2C2A' : '#fff', color: tab === 'attendance' ? '#fff' : '#2C2C2A',
          }}
        >
          出缺勤修改紀錄
        </button>
        <button
          onClick={() => setTab('score')}
          style={{
            fontSize: 13, padding: '6px 14px', borderRadius: 999, border: '1px solid #ccc',
            background: tab === 'score' ? '#2C2C2A' : '#fff', color: tab === 'score' ? '#fff' : '#2C2C2A',
          }}
        >
          成績修改紀錄
        </button>
        <button
          onClick={() => setTab('window')}
          style={{
            fontSize: 13, padding: '6px 14px', borderRadius: 999, border: '1px solid #ccc',
            background: tab === 'window' ? '#2C2C2A' : '#fff', color: tab === 'window' ? '#fff' : '#2C2C2A',
          }}
        >
          成績/出缺勤鎖定 解鎖紀錄
        </button>
      </div>

      {loadError && <p style={{ color: '#A32D2D', fontSize: 13, marginBottom: 12 }}>{loadError}</p>}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : tab === 'attendance' ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              {['修改時間', '學生', '日期／節次', '修改前', '修改後', '操作者'].map((h) => (
                <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {attRows.map((r) => {
              const info = attendanceInfo[r.attendance_id];
              return (
                <tr key={r.id}>
                  <td style={tdStyle}>{formatDateTime(r.changed_at)}</td>
                  <td style={tdStyle}>{info ? (studentNames[info.student_no] ?? info.student_no) : '（找不到，可能已刪除）'}</td>
                  <td style={tdStyle}>{info ? `${info.record_date} 第${info.period_no}節` : '—'}</td>
                  <td style={tdStyle}>{r.old_value ?? '（新增，原本沒有紀錄）'}</td>
                  <td style={tdStyle}>{r.new_value ?? '—'}</td>
                  <td style={tdStyle}>{r.changed_by ? (teacherNames[r.changed_by] ?? r.changed_by) : '管理員'}</td>
                </tr>
              );
            })}
            {attRows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#999' }}>目前沒有紀錄</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : tab === 'score' ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              {['修改時間', '學生', '考試類型／科目', '修改前', '修改後', '操作者'].map((h) => (
                <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scoreRows.map((r) => {
              const info = scoreInfo[r.score_id];
              return (
                <tr key={r.id}>
                  <td style={tdStyle}>{formatDateTime(r.changed_at)}</td>
                  <td style={tdStyle}>{info ? (scoreStudentNames[info.student_no] ?? info.student_no) : '（找不到，可能已刪除）'}</td>
                  <td style={tdStyle}>{info ? `${info.exam_type}／${info.subject}` : '—'}</td>
                  <td style={tdStyle}>{r.old_value ?? '（新增，原本沒有分數）'}</td>
                  <td style={tdStyle}>{r.new_value ?? '（已刪除）'}</td>
                  <td style={tdStyle}>{r.changed_by ? (teacherNames[r.changed_by] ?? r.changed_by) : '管理員'}</td>
                </tr>
              );
            })}
            {scoreRows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#999' }}>目前沒有紀錄</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              {['解鎖時間', '學年/學期', '類別', '範圍', '原因', '操作者'].map((h) => (
                <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {winRows.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>{formatDateTime(r.changed_at)}</td>
                <td style={tdStyle}>{r.academic_year} {r.term}</td>
                <td style={tdStyle}>{r.data_type}</td>
                <td style={tdStyle}>{r.scope}／{r.scope_ref || '（全校）'}</td>
                <td style={tdStyle}>{r.reason || '（未填寫原因）'}</td>
                <td style={tdStyle}>{r.changed_by ? (appUserNames[r.changed_by] ?? r.changed_by) : '（不明）'}</td>
              </tr>
            ))}
            {winRows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: '#999' }}>目前沒有紀錄</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}

const tdStyle: React.CSSProperties = { border: '1px solid #eee', padding: 6 };
