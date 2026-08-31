'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { getSiteContentMap } from '@/lib/siteContent';
import { resolveCurrentTerm } from '@/lib/academicTerm';

type ClassSubjectOption = { class_id: string; subject: string; label: string; periodNos: number[] };
type StudentRow = { student_no: string; seat_no: number; name: string };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;

// 任課教師出席查詢：只能看到自己授課班級、自己教的那個科目所對應節次的出缺勤狀況，
// 不會看到同班其他科目/節次的紀錄（跟導師「學生出缺席登錄（一週）」頁面不同，那是全班全節次）。
export default function SubjectAttendanceViewPage() {
  const isMobile = useIsMobile();
  const [siteContent, setSiteContent] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<ClassSubjectOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noAssignment, setNoAssignment] = useState(false);

  useEffect(() => {
    getSiteContentMap().then(setSiteContent);
  }, []);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (!teacherRow) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }

      // 【2026-08 修正】原本沒有依學年學期篩選，會把過去學年度的任課紀錄也混進來，
      // 選單裡出現早已結束的班級/科目。改成只抓目前生效學年學期的任課紀錄。
      const currentTerm = await resolveCurrentTerm();
      let scheduleQuery = supabase
        .from('class_schedule')
        .select('class_id, subject, period_no, classes(grade_level, class_name)')
        .eq('teacher_id', teacherRow.id);
      if (currentTerm) scheduleQuery = scheduleQuery.eq('academic_year', currentTerm.academic_year).eq('term', currentTerm.term);
      const { data: scheduleRows, error } = await scheduleQuery;
      if (error) {
        setLoadError('讀取任課資料失敗：' + error.message);
        setLoading(false);
        return;
      }
      if (!scheduleRows || scheduleRows.length === 0) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }

      const grouped = new Map<string, ClassSubjectOption>();
      scheduleRows.forEach((r: any) => {
        const key = `${r.class_id}|${r.subject}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            class_id: r.class_id,
            subject: r.subject,
            label: `${r.classes?.grade_level ?? ''}${r.classes?.class_name ?? ''}－${r.subject}`,
            periodNos: [],
          });
        }
        const entry = grouped.get(key)!;
        if (!entry.periodNos.includes(r.period_no)) entry.periodNos.push(r.period_no);
      });
      const opts = Array.from(grouped.values());
      setOptions(opts);
      if (opts.length > 0) setSelectedKey(`${opts[0].class_id}|${opts[0].subject}`);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selectedKey) return;
    const opt = options.find((o) => `${o.class_id}|${o.subject}` === selectedKey);
    if (!opt) return;
    (async () => {
      setLoading(true);
      setLoadError(null);

      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('seat_no, student_no, students(name)')
        .eq('class_id', opt.class_id)
        .eq('is_current', true)
        .order('seat_no');
      if (enrollErr) {
        setLoadError('讀取學生名單失敗：' + enrollErr.message);
        setLoading(false);
        return;
      }
      const rows: StudentRow[] = (enrollRows ?? []).map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: r.students?.name ?? r.student_no,
      }));
      setStudents(rows);
      const studentNos = rows.map((r) => r.student_no);

      // 只查詢這個科目對應節次的出缺勤——RLS 本來就只會回傳任課教師自己教的節次，
      // 這裡再加上 period_no 篩選，是為了同一班若教超過一科時，不同科目的節次不會混在一起。
      const { data: attRows, error: attErr } = await supabase
        .from('attendance')
        .select('student_no, status')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__'])
        .in('period_no', opt.periodNos.length > 0 ? opt.periodNos : [-1]);
      if (attErr) {
        setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        setLoading(false);
        return;
      }
      const map: Record<string, Record<string, number>> = {};
      (attRows ?? []).forEach((r: any) => {
        map[r.student_no] = map[r.student_no] ?? {};
        map[r.student_no][r.status] = (map[r.student_no][r.status] ?? 0) + 1;
      });
      setSummary(map);
      setLoading(false);
    })();
  }, [selectedKey, options]);

  if (noAssignment) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>任課班級出席查詢</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有指派的任課班級/科目。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>任課班級出席查詢</h1>
      {isMobile ? (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>說明</summary>
          <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            {siteContent['page_hint.attendance_subject_view'] ?? '只會顯示您自己授課節次的出缺勤累計次數（累計至今），不包含同班其他科目/節次的紀錄。'}
          </p>
        </details>
      ) : (
        <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
          {siteContent['page_hint.attendance_subject_view'] ?? '只會顯示您自己授課節次的出缺勤累計次數（累計至今），不包含同班其他科目/節次的紀錄。'}
        </p>
      )}
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {options.length > 1 && (
        <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} style={{ padding: 8, marginBottom: 16, width: '100%', maxWidth: 320 }}>
          {options.map((o) => (
            <option key={`${o.class_id}|${o.subject}`} value={`${o.class_id}|${o.subject}`}>
              {o.label}
            </option>
          ))}
        </select>
      )}

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
