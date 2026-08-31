'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentTeacherId } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { resolveCurrentTerm } from '@/lib/academicTerm';

type ClubOption = { id: string; name: string };
type MemberRow = { student_no: string; name: string; class_label: string; seat_no: number | null };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;

function todayStr() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 社團點名冊：社團老師登入後只看得到自己指導的社團（跨班級/科系的學生名單），
// 依規格書 2.1，橫向顯示【學號】【原班級】【原座號】【姓名】，逐日點名。
export default function ClubRosterPage() {
  const isMobile = useIsMobile();
  const [clubs, setClubs] = useState<ClubOption[]>([]);
  const [selectedClubId, setSelectedClubId] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [recordDate, setRecordDate] = useState(todayStr());
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [noAssignment, setNoAssignment] = useState(false);
  const [term, setTerm] = useState<{ academic_year: number; term: string } | null>(null);

  useEffect(() => {
    (async () => {
      const teacherId = await getCurrentTeacherId();
      if (!teacherId) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }
      const t = await resolveCurrentTerm();
      setTerm(t);
      let q = supabase.from('clubs').select('id, name').eq('teacher_id', teacherId).eq('is_active', true);
      if (t) q = q.eq('academic_year', t.academic_year).eq('term', t.term);
      const { data, error: clubErr } = await q.order('name');
      if (clubErr) {
        setError('讀取社團資料失敗：' + clubErr.message);
        setLoading(false);
        return;
      }
      if (!data || data.length === 0) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }
      setClubs(data as ClubOption[]);
      setSelectedClubId(data[0].id);
      setLoading(false);
    })();
  }, []);

  async function loadMembersAndAttendance(clubId: string, date: string) {
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    const { data: memberRows, error: memberErr } = await supabase
      .from('club_members')
      .select('student_no, status, students(name), enrollments(seat_no, term, classes(grade_level, class_name, academic_year))')
      .eq('club_id', clubId)
      .eq('status', '在社');
    if (memberErr) {
      setError('讀取社團名單失敗：' + memberErr.message);
      setLoading(false);
      return;
    }
    const rows: MemberRow[] = (memberRows ?? []).map((r: any) => {
      const enrollmentList = Array.isArray(r.enrollments) ? r.enrollments : r.enrollments ? [r.enrollments] : [];
      const currentEnrollment = term ? enrollmentList.find((e: any) => e?.term === term.term && e?.classes?.academic_year === term.academic_year) ?? null : enrollmentList[0] ?? null;
      return {
        student_no: r.student_no,
        name: r.students?.name ?? r.student_no,
        class_label: currentEnrollment ? `${currentEnrollment.classes?.grade_level ?? ''}${currentEnrollment.classes?.class_name ?? ''}` : '－',
        seat_no: currentEnrollment?.seat_no ?? null,
      };
    });
    rows.sort((a, b) => a.class_label.localeCompare(b.class_label) || (a.seat_no ?? 0) - (b.seat_no ?? 0));
    setMembers(rows);

    const studentNos = rows.map((r) => r.student_no);
    const { data: attRows } = await supabase
      .from('club_attendance')
      .select('student_no, status')
      .eq('club_id', clubId)
      .eq('record_date', date)
      .in('student_no', studentNos.length > 0 ? studentNos : ['__none__']);
    const map: Record<string, string> = {};
    rows.forEach((r) => (map[r.student_no] = '出席')); // 預設出席，符合規格書「出席（預設）」
    (attRows ?? []).forEach((r: any) => (map[r.student_no] = r.status));
    setStatusMap(map);
    setLoading(false);
  }

  useEffect(() => {
    if (selectedClubId) loadMembersAndAttendance(selectedClubId, recordDate);
  }, [selectedClubId, recordDate]);

  async function saveAttendance() {
    setSaving(true);
    setError(null);
    setSaveMsg(null);
    const teacherId = await getCurrentTeacherId();
    const rowsToUpsert = members.map((m) => ({
      club_id: selectedClubId,
      student_no: m.student_no,
      record_date: recordDate,
      status: statusMap[m.student_no] ?? '出席',
      recorded_by: teacherId,
    }));
    const { error: upsertErr } = await supabase.from('club_attendance').upsert(rowsToUpsert, { onConflict: 'club_id,student_no,record_date' });
    if (upsertErr) {
      setError('點名紀錄儲存失敗：' + upsertErr.message);
    } else {
      setSaveMsg(`已儲存 ${recordDate} 的點名紀錄（共 ${rowsToUpsert.length} 位學生）`);
    }
    setSaving(false);
  }

  if (noAssignment) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16 }}>社團點名冊</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有指派給您的社團，如有需要請洽教務處。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>社團點名冊</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>選擇社團與日期後，逐位學生點選出缺勤狀態，最後按「儲存點名」送出。</p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {clubs.length > 1 && (
          <select value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)} style={{ padding: 8 }}>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={{ padding: 8 }} />
      </div>

      {error && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}
      {saveMsg && <p style={{ fontSize: 13, color: '#2D7A3A', marginBottom: 12 }}>{saveMsg}</p>}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>原班級</th>
                <th style={{ textAlign: 'left', padding: 6 }}>原座號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                <th style={{ textAlign: 'left', padding: 6 }}>點名狀態</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.student_no} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{m.student_no}</td>
                  <td style={{ padding: 6 }}>{m.class_label}</td>
                  <td style={{ padding: 6 }}>{m.seat_no ?? '－'}</td>
                  <td style={{ padding: 6 }}>{m.name}</td>
                  <td style={{ padding: 6 }}>
                    <select
                      value={statusMap[m.student_no] ?? '出席'}
                      onChange={(e) => setStatusMap({ ...statusMap, [m.student_no]: e.target.value })}
                      style={{ padding: 4 }}
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    這個社團目前沒有在社學生
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <button onClick={saveAttendance} disabled={saving || members.length === 0} style={{ padding: '8px 20px' }}>
            {saving ? '儲存中…' : '儲存點名'}
          </button>
        </>
      )}
    </main>
  );
}
