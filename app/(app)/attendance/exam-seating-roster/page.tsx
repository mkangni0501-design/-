'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import { resolveCurrentTerm } from '@/lib/academicTerm';
import { shuffleArray } from '@/lib/examSeating';

// 導師【輸入考場名單】頁。對應附件「考場.txt」的導師步驟1~4：
//   1. 收到【發送考場表】通知後，可從通知連接到這頁
//   2. 可以看到自己班被分配到哪些考場：左側是所有學生座號/學號/名單，
//      右側表格第一列是各考場班級(人數)，第二列起需填入考生座號
//      （填入的學生會從左側名單中消失）
//   3. 可點選隨機分配，自動把左側名單學生填入各考場
//   4. 完成後點選【完成名單】，送出並鎖定，不得再更改
//
// 資料表設計與 RLS 見 sql/90exam_seating.sql：這頁只能讀寫「屬於自己導師班」
// 的 exam_room_seats（且只有 status='已發送' 的考試場次才讀得到），只能改
// student_no 這一欄，「完成名單」寫入 exam_class_submissions 之後就會被 RLS
// 擋下來不能再改（沒有解鎖的按鈕，要重新開放需教務處/系統管理員處理）。

type MyStudent = { studentNo: string; seatNo: number; name: string };
type SeatSlot = { id: string; examRoomId: string; seatRow: number; seatCol: number; studentNo: string | null };
type RoomColumn = { examRoomId: string; roomLabel: string; slots: SeatSlot[] };
type PeriodGroup = { periodId: string; periodName: string; submitted: boolean; rooms: RoomColumn[] };

export default function ExamSeatingRosterPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasHomeroom, setHasHomeroom] = useState(true);
  const [className, setClassName] = useState('');
  const [myClassId, setMyClassId] = useState('');

  const [students, setStudents] = useState<MyStudent[]>([]);
  const [periodGroups, setPeriodGroups] = useState<PeriodGroup[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  // 目前正在編輯的「格子 -> 學號」，只有選定的考試場次還沒送出時才會用到；
  // 送出過的場次直接照資料庫存的 studentNo 顯示為唯讀，不會進到這裡。
  const [draftBySlot, setDraftBySlot] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) {
        setLoading(false);
        return;
      }
      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).single();
      if (!teacherRow) {
        setHasHomeroom(false);
        setLoading(false);
        return;
      }
      const currentTerm = await resolveCurrentTerm();
      let clsQuery = supabase.from('classes').select('id, class_name, grade_level').eq('homeroom_teacher_id', teacherRow.id);
      if (currentTerm?.academic_year != null) clsQuery = clsQuery.eq('academic_year', currentTerm.academic_year);
      const { data: cls } = await clsQuery.maybeSingle();
      if (!cls) {
        setHasHomeroom(false);
        setLoading(false);
        return;
      }
      setMyClassId(cls.id);
      setClassName(`${cls.grade_level}${cls.class_name}`);

      // 我班目前的學生名單（在學、未被隱藏），左側名單用
      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('student_no, seat_no')
        .eq('class_id', cls.id)
        .eq('is_current', true)
        .order('seat_no');
      const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
      const [{ data: nameRows }, hidden] = await Promise.all([
        studentNos.length === 0 ? Promise.resolve({ data: [] as any[] }) : supabase.from('students').select('student_no, name').in('student_no', studentNos),
        getHiddenStudentNos(studentNos),
      ]);
      const nameByNo = new Map((nameRows ?? []).map((s: any) => [s.student_no, s.name]));
      setStudents(
        (enrollRows ?? [])
          .filter((r: any) => !hidden.has(r.student_no))
          .map((r: any) => ({ studentNo: r.student_no, seatNo: r.seat_no, name: nameByNo.get(r.student_no) ?? '（查無姓名）' }))
      );

      await loadSeatData(cls.id);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSeatData(classId: string) {
    const { data: seatRows, error: seatErr } = await supabase
      .from('exam_room_seats')
      .select('id, exam_room_id, seat_row, seat_col, student_no')
      .eq('class_id', classId)
      .order('seat_row')
      .order('seat_col');
    if (seatErr) {
      setError('讀取考場座位失敗：' + seatErr.message);
      return;
    }
    const rows = seatRows ?? [];
    if (rows.length === 0) {
      setPeriodGroups([]);
      return;
    }
    const examRoomIds = Array.from(new Set(rows.map((r: any) => r.exam_room_id)));
    const { data: roomRows } = await supabase.from('exam_rooms').select('id, exam_period_id, room_class_id').in('id', examRoomIds);
    const roomClassIds = Array.from(new Set((roomRows ?? []).map((r: any) => r.room_class_id)));
    const periodIds = Array.from(new Set((roomRows ?? []).map((r: any) => r.exam_period_id)));
    const [{ data: roomClassRows }, { data: periodRows }, { data: subRows }] = await Promise.all([
      roomClassIds.length === 0 ? Promise.resolve({ data: [] as any[] }) : supabase.from('classes').select('id, grade_level, class_name').in('id', roomClassIds),
      periodIds.length === 0 ? Promise.resolve({ data: [] as any[] }) : supabase.from('exam_periods').select('id, name').in('id', periodIds),
      supabase.from('exam_class_submissions').select('exam_period_id').eq('class_id', classId),
    ]);
    const roomClassLabel = new Map((roomClassRows ?? []).map((c: any) => [c.id, `${c.grade_level}${c.class_name}`]));
    const periodName = new Map((periodRows ?? []).map((p: any) => [p.id, p.name]));
    const submittedPeriodIds = new Set((subRows ?? []).map((s: any) => s.exam_period_id));
    const roomInfo = new Map((roomRows ?? []).map((r: any) => [r.id, r]));

    const groups = new Map<string, PeriodGroup>();
    rows.forEach((seat: any) => {
      const room = roomInfo.get(seat.exam_room_id);
      if (!room) return;
      const pid = room.exam_period_id;
      if (!groups.has(pid)) {
        groups.set(pid, { periodId: pid, periodName: periodName.get(pid) ?? '（不明考試）', submitted: submittedPeriodIds.has(pid), rooms: [] });
      }
      const group = groups.get(pid)!;
      let roomCol = group.rooms.find((rc) => rc.examRoomId === seat.exam_room_id);
      if (!roomCol) {
        roomCol = { examRoomId: seat.exam_room_id, roomLabel: roomClassLabel.get(room.room_class_id) ?? '（不明教室）', slots: [] };
        group.rooms.push(roomCol);
      }
      roomCol.slots.push({ id: seat.id, examRoomId: seat.exam_room_id, seatRow: seat.seat_row, seatCol: seat.seat_col, studentNo: seat.student_no });
    });
    const groupList = Array.from(groups.values());
    setPeriodGroups(groupList);
    setSelectedPeriodId((prev) => (prev && groups.has(prev) ? prev : groupList.find((g) => !g.submitted)?.periodId ?? groupList[0]?.periodId ?? ''));
  }

  const selectedGroup = periodGroups.find((g) => g.periodId === selectedPeriodId) ?? null;

  // 切換考試場次時，把目前已存在的 student_no 帶入草稿（還沒送出的場次才需要草稿；
  // 已送出的直接顯示資料庫的值，唯讀）。
  useEffect(() => {
    if (!selectedGroup || selectedGroup.submitted) {
      setDraftBySlot({});
      return;
    }
    const draft: Record<string, string> = {};
    selectedGroup.rooms.forEach((rc) => rc.slots.forEach((s) => {
      if (s.studentNo) draft[s.id] = s.studentNo;
    }));
    setDraftBySlot(draft);
  }, [selectedPeriodId]); // eslint-disable-line react-hooks/exhaustive-deps

  const usedStudentNos = useMemo(() => new Set(Object.values(draftBySlot).filter(Boolean)), [draftBySlot]);
  const availableStudents = useMemo(() => students.filter((s) => !usedStudentNos.has(s.studentNo)), [students, usedStudentNos]);

  function setSlot(slotId: string, studentNo: string) {
    setDraftBySlot((prev) => {
      const next = { ...prev };
      if (!studentNo) delete next[slotId];
      else next[slotId] = studentNo;
      return next;
    });
  }

  function handleRandomAssign() {
    if (!selectedGroup) return;
    const emptySlotIds: string[] = [];
    selectedGroup.rooms.forEach((rc) => rc.slots.forEach((s) => {
      if (!draftBySlot[s.id]) emptySlotIds.push(s.id);
    }));
    if (emptySlotIds.length === 0) return;
    const pool = shuffleArray(availableStudents).slice(0, emptySlotIds.length);
    setDraftBySlot((prev) => {
      const next = { ...prev };
      emptySlotIds.forEach((slotId, i) => {
        if (pool[i]) next[slotId] = pool[i].studentNo;
      });
      return next;
    });
  }

  async function handleSubmit() {
    if (!selectedGroup) return;
    const filledCount = Object.keys(draftBySlot).length;
    const totalSlots = selectedGroup.rooms.reduce((s, rc) => s + rc.slots.length, 0);
    const confirmMsg =
      filledCount < totalSlots
        ? `目前還有 ${totalSlots - filledCount} 個座位沒有填入學生，送出後將無法再修改，確定要送出嗎？`
        : '送出後將無法再修改，確定要送出嗎？';
    if (!confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    try {
      for (const rc of selectedGroup.rooms) {
        for (const slot of rc.slots) {
          const studentNo = draftBySlot[slot.id] ?? null;
          if (studentNo === (slot.studentNo ?? null)) continue; // 沒變動的格子不用重複寫入
          const { error: updErr } = await supabase.from('exam_room_seats').update({ student_no: studentNo }).eq('id', slot.id);
          if (updErr) throw new Error(updErr.message);
        }
      }
      const me = await getCurrentAppUser();
      const { error: subErr } = await supabase
        .from('exam_class_submissions')
        .insert({ exam_period_id: selectedGroup.periodId, class_id: myClassId, submitted_by: me?.id ?? null });
      if (subErr) throw new Error(subErr.message);
      setNotice('已完成名單並送出，這個考試場次的座位不能再修改。');
      await loadSeatData(myClassId);
    } catch (e: any) {
      setError('送出失敗：' + e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  if (!hasHomeroom) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>輸入考場名單</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（本頁僅提供導師使用）。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>輸入考場名單{className ? `（${className}）` : ''}</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        右側表格是本班被分配到的各考場座位，把左側學生填入對應的座位；填入的學生會從左側名單中消失。
      </p>

      {error && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}
      {notice && <p style={{ fontSize: 13, color: '#2D6A32', marginBottom: 12 }}>{notice}</p>}

      {periodGroups.length === 0 ? (
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有已發送、且本班有被分配到考場的考試場次。</p>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <select value={selectedPeriodId} onChange={(e) => setSelectedPeriodId(e.target.value)} style={{ fontSize: 13, padding: 4 }}>
              {periodGroups.map((g) => (
                <option key={g.periodId} value={g.periodId}>
                  {g.periodName}（{g.submitted ? '已送出' : '未送出'}）
                </option>
              ))}
            </select>
          </div>

          {selectedGroup && (
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {!selectedGroup.submitted && (
                <div style={{ minWidth: 200, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                  <h2 style={{ fontSize: 13, marginBottom: 8 }}>尚未分配（{availableStudents.length}）</h2>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 480, overflowY: 'auto' }}>
                    {availableStudents.map((s) => (
                      <li key={s.studentNo} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid #f5f5f5' }}>
                        {s.seatNo}號 {s.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ flex: 1, minWidth: 300 }}>
                {!selectedGroup.submitted && (
                  <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
                    <button onClick={handleRandomAssign} style={{ fontSize: 12, padding: '4px 10px' }}>
                      隨機分配
                    </button>
                    <button disabled={busy} onClick={handleSubmit} style={{ fontSize: 12, padding: '4px 10px', fontWeight: 'bold' }}>
                      完成名單
                    </button>
                  </div>
                )}
                {selectedGroup.submitted && <p style={{ fontSize: 12, color: '#2D6A32', marginBottom: 10 }}>已送出，無法再修改。</p>}

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {selectedGroup.rooms.map((rc) => (
                    <table key={rc.examRoomId} style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ border: '1px solid #ddd', padding: '4px 10px', background: '#f7f7f7' }}>
                            {rc.roomLabel}（{rc.slots.length}人）
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rc.slots.map((slot, i) => {
                          const currentNo = selectedGroup.submitted ? slot.studentNo ?? '' : draftBySlot[slot.id] ?? '';
                          const currentStudent = students.find((s) => s.studentNo === currentNo);
                          return (
                            <tr key={slot.id}>
                              <td style={{ border: '1px solid #ddd', padding: 4 }}>
                                {selectedGroup.submitted ? (
                                  currentStudent ? `${currentStudent.seatNo}號 ${currentStudent.name}` : currentNo ? currentNo : '（空）'
                                ) : (
                                  <select value={currentNo} onChange={(e) => setSlot(slot.id, e.target.value)} style={{ fontSize: 12, padding: 3, width: 150 }}>
                                    <option value="">（空）</option>
                                    {currentStudent && <option value={currentStudent.studentNo}>{currentStudent.seatNo}號 {currentStudent.name}</option>}
                                    {availableStudents.map((s) => (
                                      <option key={s.studentNo} value={s.studentNo}>
                                        {s.seatNo}號 {s.name}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
