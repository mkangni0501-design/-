'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentTeacherId } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';
import { ExamRoomSeatRow, listRoomSeats, upsertSeatStudent, submitClassRoster, listRosterStatus, RosterStatus } from '@/lib/examSeating';

// ============================================================
// 導師【輸入考場名單】頁
// 收到【考場通知】後，從通知連過來；左側為本班尚未安排的學生（座號/學號/姓名），
// 右側表格第一列為各考場（班級人數），第二列起為該考場屬於本班的座位，
// 由導師填入是哪位學生（原班座號）。可用【隨機分配】自動帶入，完成後按【完成名單】送出並鎖定。
// ============================================================

type MyClass = { id: string; label: string };
type ExamSessionOption = { id: string; name: string; status: string };
type EnrollmentRow = { student_no: string; seat_no: number | null; name: string };

export default function ExamRostersPage() {
  const [myTeacherId, setMyTeacherId] = useState<string | null>(null);
  const [myClasses, setMyClasses] = useState<MyClass[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ExamSessionOption[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const teacherId = await getCurrentTeacherId();
      setMyTeacherId(teacherId);
      if (!teacherId) {
        setLoading(false);
        return;
      }
      const { data: classes, error: classErr } = await supabase
        .from('classes')
        .select('id, grade_level, class_name, academic_year')
        .eq('homeroom_teacher_id', teacherId)
        .order('academic_year', { ascending: false });
      if (classErr) {
        setError('讀取班級資料失敗：' + classErr.message);
        setLoading(false);
        return;
      }
      const options = (classes ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
      setMyClasses(options);
      if (options.length > 0) setClassId(options[0].id);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!classId) {
      setSessions([]);
      setSessionId(null);
      return;
    }
    (async () => {
      setError(null);
      // 只列出「已分配到考場」且考場表已發送/已完成的考試
      const { data: rows, error: err } = await supabase
        .from('exam_class_roster_status')
        .select('exam_session_id, exam_sessions(id, name, status)')
        .eq('class_id', classId);
      if (err) {
        setError('讀取考試清單失敗：' + err.message);
        return;
      }
      const opts = (rows ?? [])
        .map((r: any) => r.exam_sessions)
        .filter((s: any) => s && (s.status === '已發送' || s.status === '已完成'))
        .map((s: any) => ({ id: s.id, name: s.name, status: s.status }));
      setSessions(opts);
      setSessionId(opts.length > 0 ? opts[0].id : null);
    })();
  }, [classId]);

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>輸入考場名單</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        收到考場通知後，在這裡把本班學生填入分配到的考場座位。填完後按【完成名單】送出，送出後即鎖定不得再修改。
      </p>
      <ErrorBanner message={error} />

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : !myTeacherId ? (
        <p style={{ fontSize: 13, color: '#999' }}>這個帳號沒有連結教師資料。</p>
      ) : myClasses.length === 0 ? (
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有帶班紀錄。</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            {myClasses.length > 1 && (
              <select value={classId ?? ''} onChange={(e) => setClassId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
                {myClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            {sessions.length > 1 && (
              <select value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {sessions.length === 0 ? (
            <p style={{ fontSize: 13, color: '#999' }}>目前沒有已發送的考場表。</p>
          ) : (
            classId &&
            sessionId && <ClassRosterEditor classId={classId} sessionId={sessionId} teacherId={myTeacherId} sessionName={sessions.find((s) => s.id === sessionId)?.name ?? ''} />
          )}
        </>
      )}
    </main>
  );
}

function ClassRosterEditor({ classId, sessionId, teacherId, sessionName }: { classId: string; sessionId: string; teacherId: string; sessionName: string }) {
  const [roomGroups, setRoomGroups] = useState<{ roomId: string; roomName: string; seats: ExamRoomSeatRow[] }[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const { data: rooms, error: roomErr } = await supabase
        .from('exam_rooms')
        .select('id, room_name')
        .eq('exam_session_id', sessionId);
      if (roomErr) throw new Error('讀取考場失敗：' + roomErr.message);

      const groups: { roomId: string; roomName: string; seats: ExamRoomSeatRow[] }[] = [];
      for (const room of rooms ?? []) {
        const seats = await listRoomSeats(room.id);
        const mine = seats.filter((s) => s.class_id === classId);
        if (mine.length > 0) groups.push({ roomId: room.id, roomName: (room as any).room_name, seats: mine });
      }
      setRoomGroups(groups);

      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('student_no, seat_no, students(name)')
        .eq('class_id', classId)
        .eq('is_current', true)
        .order('seat_no');
      if (enrollErr) throw new Error('讀取學生名冊失敗：' + enrollErr.message);
      setEnrollments((enrollRows ?? []).map((r: any) => ({ student_no: r.student_no, seat_no: r.seat_no, name: r.students?.name ?? '' })));

      const statuses = await listRosterStatus(sessionId);
      setSubmitted(!!statuses.find((s: RosterStatus) => s.class_id === classId)?.submitted);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, sessionId]);

  const assignedStudentNos = useMemo(() => {
    const set = new Set<string>();
    for (const g of roomGroups) for (const s of g.seats) if (s.exam_seat_students?.student_no) set.add(s.exam_seat_students.student_no);
    return set;
  }, [roomGroups]);

  const unassigned = enrollments.filter((e) => !assignedStudentNos.has(e.student_no));

  async function assignSeat(examRoomSeatId: string, studentNo: string | null) {
    setError(null);
    const student = enrollments.find((e) => e.student_no === studentNo) ?? null;
    try {
      await upsertSeatStudent(examRoomSeatId, studentNo, student?.seat_no ?? null, teacherId);
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function randomAssign() {
    setError(null);
    try {
      const emptySeatIds: string[] = [];
      for (const g of roomGroups) for (const s of g.seats) if (!s.exam_seat_students?.student_no) emptySeatIds.push(s.id);
      const shuffled = [...unassigned].sort(() => Math.random() - 0.5);
      const n = Math.min(emptySeatIds.length, shuffled.length);
      for (let i = 0; i < n; i++) {
        await upsertSeatStudent(emptySeatIds[i], shuffled[i].student_no, shuffled[i].seat_no, teacherId);
      }
      setNotice('已隨機分配');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function finish() {
    if (unassigned.length > 0 && !confirm(`還有 ${unassigned.length} 位學生尚未安排座位，確定要送出名單嗎？`)) return;
    if (!confirm('送出後名單將鎖定，不得再修改，確定送出嗎？')) return;
    setError(null);
    try {
      await submitClassRoster(sessionId, classId, teacherId);
      setNotice('已送出名單');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  function handlePrint() {
    const w = window.open('', '_blank');
    if (!w) return;
    const rows = roomGroups
      .flatMap((g) => g.seats.map((s) => ({ room: g.roomName, seatNo: s.seat_no, seatNoClass: s.exam_seat_students?.class_seat_no, studentNo: s.exam_seat_students?.student_no })))
      .map((r) => {
        const name = enrollments.find((e) => e.student_no === r.studentNo)?.name ?? '';
        return `<tr><td>${r.room}</td><td>${r.seatNo}</td><td>${r.seatNoClass ?? ''}</td><td>${r.studentNo ?? ''}</td><td>${name}</td></tr>`;
      })
      .join('');
    w.document.write(`
      <html><head><title>${sessionName}－座位表</title>
      <style>body{font-family:sans-serif;padding:24px;}table{border-collapse:collapse;width:100%;margin-top:12px;}
      td,th{border:1px solid #999;padding:6px 10px;font-size:13px;text-align:center;}</style></head><body>
      <h1 style="font-size:18px;">${sessionName}</h1>
      <table><thead><tr><th>考場</th><th>考場座位號</th><th>原班座號</th><th>學號</th><th>姓名</th></tr></thead>
      <tbody>${rows}</tbody></table></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  if (loading) return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;

  return (
    <div>
      <ErrorBanner message={error} />
      {notice && <p style={{ fontSize: 13, color: '#2D6A2D', marginBottom: 8 }}>{notice}</p>}
      {submitted && (
        <p style={{ fontSize: 13, color: '#2D6A2D', background: '#EEF7EE', border: '1px solid #CFE8CF', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          名單已送出並鎖定，如需修改請聯繫教務處。
        </p>
      )}
      {roomGroups.length === 0 ? (
        <p style={{ fontSize: 13, color: '#999' }}>本班尚未分配到任何考場座位。</p>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>尚未安排（{unassigned.length}人）</h3>
            <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 8, maxHeight: 420, overflowY: 'auto', fontSize: 12 }}>
              {unassigned.length === 0 ? <p style={{ color: '#999' }}>已全部安排完畢</p> : unassigned.map((e) => <div key={e.student_no}>座號{e.seat_no}　{e.name}</div>)}
            </div>
            {!submitted && (
              <button onClick={randomAssign} style={{ fontSize: 12, padding: '4px 10px', marginTop: 8 }}>
                隨機分配
              </button>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 320 }}>
            {roomGroups.map((g) => (
              <div key={g.roomId} style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, marginBottom: 6 }}>
                  {g.roomName}（本班 {g.seats.length} 人）
                </h3>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={cellStyle}>考場座位號</th>
                      <th style={cellStyle}>學生（原班座號）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.seats.map((seat) => (
                      <tr key={seat.id}>
                        <td style={cellStyle}>#{seat.seat_no}</td>
                        <td style={cellStyle}>
                          <select
                            value={seat.exam_seat_students?.student_no ?? ''}
                            disabled={submitted}
                            onChange={(e) => assignSeat(seat.id, e.target.value || null)}
                            style={{ fontSize: 12, padding: '2px 6px' }}
                          >
                            <option value="">（未安排）</option>
                            {enrollments
                              .filter((en) => !assignedStudentNos.has(en.student_no) || en.student_no === seat.exam_seat_students?.student_no)
                              .map((en) => (
                                <option key={en.student_no} value={en.student_no}>
                                  座號{en.seat_no}　{en.name}
                                </option>
                              ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {!submitted ? (
          <button onClick={finish} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600 }}>
            完成名單
          </button>
        ) : (
          <button onClick={handlePrint} style={{ fontSize: 13, padding: '6px 16px' }}>
            列印本班座位表
          </button>
        )}
      </div>
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: '1px solid #eee', padding: '4px 8px', textAlign: 'center' };
