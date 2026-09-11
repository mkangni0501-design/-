'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { hasDepartment } from '@/lib/departments';
import { resolveCurrentTerm } from '@/lib/academicTerm';
import {
  ExamPeriod,
  ExamRoom,
  ExamRoomAllocation,
  ExamSeat,
  SEAT_GRID_SIZE,
  generateExamSeatLayout,
  averageAllocate,
  fetchCurrentClassHeadcount,
} from '@/lib/examSeating';

// 教務處【考試分班】頁。對應附件「考場.txt」的教務處步驟1~7：
//   1. 進【考試分班】頁
//   2. 點選考場（為目前有開設的所有班級，人數上限為此班級目前人數）
//   3. 選擇在該考場考試的班級數與班級（下拉式選單）
//   4. 輸入該班級在此考場的人數（依目前的班級數自動提供平均人數，可手動更改）
//   5. 用梅花座讓同班考生盡可能不相鄰（7*7）
//   6. 點選【確認】後儲存回到選擇考場的頁面
//   7. 所有考場都完成設定後點選【發送考場表】通知各班導師
// 步驟8「各班導師輸入完考試學生名單後，始可點選列印座位表及簽到表」在下方
// 「已發送」狀態區塊處理。
//
// 資料表設計與 RLS 見 sql/90exam_seating.sql；梅花座演算法與平均分配見 lib/examSeating.ts。
// 導師端對應頁面：app/(app)/attendance/exam-seating-roster/page.tsx。

type ClassOption = { id: string; label: string; homeroom_teacher_id: string | null };

type DraftAllocation = { key: string; classId: string; count: number };

let draftKeySeq = 0;
function newDraftKey() {
  draftKeySeq += 1;
  return `draft-${draftKeySeq}`;
}

export default function ExamSeatingPage() {
  const perms = useDepartmentPermissions();
  const canView = perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'academic');

  const [currentTerm, setCurrentTerm] = useState<{ academic_year: number; term: string } | null>(null);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [periods, setPeriods] = useState<ExamPeriod[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [newPeriodName, setNewPeriodName] = useState('');

  const [rooms, setRooms] = useState<ExamRoom[]>([]);
  const [allocationsByRoom, setAllocationsByRoom] = useState<Record<string, ExamRoomAllocation[]>>({});
  const [seatsByRoom, setSeatsByRoom] = useState<Record<string, ExamSeat[]>>({});
  const [submittedClassIds, setSubmittedClassIds] = useState<Set<string>>(new Set());
  const [studentNames, setStudentNames] = useState<Record<string, string>>({});

  const [newRoomClassId, setNewRoomClassId] = useState('');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [draftAllocations, setDraftAllocations] = useState<DraftAllocation[]>([]);
  const [printRoomId, setPrintRoomId] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<'seats' | 'signin' | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const classById = useMemo(() => new Map(classOptions.map((c) => [c.id, c])), [classOptions]);
  const selectedPeriod = useMemo(() => periods.find((p) => p.id === periodId) ?? null, [periods, periodId]);
  const isPeriodSent = selectedPeriod?.status === '已發送';

  useEffect(() => {
    (async () => {
      const term = await resolveCurrentTerm();
      if (!term) {
        setError('讀不到目前生效的學年度／學期，請先在「學年學期設定」確認。');
        setLoading(false);
        return;
      }
      setCurrentTerm(term);
      const { data: clsRows, error: clsErr } = await supabase
        .from('classes')
        .select('id, grade_level, class_name, homeroom_teacher_id')
        .eq('academic_year', term.academic_year)
        .order('grade_level')
        .order('class_name');
      if (clsErr) {
        setError('讀取班級清單失敗：' + clsErr.message);
        setLoading(false);
        return;
      }
      setClassOptions((clsRows ?? []).map((c: any) => ({ id: c.id, label: `${c.grade_level}${c.class_name}`, homeroom_teacher_id: c.homeroom_teacher_id })));

      const { data: periodRows, error: periodErr } = await supabase
        .from('exam_periods')
        .select('id, academic_year, term, name, status, created_at')
        .eq('academic_year', term.academic_year)
        .eq('term', term.term)
        .order('created_at', { ascending: false });
      if (periodErr) {
        setError('讀取考試場次失敗：' + periodErr.message);
        setLoading(false);
        return;
      }
      setPeriods((periodRows ?? []) as ExamPeriod[]);
      if (periodRows && periodRows.length > 0) setPeriodId(periodRows[0].id);
      setLoading(false);
    })();
  }, []);

  async function loadPeriodData(pid: string) {
    if (!pid) {
      setRooms([]);
      setAllocationsByRoom({});
      setSeatsByRoom({});
      setSubmittedClassIds(new Set());
      return;
    }
    const { data: roomRows, error: roomErr } = await supabase
      .from('exam_rooms')
      .select('id, exam_period_id, room_class_id, capacity, seats_confirmed')
      .eq('exam_period_id', pid)
      .order('created_at');
    if (roomErr) {
      setError('讀取考場清單失敗：' + roomErr.message);
      return;
    }
    const roomList = (roomRows ?? []) as ExamRoom[];
    setRooms(roomList);
    const roomIds = roomList.map((r) => r.id);

    const [{ data: allocRows }, { data: seatRows }, { data: subRows }] = await Promise.all([
      roomIds.length === 0
        ? Promise.resolve({ data: [] as any[] })
        : supabase.from('exam_room_class_allocations').select('id, exam_room_id, class_id, student_count').in('exam_room_id', roomIds),
      roomIds.length === 0
        ? Promise.resolve({ data: [] as any[] })
        : supabase.from('exam_room_seats').select('id, exam_room_id, seat_row, seat_col, class_id, student_no').in('exam_room_id', roomIds),
      supabase.from('exam_class_submissions').select('class_id').eq('exam_period_id', pid),
    ]);

    const allocGrouped: Record<string, ExamRoomAllocation[]> = {};
    (allocRows ?? []).forEach((a: any) => {
      allocGrouped[a.exam_room_id] = allocGrouped[a.exam_room_id] ?? [];
      allocGrouped[a.exam_room_id].push(a);
    });
    setAllocationsByRoom(allocGrouped);

    const seatGrouped: Record<string, ExamSeat[]> = {};
    (seatRows ?? []).forEach((s: any) => {
      seatGrouped[s.exam_room_id] = seatGrouped[s.exam_room_id] ?? [];
      seatGrouped[s.exam_room_id].push(s);
    });
    setSeatsByRoom(seatGrouped);

    setSubmittedClassIds(new Set((subRows ?? []).map((s: any) => s.class_id)));

    const studentNos = Array.from(new Set((seatRows ?? []).map((s: any) => s.student_no).filter(Boolean)));
    if (studentNos.length > 0) {
      const { data: nameRows } = await supabase.from('students').select('student_no, name').in('student_no', studentNos);
      const map: Record<string, string> = {};
      (nameRows ?? []).forEach((s: any) => {
        map[s.student_no] = s.name;
      });
      setStudentNames(map);
    } else {
      setStudentNames({});
    }
  }

  useEffect(() => {
    setOpenRoomId(null);
    loadPeriodData(periodId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  useEffect(() => {
    if (printMode && printRoomId) {
      const t = setTimeout(() => window.print(), 100);
      return () => clearTimeout(t);
    }
  }, [printMode, printRoomId]);

  useEffect(() => {
    function afterPrint() {
      setPrintMode(null);
      setPrintRoomId(null);
    }
    window.addEventListener('afterprint', afterPrint);
    return () => window.removeEventListener('afterprint', afterPrint);
  }, []);

  async function handleCreatePeriod() {
    if (!currentTerm || !newPeriodName.trim()) return;
    setBusy(true);
    setError(null);
    const me = await getCurrentAppUser();
    const { data, error: insErr } = await supabase
      .from('exam_periods')
      .insert({ academic_year: currentTerm.academic_year, term: currentTerm.term, name: newPeriodName.trim(), created_by: me?.id ?? null })
      .select('id, academic_year, term, name, status, created_at')
      .single();
    setBusy(false);
    if (insErr) {
      setError('新增考試場次失敗：' + insErr.message);
      return;
    }
    setPeriods((prev) => [data as ExamPeriod, ...prev]);
    setPeriodId(data.id);
    setNewPeriodName('');
  }

  async function handleAddRoom() {
    if (!newRoomClassId || !periodId) return;
    setBusy(true);
    setError(null);
    const headcount = await fetchCurrentClassHeadcount(newRoomClassId);
    const me = await getCurrentAppUser();
    const { data, error: insErr } = await supabase
      .from('exam_rooms')
      .insert({ exam_period_id: periodId, room_class_id: newRoomClassId, capacity: headcount, created_by: me?.id ?? null })
      .select('id, exam_period_id, room_class_id, capacity, seats_confirmed')
      .single();
    setBusy(false);
    if (insErr) {
      setError('新增考場失敗：' + (insErr.message.includes('duplicate') ? '這個班級教室已經是這個場次的考場' : insErr.message));
      return;
    }
    setRooms((prev) => [...prev, data as ExamRoom]);
    setNewRoomClassId('');
  }

  async function handleDeleteRoom(roomId: string) {
    if (!confirm('確定要刪除這個考場嗎？裡面已設定的班級分配與座位也會一併刪除。')) return;
    setBusy(true);
    const { error: delErr } = await supabase.from('exam_rooms').delete().eq('id', roomId);
    setBusy(false);
    if (delErr) {
      setError('刪除考場失敗：' + delErr.message);
      return;
    }
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    if (openRoomId === roomId) setOpenRoomId(null);
  }

  function openEditor(room: ExamRoom) {
    const existing = allocationsByRoom[room.id] ?? [];
    setDraftAllocations(
      existing.length > 0
        ? existing.map((a) => ({ key: newDraftKey(), classId: a.class_id, count: a.student_count }))
        : [{ key: newDraftKey(), classId: '', count: 0 }]
    );
    setOpenRoomId(room.id);
  }

  function addDraftRow() {
    setDraftAllocations((prev) => [...prev, { key: newDraftKey(), classId: '', count: 0 }]);
  }
  function removeDraftRow(key: string) {
    setDraftAllocations((prev) => prev.filter((r) => r.key !== key));
  }
  function updateDraftRow(key: string, patch: Partial<DraftAllocation>) {
    setDraftAllocations((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function applyAverage(room: ExamRoom) {
    const chosen = draftAllocations.filter((r) => r.classId);
    if (chosen.length === 0) return;
    const counts = averageAllocate(room.capacity, chosen.length);
    let i = 0;
    setDraftAllocations((prev) =>
      prev.map((r) => {
        if (!r.classId) return r;
        const c = counts[i];
        i += 1;
        return { ...r, count: c };
      })
    );
  }

  const draftTotal = draftAllocations.reduce((sum, r) => sum + (r.classId ? r.count : 0), 0);
  const draftPreviewLayout = useMemo(() => {
    const allocs = draftAllocations.filter((r) => r.classId && r.count > 0).map((r) => ({ classId: r.classId, count: r.count }));
    if (allocs.length === 0) return null;
    return generateExamSeatLayout(allocs);
  }, [draftAllocations]);

  async function handleConfirmRoom(room: ExamRoom) {
    const chosen = draftAllocations.filter((r) => r.classId && r.count > 0);
    if (chosen.length === 0) {
      setError('請至少選擇一個應試班級並輸入人數');
      return;
    }
    const classIdSet = new Set(chosen.map((r) => r.classId));
    if (classIdSet.size !== chosen.length) {
      setError('同一個考場裡，同一個應試班級不能重複選擇');
      return;
    }
    if (draftTotal > room.capacity) {
      setError(`分配人數總和（${draftTotal}）超過考場人數上限（${room.capacity}）`);
      return;
    }
    if (draftTotal > SEAT_GRID_SIZE * SEAT_GRID_SIZE) {
      setError(`分配人數總和（${draftTotal}）超過梅花座座位數上限（${SEAT_GRID_SIZE * SEAT_GRID_SIZE}）`);
      return;
    }
    setBusy(true);
    setError(null);

    const existing = allocationsByRoom[room.id] ?? [];
    const toDelete = existing.filter((a) => !classIdSet.has(a.class_id));
    if (toDelete.length > 0) {
      await supabase.from('exam_room_class_allocations').delete().in('id', toDelete.map((a) => a.id));
    }
    const { error: upsertAllocErr } = await supabase
      .from('exam_room_class_allocations')
      .upsert(
        chosen.map((r) => ({ exam_room_id: room.id, class_id: r.classId, student_count: r.count })),
        { onConflict: 'exam_room_id,class_id' }
      );
    if (upsertAllocErr) {
      setBusy(false);
      setError('儲存班級人數分配失敗：' + upsertAllocErr.message);
      return;
    }

    const layout = generateExamSeatLayout(chosen.map((r) => ({ classId: r.classId, count: r.count })));
    const { error: upsertSeatErr } = await supabase.from('exam_room_seats').upsert(
      layout.map((cell) => ({
        exam_room_id: room.id,
        seat_row: cell.row,
        seat_col: cell.col,
        class_id: cell.classId,
        student_no: null,
      })),
      { onConflict: 'exam_room_id,seat_row,seat_col' }
    );
    if (upsertSeatErr) {
      setBusy(false);
      setError('儲存梅花座座位失敗：' + upsertSeatErr.message);
      return;
    }

    const { error: updRoomErr } = await supabase.from('exam_rooms').update({ seats_confirmed: true }).eq('id', room.id);
    setBusy(false);
    if (updRoomErr) {
      setError('更新考場狀態失敗：' + updRoomErr.message);
      return;
    }
    setOpenRoomId(null);
    setNotice('已儲存這個考場的梅花座座位');
    await loadPeriodData(periodId);
  }

  const allRoomsConfirmed = rooms.length > 0 && rooms.every((r) => r.seats_confirmed);

  async function handleSendRoster() {
    if (!selectedPeriod || !allRoomsConfirmed) return;
    if (!confirm('確定要發送考場表嗎？發送後這個考試場次的考場設定將不能再修改。')) return;
    setBusy(true);
    setError(null);

    // 統整每個應試班級被分配到哪些考場（可能不只一個），組成一則通知訊息，
    // 而不是同一個班有好幾個考場就發好幾則各自獨立的通知（見 sql/90exam_seating.sql
    // 檔尾「刻意不用 trigger」的說明：這裡是前端手動、一次性發送）。
    const classRoomCounts = new Map<string, { roomLabel: string; count: number }[]>();
    rooms.forEach((room) => {
      const roomLabel = classById.get(room.room_class_id)?.label ?? '（找不到教室）';
      (allocationsByRoom[room.id] ?? []).forEach((a) => {
        const list = classRoomCounts.get(a.class_id) ?? [];
        list.push({ roomLabel, count: a.student_count });
        classRoomCounts.set(a.class_id, list);
      });
    });

    const notifyRows: { teacher_id: string; category: string; message: string; link_url: string }[] = [];
    classRoomCounts.forEach((rooms_, classId) => {
      const teacherId = classById.get(classId)?.homeroom_teacher_id;
      if (!teacherId) return;
      const classLabel = classById.get(classId)?.label ?? '';
      const detail = rooms_.map((r) => `${r.roomLabel}（${r.count}人）`).join('、');
      notifyRows.push({
        teacher_id: teacherId,
        category: '考場通知',
        message: `「${selectedPeriod.name}」考場表已發送：${classLabel}被分配到 ${detail}，請至「輸入考場名單」填入本班考生名單。`,
        link_url: '/attendance/exam-seating-roster',
      });
    });

    if (notifyRows.length > 0) {
      const { error: notifyErr } = await supabase.from('staff_notifications').insert(notifyRows);
      if (notifyErr) {
        setBusy(false);
        setError('發送通知失敗：' + notifyErr.message);
        return;
      }
    }
    const { error: updErr } = await supabase.from('exam_periods').update({ status: '已發送' }).eq('id', periodId);
    setBusy(false);
    if (updErr) {
      setError('更新考試場次狀態失敗：' + updErr.message);
      return;
    }
    setNotice(`已發送考場表，共通知 ${notifyRows.length} 個班級的導師`);
    setPeriods((prev) => prev.map((p) => (p.id === periodId ? { ...p, status: '已發送' } : p)));
  }

  function roomClassesSubmitted(room: ExamRoom): { classId: string; label: string; submitted: boolean }[] {
    const classIds = Array.from(new Set((seatsByRoom[room.id] ?? []).filter((s) => s.class_id).map((s) => s.class_id as string)));
    return classIds.map((cid) => ({ classId: cid, label: classById.get(cid)?.label ?? '（不明班級）', submitted: submittedClassIds.has(cid) }));
  }

  function canPrintRoom(room: ExamRoom): boolean {
    const statuses = roomClassesSubmitted(room);
    return statuses.length > 0 && statuses.every((s) => s.submitted);
  }

  if (loading) {
    return (
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  if (!canView) {
    return (
      <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>考試分班</h1>
        <p style={{ fontSize: 13, color: '#999' }}>這個功能僅開放教務處人員使用。</p>
      </main>
    );
  }

  const printRoom = printRoomId ? rooms.find((r) => r.id === printRoomId) ?? null : null;

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <style>{`@media print { .no-print { display: none !important; } .print-only { display: block !important; } }
        .print-only { display: none; }`}</style>

      <div className="no-print">
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>考試分班</h1>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
          設定考場（借用某個班級的教室）、分配應試班級人數、用梅花座（7×7）安排座位，全部考場都設定完成後發送考場表通知各班導師。
        </p>

        {error && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}
        {notice && (
          <p style={{ fontSize: 13, color: '#2D6A32', marginBottom: 12 }}>
            {notice}{' '}
            <button onClick={() => setNotice(null)} style={{ fontSize: 11 }}>
              關閉
            </button>
          </p>
        )}

        <section style={{ marginBottom: 20, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>考試場次</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} style={{ fontSize: 13, padding: 4 }}>
              <option value="">（尚未選擇）</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.status}）
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={newPeriodName}
              onChange={(e) => setNewPeriodName(e.target.value)}
              placeholder="新增考試場次名稱，例如「期中考」"
              style={{ fontSize: 13, padding: 4, flex: 1 }}
            />
            <button disabled={busy || !newPeriodName.trim()} onClick={handleCreatePeriod} style={{ fontSize: 13, padding: '4px 10px' }}>
              新增
            </button>
          </div>
        </section>

        {selectedPeriod && (
          <>
            {!isPeriodSent && (
              <section style={{ marginBottom: 20, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>新增考場</h2>
                <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                  考場借用目前有開設的某個班級的教室，人數上限＝該班目前人數。
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select value={newRoomClassId} onChange={(e) => setNewRoomClassId(e.target.value)} style={{ fontSize: 13, padding: 4 }}>
                    <option value="">（選擇班級教室）</option>
                    {classOptions
                      .filter((c) => !rooms.some((r) => r.room_class_id === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                  </select>
                  <button disabled={busy || !newRoomClassId} onClick={handleAddRoom} style={{ fontSize: 13, padding: '4px 10px' }}>
                    加入為考場
                  </button>
                </div>
              </section>
            )}

            <section style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, marginBottom: 8 }}>
                考場清單（{rooms.length} 個）
                {!isPeriodSent && rooms.length > 0 && (
                  <span style={{ fontSize: 12, color: allRoomsConfirmed ? '#2D6A32' : '#A32D2D', marginLeft: 8 }}>
                    {allRoomsConfirmed ? '全部考場已完成梅花座設定' : '尚有考場還沒完成梅花座設定'}
                  </span>
                )}
              </h2>
              {rooms.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>這個考試場次還沒有任何考場。</p>}
              {rooms.map((room) => {
                const roomLabel = classById.get(room.room_class_id)?.label ?? '（找不到教室）';
                const allocs = allocationsByRoom[room.id] ?? [];
                const assigned = allocs.reduce((s, a) => s + a.student_count, 0);
                const subs = roomClassesSubmitted(room);
                return (
                  <div key={room.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong style={{ fontSize: 13 }}>{roomLabel} 教室</strong>
                        <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>
                          容量上限 {room.capacity} 人，已分配 {assigned} 人（{allocs.length} 班）
                          {room.seats_confirmed ? '｜已排定座位' : '｜尚未排定座位'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {!isPeriodSent && (
                          <>
                            <button onClick={() => openEditor(room)} style={{ fontSize: 12, padding: '2px 8px' }}>
                              {room.seats_confirmed ? '重新設定' : '設定'}
                            </button>
                            <button onClick={() => handleDeleteRoom(room.id)} style={{ fontSize: 12, padding: '2px 8px', color: '#A32D2D' }}>
                              刪除
                            </button>
                          </>
                        )}
                        {isPeriodSent && room.seats_confirmed && (
                          <>
                            <button
                              disabled={!canPrintRoom(room)}
                              title={canPrintRoom(room) ? '' : '需所有應試班級導師都完成名單後才能列印'}
                              onClick={() => {
                                setPrintRoomId(room.id);
                                setPrintMode('seats');
                              }}
                              style={{ fontSize: 12, padding: '2px 8px' }}
                            >
                              列印座位表
                            </button>
                            <button
                              disabled={!canPrintRoom(room)}
                              title={canPrintRoom(room) ? '' : '需所有應試班級導師都完成名單後才能列印'}
                              onClick={() => {
                                setPrintRoomId(room.id);
                                setPrintMode('signin');
                              }}
                              style={{ fontSize: 12, padding: '2px 8px' }}
                            >
                              列印簽到表
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {isPeriodSent && subs.length > 0 && (
                      <div style={{ marginTop: 8, fontSize: 12 }}>
                        {subs.map((s) => (
                          <span
                            key={s.classId}
                            style={{
                              display: 'inline-block',
                              marginRight: 8,
                              marginTop: 4,
                              padding: '2px 8px',
                              borderRadius: 10,
                              background: s.submitted ? '#E7F3E8' : '#FBEFE9',
                              color: s.submitted ? '#2D6A32' : '#A32D2D',
                            }}
                          >
                            {s.label}：{s.submitted ? '已送出' : '未送出'}
                          </span>
                        ))}
                      </div>
                    )}

                    {isPeriodSent && room.seats_confirmed && <RoomSeatPreview seats={seatsByRoom[room.id] ?? []} classById={classById} studentNames={studentNames} />}

                    {openRoomId === room.id && (
                      <div style={{ marginTop: 12, borderTop: '1px dashed #ccc', paddingTop: 12 }}>
                        <table style={{ width: '100%', fontSize: 12, marginBottom: 8, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: 4 }}>應試班級</th>
                              <th style={{ textAlign: 'left', padding: 4 }}>人數</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {draftAllocations.map((row) => (
                              <tr key={row.key}>
                                <td style={{ padding: 4 }}>
                                  <select value={row.classId} onChange={(e) => updateDraftRow(row.key, { classId: e.target.value })} style={{ fontSize: 12, padding: 3 }}>
                                    <option value="">（選擇班級）</option>
                                    {classOptions
                                      .filter((c) => c.id === row.classId || !draftAllocations.some((r) => r.key !== row.key && r.classId === c.id))
                                      .map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.label}
                                        </option>
                                      ))}
                                  </select>
                                </td>
                                <td style={{ padding: 4 }}>
                                  <input
                                    type="number"
                                    min={0}
                                    value={row.count}
                                    onChange={(e) => updateDraftRow(row.key, { count: Math.max(0, Number(e.target.value) || 0) })}
                                    style={{ fontSize: 12, padding: 3, width: 70 }}
                                  />
                                </td>
                                <td style={{ padding: 4 }}>
                                  <button onClick={() => removeDraftRow(row.key)} style={{ fontSize: 11 }}>
                                    移除
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                          <button onClick={addDraftRow} style={{ fontSize: 12, padding: '3px 8px' }}>
                            ＋新增應試班級
                          </button>
                          <button onClick={() => applyAverage(room)} style={{ fontSize: 12, padding: '3px 8px' }}>
                            自動平均人數
                          </button>
                          <span style={{ fontSize: 12, color: draftTotal > room.capacity ? '#A32D2D' : '#666' }}>
                            合計 {draftTotal} / {room.capacity} 人
                          </span>
                        </div>

                        {draftPreviewLayout && (
                          <div style={{ marginBottom: 8 }}>
                            <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>梅花座預覽（7×7）：</p>
                            <SeatGridPreview layout={draftPreviewLayout} classById={classById} />
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8 }}>
                          <button disabled={busy} onClick={() => handleConfirmRoom(room)} style={{ fontSize: 12, padding: '4px 10px', fontWeight: 'bold' }}>
                            確認
                          </button>
                          <button onClick={() => setOpenRoomId(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>

            {!isPeriodSent && (
              <section>
                <button
                  disabled={busy || !allRoomsConfirmed}
                  title={allRoomsConfirmed ? '' : '所有考場都完成梅花座設定後才能發送'}
                  onClick={handleSendRoster}
                  style={{ fontSize: 14, padding: '8px 16px', fontWeight: 'bold' }}
                >
                  發送考場表
                </button>
              </section>
            )}
          </>
        )}
      </div>

      {printRoom && printMode && (
        <div className="print-only">
          {printMode === 'seats' ? (
            <PrintSeatChart room={printRoom} seats={seatsByRoom[printRoom.id] ?? []} classById={classById} studentNames={studentNames} periodName={selectedPeriod?.name ?? ''} />
          ) : (
            <PrintSignInSheet room={printRoom} seats={seatsByRoom[printRoom.id] ?? []} classById={classById} studentNames={studentNames} periodName={selectedPeriod?.name ?? ''} />
          )}
        </div>
      )}
    </main>
  );
}

function seatLabel(classId: string | null, classById: Map<string, ClassOption>): string {
  if (!classId) return '';
  return classById.get(classId)?.label ?? '?';
}

// 小張的座位格子預覽（設定畫面用，只顯示班級縮寫，不含姓名——姓名要等導師填完才有）
function SeatGridPreview({ layout, classById }: { layout: { row: number; col: number; classId: string | null }[]; classById: Map<string, ClassOption> }) {
  const rows = Array.from({ length: SEAT_GRID_SIZE }, (_, r) => layout.filter((c) => c.row === r + 1).sort((a, b) => a.col - b.col));
  return (
    <table style={{ borderCollapse: 'collapse' }}>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td
                key={ci}
                style={{
                  width: 42,
                  height: 32,
                  border: '1px solid #ddd',
                  textAlign: 'center',
                  fontSize: 11,
                  background: cell.classId ? '#EFF4FB' : '#fafafa',
                }}
              >
                {seatLabel(cell.classId, classById)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 已發送狀態下，考場清單裡的座位小預覽（含已填入的學生姓名，方便教務處確認進度）
function RoomSeatPreview({ seats, classById, studentNames }: { seats: ExamSeat[]; classById: Map<string, ClassOption>; studentNames: Record<string, string> }) {
  const rows = Array.from({ length: SEAT_GRID_SIZE }, (_, r) => seats.filter((s) => s.seat_row === r + 1).sort((a, b) => a.seat_col - b.seat_col));
  return (
    <div style={{ marginTop: 10 }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    width: 64,
                    height: 40,
                    border: '1px solid #ddd',
                    textAlign: 'center',
                    fontSize: 10,
                    background: cell.class_id ? '#EFF4FB' : '#fafafa',
                    verticalAlign: 'middle',
                  }}
                >
                  {cell.class_id ? (
                    <>
                      <div style={{ color: '#666' }}>{seatLabel(cell.class_id, classById)}</div>
                      <div>{cell.student_no ? studentNames[cell.student_no] ?? cell.student_no : '－'}</div>
                    </>
                  ) : (
                    ''
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrintSeatChart({
  room,
  seats,
  classById,
  studentNames,
  periodName,
}: {
  room: ExamRoom;
  seats: ExamSeat[];
  classById: Map<string, ClassOption>;
  studentNames: Record<string, string>;
  periodName: string;
}) {
  const rows = Array.from({ length: SEAT_GRID_SIZE }, (_, r) => seats.filter((s) => s.seat_row === r + 1).sort((a, b) => a.seat_col - b.seat_col));
  const roomLabel = classById.get(room.room_class_id)?.label ?? '';
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        {periodName}座位表－{roomLabel} 教室
      </h1>
      <table style={{ borderCollapse: 'collapse', marginTop: 12 }}>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ width: 90, height: 60, border: '1px solid #333', textAlign: 'center', fontSize: 12, verticalAlign: 'middle' }}>
                  {cell.class_id ? (
                    <>
                      <div style={{ fontSize: 11, color: '#555' }}>{seatLabel(cell.class_id, classById)}</div>
                      <div style={{ fontSize: 14 }}>{cell.student_no ? studentNames[cell.student_no] ?? cell.student_no : ''}</div>
                    </>
                  ) : (
                    ''
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PrintSignInSheet({
  room,
  seats,
  classById,
  studentNames,
  periodName,
}: {
  room: ExamRoom;
  seats: ExamSeat[];
  classById: Map<string, ClassOption>;
  studentNames: Record<string, string>;
  periodName: string;
}) {
  const roomLabel = classById.get(room.room_class_id)?.label ?? '';
  const list = seats
    .filter((s) => s.class_id && s.student_no)
    .slice()
    .sort((a, b) => a.seat_row - b.seat_row || a.seat_col - b.seat_col);
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>
        {periodName}簽到表－{roomLabel} 教室
      </h1>
      <table style={{ borderCollapse: 'collapse', marginTop: 12, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>座位</th>
            <th style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>班級</th>
            <th style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>學號</th>
            <th style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>姓名</th>
            <th style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>簽到</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td style={{ border: '1px solid #333', padding: 6, fontSize: 12, textAlign: 'center' }}>
                {s.seat_row}-{s.seat_col}
              </td>
              <td style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>{seatLabel(s.class_id, classById)}</td>
              <td style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>{s.student_no}</td>
              <td style={{ border: '1px solid #333', padding: 6, fontSize: 12 }}>{s.student_no ? studentNames[s.student_no] ?? '' : ''}</td>
              <td style={{ border: '1px solid #333', padding: 6, fontSize: 12 }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
