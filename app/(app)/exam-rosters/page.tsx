'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentTeacherId, getCurrentAppUser } from '@/lib/supabaseClient';
import { getMyDepartments, hasDepartment } from '@/lib/departments';
import ErrorBanner from '@/components/ErrorBanner';
import {
  ExamRoomSeatRow,
  listRoomSeats,
  upsertSeatStudent,
  submitClassRoster,
  bulkSubmitClassRosters,
  listRosterStatus,
  RosterStatus,
  listCurrentEnrollments,
  EnrollmentRow,
  escapeHtml,
  bulkRandomAssignClasses,
  randomAssignClass,
} from '@/lib/examSeating';

// ============================================================
// 【輸入考場名單】頁
// 導師：收到【考場通知】後，從通知連過來；左側為本班尚未安排的學生（座號/學號/姓名），
// 右側表格第一列為各考場（班級人數），第二列起為該考場屬於本班的座位，
// 由導師填入是哪位學生（原班座號）。可用【隨機分配】自動帶入，完成後按【完成名單】送出並鎖定。
// 管理員A、系統管理員S、教務處：可以直接代替任何一班的導師安排（不限自己帶的班）。
// ============================================================

type MyClass = { id: string; label: string };
type ExamSessionOption = { id: string; name: string; status: string };
type SessionClassOption = { id: string; label: string; submitted: boolean };

export default function ExamRostersPage() {
  const [myTeacherId, setMyTeacherId] = useState<string | null>(null);
  const [myClasses, setMyClasses] = useState<MyClass[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ExamSessionOption[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [isPrivileged, setIsPrivileged] = useState(false);
  const [allSessions, setAllSessions] = useState<ExamSessionOption[]>([]);
  const [adminSessionId, setAdminSessionId] = useState<string | null>(null);
  const [sessionClasses, setSessionClasses] = useState<SessionClassOption[]>([]);
  const [adminClassId, setAdminClassId] = useState<string | null>(null);
  const [selectedClassIds, setSelectedClassIds] = useState<Set<string>>(new Set());
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const me = await getCurrentAppUser();
      let privileged = false;
      if (me) {
        if (me.role === 'system_admin_s' || me.role === 'admin_a') {
          privileged = true;
        } else {
          const depts = await getMyDepartments(me.id);
          privileged = hasDepartment(depts, 'academic');
        }
      }
      setIsPrivileged(privileged);

      const teacherId = await getCurrentTeacherId();
      setMyTeacherId(teacherId);
      if (teacherId) {
        const { data: classes, error: classErr } = await supabase
          .from('classes')
          .select('id, grade_level, class_name, academic_year')
          .eq('homeroom_teacher_id', teacherId)
          .order('academic_year', { ascending: false });
        if (classErr) {
          setError('讀取班級資料失敗：' + classErr.message);
        } else {
          const options = (classes ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
          setMyClasses(options);
          if (options.length > 0) setClassId(options[0].id);
        }
      }

      if (privileged) {
        const { data: rows, error: sessErr } = await supabase
          .from('exam_sessions')
          .select('id, name, status')
          .in('status', ['已發送', '已完成'])
          .order('created_at', { ascending: false });
        if (sessErr) {
          setError('讀取考試清單失敗：' + sessErr.message);
        } else {
          const opts = (rows ?? []).map((s: any) => ({ id: s.id, name: s.name, status: s.status }));
          setAllSessions(opts);
          if (opts.length > 0) setAdminSessionId(opts[0].id);
        }
      }

      setLoading(false);
    })();
  }, []);

  // ---- 導師視角：選了班級後，列出這個班有分配到考場的考試 ----
  useEffect(() => {
    if (!classId) {
      setSessions([]);
      setSessionId(null);
      return;
    }
    (async () => {
      setError(null);
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

  // ---- 管理員／教務視角：選了考試後，列出這次考試涉及的所有班級 ----
  async function reloadSessionClasses(examSessionId: string, keepSelection?: Set<string>) {
    setError(null);
    const { data, error: err } = await supabase
      .from('exam_class_roster_status')
      .select('class_id, submitted, classes(grade_level, class_name)')
      .eq('exam_session_id', examSessionId);
    if (err) {
      setError('讀取班級清單失敗：' + err.message);
      return;
    }
    const opts = (data ?? [])
      .map((r: any) => ({ id: r.class_id, label: `${r.classes?.grade_level ?? ''}${r.classes?.class_name ?? ''}`, submitted: !!r.submitted }))
      .sort((a: SessionClassOption, b: SessionClassOption) => a.label.localeCompare(b.label));
    setSessionClasses(opts);
    if (keepSelection) {
      // 重新整理後，已經被送出的班級要自動從勾選中移除（不能再對它們動作）
      setSelectedClassIds(new Set([...keepSelection].filter((id) => opts.find((o) => o.id === id && !o.submitted))));
    } else {
      setAdminClassId(opts.length > 0 ? opts[0].id : null);
      // 預設全選（尚未送出的班級），方便直接一鍵安排所有班級；已送出的班級不預設勾選，避免不小心蓋掉
      setSelectedClassIds(new Set(opts.filter((c) => !c.submitted).map((c) => c.id)));
    }
  }

  useEffect(() => {
    if (!adminSessionId) {
      setSessionClasses([]);
      setAdminClassId(null);
      setSelectedClassIds(new Set());
      return;
    }
    reloadSessionClasses(adminSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSessionId]);

  const allSelectableChecked = sessionClasses.filter((c) => !c.submitted).length > 0 && sessionClasses.filter((c) => !c.submitted).every((c) => selectedClassIds.has(c.id));

  function toggleSelectAll() {
    if (allSelectableChecked) {
      setSelectedClassIds(new Set());
    } else {
      setSelectedClassIds(new Set(sessionClasses.filter((c) => !c.submitted).map((c) => c.id)));
    }
  }

  function toggleOneClass(classId: string) {
    const next = new Set(selectedClassIds);
    if (next.has(classId)) next.delete(classId);
    else next.add(classId);
    setSelectedClassIds(next);
  }

  async function handleBulkAssign() {
    const targets = sessionClasses.filter((c) => selectedClassIds.has(c.id) && !c.submitted);
    if (targets.length === 0) {
      setError('請至少勾選一個尚未送出的班級');
      return;
    }
    if (!confirm(`確定要一鍵幫這 ${targets.length} 個班級隨機安排考場座位並直接送出名單嗎？已經安排過的座位不會被覆蓋，只會補上還空著的座位；全部學生都排到座位的班級會直接送出並鎖定，讓考試分班頁可以列印座位表／簽到表。`))
      return;
    setError(null);
    setBulkNotice(null);
    setBulkAssigning(true);
    try {
      const results = await bulkRandomAssignClasses(adminSessionId!, targets.map((c) => c.id), myTeacherId);
      const totalAssigned = results.reduce((s, r) => s + r.assigned, 0);
      const fullyAssigned = results.filter((r) => r.remainingUnassigned === 0);
      const incomplete = results.filter((r) => r.remainingUnassigned > 0);
      if (fullyAssigned.length > 0) {
        await bulkSubmitClassRosters(adminSessionId!, fullyAssigned.map((r) => r.classId), myTeacherId);
      }
      const labelOf = (classId: string) => sessionClasses.find((c) => c.id === classId)?.label ?? classId;
      const parts = [`已為 ${targets.length} 個班級安排座位，共安排 ${totalAssigned} 位學生。`];
      if (fullyAssigned.length > 0) parts.push(`已直接送出並鎖定 ${fullyAssigned.length} 個班級：${fullyAssigned.map((r) => labelOf(r.classId)).join('、')}。`);
      if (incomplete.length > 0) {
        parts.push(
          `以下班級人數比座位多、還有學生沒有座位，未自動送出，請確認後手動處理：${incomplete
            .map((r) => `${labelOf(r.classId)}（還差${r.remainingUnassigned}人）`)
            .join('、')}。`
        );
      }
      setBulkNotice(parts.join(' '));
      setRefreshTick((t) => t + 1);
      await reloadSessionClasses(adminSessionId!, selectedClassIds);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBulkAssigning(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>輸入考場名單</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        收到考場通知後，在這裡把班級學生填入分配到的考場座位。填完後按【完成名單】送出，送出後即鎖定不得再修改。
      </p>
      <ErrorBanner message={error} />

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          {isPrivileged && (
            <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, marginBottom: 8 }}>管理員／教務處：代替導師安排</h2>
              {allSessions.length === 0 ? (
                <p style={{ fontSize: 13, color: '#999' }}>目前沒有已發送的考場表。</p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select value={adminSessionId ?? ''} onChange={(e) => setAdminSessionId(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
                      {allSessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {sessionClasses.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6, fontWeight: 600 }}>
                        <input type="checkbox" checked={allSelectableChecked} onChange={toggleSelectAll} />
                        全選（未送出的班級）
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 4, maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 8 }}>
                        {sessionClasses.map((c) => (
                          <label key={c.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, color: c.submitted ? '#999' : '#333' }}>
                            <input type="checkbox" checked={selectedClassIds.has(c.id)} disabled={c.submitted} onChange={() => toggleOneClass(c.id)} />
                            <button
                              onClick={() => setAdminClassId(c.id)}
                              style={{ fontSize: 12, background: 'none', border: 'none', padding: 0, textDecoration: adminClassId === c.id ? 'underline' : 'none', cursor: 'pointer', color: 'inherit' }}
                            >
                              {c.label}
                              {c.submitted ? '（已送出）' : ''}
                            </button>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <button onClick={handleBulkAssign} disabled={bulkAssigning} style={{ fontSize: 13, padding: '5px 14px', fontWeight: 600 }}>
                          {bulkAssigning ? '安排中…' : `一鍵安排所選班級（${selectedClassIds.size}）`}
                        </button>
                        <span style={{ fontSize: 11, color: '#999' }}>點班級名稱可以在下面打開該班詳細畫面逐一調整。</span>
                      </div>
                      {bulkNotice && <p style={{ fontSize: 12, color: '#2D6A2D', marginTop: 6 }}>{bulkNotice}</p>}
                    </div>
                  )}

                  {adminSessionId && adminClassId && (
                    <ClassRosterEditor
                      key={`${adminSessionId}-${adminClassId}-${refreshTick}`}
                      classId={adminClassId}
                      sessionId={adminSessionId}
                      teacherId={myTeacherId}
                      sessionName={allSessions.find((s) => s.id === adminSessionId)?.name ?? ''}
                      classLabel={sessionClasses.find((c) => c.id === adminClassId)?.label ?? ''}
                    />
                  )}
                </>
              )}
            </section>
          )}

          {myClasses.length > 0 && (
            <section>
              {isPrivileged && <h2 style={{ fontSize: 14, marginBottom: 8 }}>我的班級</h2>}
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
                sessionId && (
                  <ClassRosterEditor
                    key={`${classId}-${sessionId}`}
                    classId={classId}
                    sessionId={sessionId}
                    teacherId={myTeacherId}
                    sessionName={sessions.find((s) => s.id === sessionId)?.name ?? ''}
                    classLabel={myClasses.find((c) => c.id === classId)?.label ?? ''}
                  />
                )
              )}
            </section>
          )}

          {!isPrivileged && myClasses.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>這個帳號沒有帶班紀錄，也沒有代管考場名單的權限。</p>}
        </>
      )}
    </main>
  );
}

function ClassRosterEditor({
  classId,
  sessionId,
  teacherId,
  sessionName,
  classLabel,
}: {
  classId: string;
  sessionId: string;
  teacherId: string | null;
  sessionName: string;
  classLabel: string;
}) {
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

      const enrollRows = await listCurrentEnrollments(classId);
      setEnrollments(enrollRows);

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
      const result = await randomAssignClass(sessionId, classId, teacherId);
      setNotice(`已隨機分配 ${result.assigned} 位學生`);
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
    const classLabelValue = classLabel || '本班';
    const rows = roomGroups
      .flatMap((g) => g.seats.map((s) => ({ room: g.roomName, seatNo: s.seat_no, seatNoClass: s.exam_seat_students?.class_seat_no, studentNo: s.exam_seat_students?.student_no })))
      .sort((a, b) => (a.seatNoClass ?? 0) - (b.seatNoClass ?? 0))
      .map((r) => {
        const name = enrollments.find((e) => e.student_no === r.studentNo)?.name ?? '';
        return `<tr><td>${escapeHtml(classLabelValue)}</td><td>${escapeHtml(r.seatNoClass ?? '')}</td><td>${escapeHtml(r.studentNo ?? '')}</td><td>${escapeHtml(
          name
        )}</td><td>${escapeHtml(r.room)}</td><td></td></tr>`;
      })
      .join('');
    w.document.write(`
      <html><head><title>${escapeHtml(sessionName)}－座位表</title>
      <style>
        @page { size: A4; margin: 12mm; }
        body{font-family:sans-serif;padding:0;font-size:12px;}
        h1{font-size:16px;margin:0 0 10px;}
        table{border-collapse:collapse;width:100%;margin-top:4px;}
        td,th{border:1px solid #999;padding:4px 8px;font-size:11px;text-align:center;}
      </style></head><body>
      <h1>${escapeHtml(sessionName)}（依原班座號排序）</h1>
      <table><thead><tr><th>班級</th><th>原班座號</th><th>學號</th><th>姓名</th><th>考場</th><th>簽名</th></tr></thead>
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
        <p style={{ fontSize: 13, color: '#999' }}>這個班還沒有分配到任何考場座位。</p>
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
