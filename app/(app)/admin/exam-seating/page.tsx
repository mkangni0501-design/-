'use client';

import { useEffect, useMemo, useState } from 'react';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';
import {
  ExamSession,
  ExamRoom,
  ExamRoomClass,
  ClassOption,
  SeatCell,
  ExamRoomSeatRow,
  RosterStatus,
  listExamSessions,
  createExamSession,
  deleteExamSession,
  listExamRooms,
  createExamRoom,
  deleteExamRoom,
  listClassOptionsWithHeadcount,
  listExamRoomClasses,
  saveExamRoomClassAssignment,
  saveAllocatedCounts,
  computeAllocatedCounts,
  validateAllocation,
  ValidationResult,
  generateSeatLayout,
  confirmRoomSeatLayout,
  sendExamSession,
  listRoomSeats,
  listRosterStatus,
  gridSizeForCapacity,
} from '@/lib/examSeating';

// ============================================================
// 教務處【考試分班】頁
// 流程：新增/刪除考試 → 新增考場 → 各考場設定應試班級 → 試算＋雙驗證（可手動修改）→
//      儲存 → 各考場產生梅花座位表 → 確認 → 全部考場完成後【發送考場表】通知導師 →
//      發送後可預覽各考場名單/座位並列印座位表、簽到表。
// ============================================================

type ClassRow = { classId: string; label: string; headcount: number };

export default function ExamSeatingPage() {
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ExamSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 新增考試表單
  const [newName, setNewName] = useState('');
  const [newYear, setNewYear] = useState<number>(new Date().getFullYear());
  const [newTerm, setNewTerm] = useState('上學期');

  async function reloadSessions(keepSelected?: string | null) {
    setLoading(true);
    try {
      const rows = await listExamSessions();
      setSessions(rows);
      if (keepSelected !== undefined) {
        setSelectedSessionId(keepSelected);
      } else if (rows.length > 0 && !selectedSessionId) {
        setSelectedSessionId(rows[0].id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const me = await getCurrentAppUser();
      setMyUserId(me?.id ?? null);
      await reloadSessions();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreateSession() {
    if (!newName.trim()) {
      setError('請輸入考試名稱');
      return;
    }
    setError(null);
    try {
      await createExamSession({ name: newName.trim(), academic_year: newYear, term: newTerm, created_by: myUserId });
      setNewName('');
      setNotice('已新增考試');
      await reloadSessions(undefined);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDeleteSession(id: string) {
    if (!confirm('確定要刪除這個考試嗎？相關考場與座位表設定將一併刪除。')) return;
    setError(null);
    try {
      await deleteExamSession(id);
      setNotice('已刪除考試');
      if (selectedSessionId === id) setSelectedSessionId(null);
      await reloadSessions(selectedSessionId === id ? null : selectedSessionId);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>考試分班</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        新增考試 → 新增考場並設定應試班級 → 試算各考場人數（雙驗證後儲存）→ 產生梅花座位表並確認 → 全部考場完成後發送通知各班導師。
      </p>
      <ErrorBanner message={error} />
      {notice && (
        <p style={{ fontSize: 13, color: '#2D6A2D', background: '#EEF7EE', border: '1px solid #CFE8CF', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          {notice}
        </p>
      )}

      {/* ---------- 新增考試 ---------- */}
      <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>新增考試</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input placeholder="考試名稱，例如：期中考" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ fontSize: 13, padding: '4px 8px', width: 220 }} />
          <input
            type="number"
            value={newYear}
            onChange={(e) => setNewYear(Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 8px', width: 90 }}
          />
          <select value={newTerm} onChange={(e) => setNewTerm(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
            <option value="上學期">上學期</option>
            <option value="下學期">下學期</option>
          </select>
          <button onClick={handleCreateSession} style={{ fontSize: 13, padding: '4px 12px' }}>
            新增考試
          </button>
        </div>
      </section>

      {/* ---------- 考試清單 ---------- */}
      <section style={{ marginBottom: 16 }}>
        {loading ? (
          <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
        ) : sessions.length === 0 ? (
          <p style={{ fontSize: 13, color: '#999' }}>尚未建立任何考試。</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sessions.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  border: '1px solid ' + (s.id === selectedSessionId ? '#B08968' : '#eee'),
                  borderRadius: 6,
                  background: s.id === selectedSessionId ? '#FBF3EC' : '#fff',
                }}
              >
                <button
                  onClick={() => setSelectedSessionId(s.id)}
                  style={{ fontSize: 13, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', flex: 1 }}
                >
                  {s.name}（{s.academic_year} {s.term}）－
                  <span style={{ color: s.status === '已發送' ? '#2D6A2D' : '#999' }}> {s.status}</span>
                </button>
                <button onClick={() => handleDeleteSession(s.id)} style={{ fontSize: 12, padding: '2px 10px', color: '#A32D2D' }}>
                  刪除考試
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedSession && <ExamSessionEditor key={selectedSession.id} session={selectedSession} onSent={() => reloadSessions(selectedSession.id)} setNotice={setNotice} setError={setError} />}
    </main>
  );
}

// ============================================================
// 單一考試的編排畫面：考場清單 → 各考場設定應試班級 → 試算/儲存人數 → 各考場梅花座位表 → 確認 → 發送
// ============================================================
function ExamSessionEditor({
  session,
  onSent,
  setNotice,
  setError,
}: {
  session: ExamSession;
  onSent: () => void;
  setNotice: (m: string | null) => void;
  setError: (m: string | null) => void;
}) {
  const [rooms, setRooms] = useState<ExamRoom[]>([]);
  const [roomClasses, setRoomClasses] = useState<ExamRoomClass[]>([]);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomCapacity, setNewRoomCapacity] = useState<number>(30);

  const [assigningRoomId, setAssigningRoomId] = useState<string | null>(null);
  const [seatPreviewRoomId, setSeatPreviewRoomId] = useState<string | null>(null);
  const [detailRoomId, setDetailRoomId] = useState<string | null>(null);

  const [matrix, setMatrix] = useState<Record<string, Record<string, number>> | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const [roomRows, classRows] = await Promise.all([listExamRooms(session.id), listClassOptionsWithHeadcount(session.academic_year)]);
      setRooms(roomRows);
      setClassOptions(classRows);
      const rcRows = await listExamRoomClasses(roomRows.map((r) => r.id));
      setRoomClasses(rcRows);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const classLabelMap = useMemo(() => Object.fromEntries(classOptions.map((c) => [c.id, c.label])), [classOptions]);
  const roomLabelMap = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r.room_name])), [rooms]);

  async function handleAddRoom() {
    if (!newRoomName.trim()) {
      setError('請輸入考場名稱');
      return;
    }
    setError(null);
    try {
      await createExamRoom(session.id, newRoomName.trim(), newRoomCapacity);
      setNewRoomName('');
      setNotice('已新增考場');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDeleteRoom(id: string) {
    if (!confirm('確定要刪除這個考場嗎？')) return;
    try {
      await deleteExamRoom(id);
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  // ---- 試算各班在各考場的人數（步驟3）----
  function runComputation() {
    setError(null);
    const classRoomMap: Record<string, string[]> = {};
    for (const rc of roomClasses) {
      classRoomMap[rc.class_id] = classRoomMap[rc.class_id] ?? [];
      classRoomMap[rc.class_id].push(rc.exam_room_id);
    }
    const inputs = Object.entries(classRoomMap).map(([classId, roomIds]) => ({
      classId,
      headcount: classOptions.find((c) => c.id === classId)?.headcount ?? 0,
      rooms: roomIds.map((roomId) => ({ examRoomId: roomId, capacity: rooms.find((r) => r.id === roomId)?.seat_capacity ?? 0 })),
    }));
    const result = computeAllocatedCounts(inputs);
    setMatrix(result);
    runValidation(result, classRoomMap);
  }

  function runValidation(m: Record<string, Record<string, number>>, classRoomMap: Record<string, string[]>) {
    const v = validateAllocation({
      classHeadcounts: Object.fromEntries(classOptions.map((c) => [c.id, c.headcount])),
      classLabels: classLabelMap,
      roomCapacities: Object.fromEntries(rooms.map((r) => [r.id, r.seat_capacity])),
      roomLabels: roomLabelMap,
      matrix: m,
      classRoomMap,
    });
    setValidation(v);
  }

  function editMatrixCell(roomId: string, classId: string, value: number) {
    if (!matrix) return;
    const next = { ...matrix, [roomId]: { ...matrix[roomId], [classId]: value } };
    setMatrix(next);
    const classRoomMap: Record<string, string[]> = {};
    for (const rc of roomClasses) {
      classRoomMap[rc.class_id] = classRoomMap[rc.class_id] ?? [];
      classRoomMap[rc.class_id].push(rc.exam_room_id);
    }
    runValidation(next, classRoomMap);
  }

  async function handleSaveMatrix() {
    if (!matrix || !validation || !validation.horizontalOk || !validation.verticalOk) {
      setError('人數加總尚未一致，請先修正橫向／縱向加總後再儲存。');
      return;
    }
    setError(null);
    try {
      const rows = roomClasses.map((rc) => ({ id: rc.id, allocated_count: matrix[rc.exam_room_id]?.[rc.class_id] ?? 0 }));
      await saveAllocatedCounts(rows);
      setNotice('已儲存各考場分配人數');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const allConfirmed = rooms.length > 0 && rooms.every((r) => r.confirmed);
  const [rosterStatus, setRosterStatus] = useState<RosterStatus[]>([]);
  useEffect(() => {
    if (session.status !== '已發送' && session.status !== '已完成') return;
    listRosterStatus(session.id).then(setRosterStatus).catch(() => {});
  }, [session.id, session.status]);

  async function handleSend() {
    if (!allConfirmed) {
      setError('尚有考場座位表未確認，需全部考場都按過【確認】才能發送。');
      return;
    }
    if (!confirm('確定要發送考場表通知各班導師嗎？')) return;
    setError(null);
    try {
      await sendExamSession(session.id);
      setNotice('已發送考場表，各班導師將收到通知。');
      onSent();
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (loading) return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;

  return (
    <section style={{ borderTop: '2px solid #eee', paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 15 }}>
          {session.name}（{session.academic_year} {session.term}）
        </h2>
        {session.status !== '已發送' && session.status !== '已完成' && (
          <button onClick={handleSend} disabled={!allConfirmed} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600 }}>
            發送考場表
          </button>
        )}
      </div>
      {!allConfirmed && session.status === '編排中' && (
        <p style={{ fontSize: 12, color: '#B08968', marginBottom: 8 }}>提示：所有考場都需完成座位表【確認】後，才能發送考場表。</p>
      )}

      {/* ---- 新增考場 ---- */}
      {session.status === '編排中' && (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>新增考場</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input placeholder="考場名稱，例如：101教室" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)} style={{ fontSize: 13, padding: '4px 8px', width: 180 }} />
            <label style={{ fontSize: 12, color: '#666' }}>座位數（最多49，最大7*7）</label>
            <input
              type="number"
              min={1}
              max={49}
              value={newRoomCapacity}
              onChange={(e) => setNewRoomCapacity(Number(e.target.value))}
              style={{ fontSize: 13, padding: '4px 8px', width: 80 }}
            />
            <span style={{ fontSize: 12, color: '#999' }}>方形座位：{gridSizeForCapacity(newRoomCapacity)}×{gridSizeForCapacity(newRoomCapacity)}</span>
            <button onClick={handleAddRoom} style={{ fontSize: 13, padding: '4px 12px' }}>
              新增考場
            </button>
          </div>
        </div>
      )}

      {/* ---- 考場清單 ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {rooms.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>尚未新增考場。</p>}
        {rooms.map((room) => {
          const myClasses = roomClasses.filter((rc) => rc.exam_room_id === room.id);
          const submittedCount = rosterStatus.filter((rs) => myClasses.some((mc) => mc.class_id === rs.class_id) && rs.submitted).length;
          return (
            <div key={room.id} style={{ border: '1px solid #eee', borderRadius: 6, padding: '8px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ fontSize: 13 }}>
                  <strong>{room.room_name}</strong>（座位數 {room.seat_capacity}，{room.grid_size}×{room.grid_size}方形）
                  {room.confirmed ? <span style={{ color: '#2D6A2D', marginLeft: 8 }}>已確認座位表</span> : <span style={{ color: '#999', marginLeft: 8 }}>尚未確認</span>}
                  {(session.status === '已發送' || session.status === '已完成') && myClasses.length > 0 && (
                    <span style={{ color: '#666', marginLeft: 8 }}>
                      名單提交：{submittedCount}/{myClasses.length} 班
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {session.status === '編排中' && (
                    <>
                      <button onClick={() => setAssigningRoomId(room.id)} style={{ fontSize: 12, padding: '3px 10px' }}>
                        設定應試班級
                      </button>
                      <button onClick={() => setSeatPreviewRoomId(room.id)} style={{ fontSize: 12, padding: '3px 10px' }}>
                        梅花座位表
                      </button>
                      <button onClick={() => handleDeleteRoom(room.id)} style={{ fontSize: 12, padding: '3px 10px', color: '#A32D2D' }}>
                        刪除考場
                      </button>
                    </>
                  )}
                  {(session.status === '已發送' || session.status === '已完成') && (
                    <button onClick={() => setDetailRoomId(room.id)} style={{ fontSize: 12, padding: '3px 10px' }}>
                      預覽／列印
                    </button>
                  )}
                </div>
              </div>
              {myClasses.length > 0 && (
                <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  應試班級：{myClasses.map((mc) => `${classLabelMap[mc.class_id] ?? mc.class_id}(${mc.allocated_count}人)`).join('、')}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- 步驟2：設定應試班級（哪些班分配到這個考場）---- */}
      {assigningRoomId && (
        <AssignClassesModal
          room={rooms.find((r) => r.id === assigningRoomId)!}
          classOptions={classOptions}
          currentClassIds={roomClasses.filter((rc) => rc.exam_room_id === assigningRoomId).map((rc) => rc.class_id)}
          onClose={() => setAssigningRoomId(null)}
          onSaved={async () => {
            setAssigningRoomId(null);
            setNotice('已儲存應試班級分配');
            await reload();
          }}
        />
      )}

      {/* ---- 步驟3-4：試算各考場人數＋雙驗證 ---- */}
      {session.status === '編排中' && roomClasses.length > 0 && (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 13 }}>試算各考場人數（可手動修改，橫向／縱向加總一致才能儲存）</h3>
            <button onClick={runComputation} style={{ fontSize: 12, padding: '4px 12px' }}>
              依座位數比例試算
            </button>
          </div>
          {matrix && (
            <AllocationMatrix
              matrix={matrix}
              rooms={rooms.filter((r) => roomClasses.some((rc) => rc.exam_room_id === r.id))}
              classOptions={classOptions.filter((c) => roomClasses.some((rc) => rc.class_id === c.id))}
              validation={validation}
              onEditCell={editMatrixCell}
            />
          )}
          {matrix && (
            <div style={{ marginTop: 8 }}>
              <button onClick={handleSaveMatrix} disabled={!validation || !validation.horizontalOk || !validation.verticalOk} style={{ fontSize: 13, padding: '5px 14px' }}>
                儲存分配人數
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- 步驟5-6：梅花座位表 ---- */}
      {seatPreviewRoomId && (
        <SeatLayoutModal
          room={rooms.find((r) => r.id === seatPreviewRoomId)!}
          roomClasses={roomClasses.filter((rc) => rc.exam_room_id === seatPreviewRoomId)}
          classLabelMap={classLabelMap}
          onClose={() => setSeatPreviewRoomId(null)}
          onConfirmed={async () => {
            setSeatPreviewRoomId(null);
            setNotice('已確認座位表');
            await reload();
          }}
        />
      )}

      {/* ---- 步驟8：發送後預覽／列印 ---- */}
      {detailRoomId && (
        <RoomDetailModal
          room={rooms.find((r) => r.id === detailRoomId)!}
          examSessionName={session.name}
          classLabelMap={classLabelMap}
          roomClasses={roomClasses.filter((rc) => rc.exam_room_id === detailRoomId)}
          rosterStatus={rosterStatus}
          examSessionId={session.id}
          onClose={() => setDetailRoomId(null)}
        />
      )}
    </section>
  );
}

// ============================================================
// 設定應試班級（多選）
// ============================================================
function AssignClassesModal({
  room,
  classOptions,
  currentClassIds,
  onClose,
  onSaved,
}: {
  room: ExamRoom;
  classOptions: ClassOption[];
  currentClassIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentClassIds));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await saveExamRoomClassAssignment(room.id, Array.from(selected));
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={`${room.room_name}－設定應試班級`} onClose={onClose}>
      <ErrorBanner message={err} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6, maxHeight: 320, overflowY: 'auto', marginBottom: 12 }}>
        {classOptions.map((c) => (
          <label key={c.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
            {c.label}（{c.headcount}人）
          </label>
        ))}
      </div>
      <button onClick={save} disabled={saving} style={{ fontSize: 13, padding: '5px 14px' }}>
        {saving ? '儲存中…' : '儲存'}
      </button>
    </ModalShell>
  );
}

// ============================================================
// 分配人數矩陣（班級 x 考場）
// ============================================================
function AllocationMatrix({
  matrix,
  rooms,
  classOptions,
  validation,
  onEditCell,
}: {
  matrix: Record<string, Record<string, number>>;
  rooms: ExamRoom[];
  classOptions: ClassOption[];
  validation: ValidationResult | null;
  onEditCell: (roomId: string, classId: string, value: number) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 400 }}>
        <thead>
          <tr>
            <th style={cellStyle}>班級</th>
            {rooms.map((r) => (
              <th key={r.id} style={cellStyle}>
                {r.room_name}
                <br />
                <span style={{ color: '#999', fontWeight: 400 }}>座位{r.seat_capacity}</span>
              </th>
            ))}
            <th style={cellStyle}>總人數</th>
          </tr>
        </thead>
        <tbody>
          {classOptions.map((c) => {
            const rowSum = rooms.reduce((s, r) => s + (matrix[r.id]?.[c.id] ?? 0), 0);
            const rowOk = rowSum === c.headcount;
            return (
              <tr key={c.id}>
                <td style={cellStyle}>{c.label}</td>
                {rooms.map((r) => (
                  <td key={r.id} style={cellStyle}>
                    <input
                      type="number"
                      value={matrix[r.id]?.[c.id] ?? 0}
                      onChange={(e) => onEditCell(r.id, c.id, Number(e.target.value))}
                      style={{ width: 48, fontSize: 12, textAlign: 'center' }}
                    />
                  </td>
                ))}
                <td style={{ ...cellStyle, color: rowOk ? '#2D6A2D' : '#A32D2D', fontWeight: 600 }}>
                  {rowSum} / {c.headcount}
                </td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...cellStyle, fontWeight: 600 }}>座位加總</td>
            {rooms.map((r) => {
              const colSum = classOptions.reduce((s, c) => s + (matrix[r.id]?.[c.id] ?? 0), 0);
              const colOk = colSum <= r.seat_capacity;
              return (
                <td key={r.id} style={{ ...cellStyle, color: colOk ? '#2D6A2D' : '#A32D2D', fontWeight: 600 }}>
                  {colSum} / {r.seat_capacity}
                </td>
              );
            })}
            <td style={cellStyle} />
          </tr>
        </tbody>
      </table>
      {validation && !validation.horizontalOk && (
        <ul style={{ fontSize: 12, color: '#A32D2D', marginTop: 6 }}>
          {validation.horizontalErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {validation && !validation.verticalOk && (
        <ul style={{ fontSize: 12, color: '#A32D2D', marginTop: 6 }}>
          {validation.verticalErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: '1px solid #eee', padding: '4px 8px', textAlign: 'center' };

// ============================================================
// 梅花座位表產生／確認
// ============================================================
function SeatLayoutModal({
  room,
  roomClasses,
  classLabelMap,
  onClose,
  onConfirmed,
}: {
  room: ExamRoom;
  roomClasses: ExamRoomClass[];
  classLabelMap: Record<string, string>;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [seats, setSeats] = useState<SeatCell[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function generate() {
    const layout = generateSeatLayout({
      gridSize: room.grid_size,
      capacity: room.seat_capacity,
      classCounts: roomClasses.map((rc) => ({ classId: rc.class_id, count: rc.allocated_count })),
    });
    setSeats(layout);
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalAllocated = roomClasses.reduce((s, rc) => s + rc.allocated_count, 0);

  async function confirm() {
    setSaving(true);
    setErr(null);
    try {
      await confirmRoomSeatLayout(room.id, seats);
      onConfirmed();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  const colorFor = useMemo(() => {
    const palette = ['#F4D7C3', '#CDE7D8', '#CFE0F4', '#F4EBC3', '#E3D3F4', '#F4C3D7', '#C3F4E9', '#DDE0E3'];
    const map: Record<string, string> = {};
    roomClasses.forEach((rc, i) => (map[rc.class_id] = palette[i % palette.length]));
    return map;
  }, [roomClasses]);

  if (totalAllocated === 0) {
    return (
      <ModalShell title={`${room.room_name}－梅花座位表`} onClose={onClose}>
        <p style={{ fontSize: 13, color: '#A32D2D' }}>尚未儲存本考場的分配人數，請先完成「試算各考場人數」並儲存。</p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`${room.room_name}－梅花座位表（${room.grid_size}×${room.grid_size}）`} onClose={onClose}>
      <ErrorBanner message={err} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 12 }}>
        {roomClasses.map((rc) => (
          <span key={rc.class_id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, background: colorFor[rc.class_id], display: 'inline-block', borderRadius: 2 }} />
            {classLabelMap[rc.class_id] ?? rc.class_id}（{rc.allocated_count}人）
          </span>
        ))}
      </div>
      <SeatGrid gridSize={room.grid_size} seats={seats} colorFor={colorFor} labelFor={(classId) => (classId ? (classLabelMap[classId] ?? '') : '')} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={generate} style={{ fontSize: 13, padding: '5px 14px' }}>
          重新排列
        </button>
        <button onClick={confirm} disabled={saving} style={{ fontSize: 13, padding: '5px 14px', fontWeight: 600 }}>
          {saving ? '儲存中…' : '確認'}
        </button>
      </div>
    </ModalShell>
  );
}

function SeatGrid({
  gridSize,
  seats,
  colorFor,
  labelFor,
  seatContent,
}: {
  gridSize: number;
  seats: { row: number; col: number; seatNo: number; classId: string | null }[];
  colorFor: Record<string, string>;
  labelFor: (classId: string | null) => string;
  seatContent?: (seatNo: number) => React.ReactNode;
}) {
  const bySeat = new Map<string, (typeof seats)[number]>();
  seats.forEach((s) => bySeat.set(`${s.row}-${s.col}`, s));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridSize}, 56px)`, gap: 4 }}>
      {Array.from({ length: gridSize }).map((_, row) =>
        Array.from({ length: gridSize }).map((__, col) => {
          const seat = bySeat.get(`${row}-${col}`);
          if (!seat) return <div key={`${row}-${col}`} style={{ width: 56, height: 44 }} />;
          return (
            <div
              key={`${row}-${col}`}
              style={{
                width: 56,
                height: 44,
                border: '1px solid #ccc',
                borderRadius: 4,
                background: seat.classId ? colorFor[seat.classId] ?? '#eee' : '#f7f7f7',
                fontSize: 10,
                padding: 2,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
              }}
            >
              <div style={{ color: '#666' }}>#{seat.seatNo}</div>
              <div>{seatContent ? seatContent(seat.seatNo) : labelFor(seat.classId)}</div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ============================================================
// 發送後：預覽名單／座位＋列印座位表／簽到表
// ============================================================
function RoomDetailModal({
  room,
  examSessionName,
  classLabelMap,
  roomClasses,
  rosterStatus,
  examSessionId,
  onClose,
}: {
  room: ExamRoom;
  examSessionName: string;
  classLabelMap: Record<string, string>;
  roomClasses: ExamRoomClass[];
  rosterStatus: RosterStatus[];
  examSessionId: string;
  onClose: () => void;
}) {
  const [seats, setSeats] = useState<ExamRoomSeatRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listRoomSeats(room.id)
      .then(setSeats)
      .finally(() => setLoading(false));
  }, [room.id]);

  const allSubmitted = roomClasses.every((rc) => rosterStatus.find((rs) => rs.class_id === rc.class_id)?.submitted);

  const colorFor = useMemo(() => {
    const palette = ['#F4D7C3', '#CDE7D8', '#CFE0F4', '#F4EBC3', '#E3D3F4', '#F4C3D7', '#C3F4E9', '#DDE0E3'];
    const map: Record<string, string> = {};
    roomClasses.forEach((rc, i) => (map[rc.class_id] = palette[i % palette.length]));
    return map;
  }, [roomClasses]);

  function handlePrint() {
    const w = window.open('', '_blank');
    if (!w) return;
    const rows = seats
      .filter((s) => s.class_id)
      .map(
        (s) =>
          `<tr><td>${s.seat_no}</td><td>${classLabelMap[s.class_id!] ?? ''}</td><td>${s.exam_seat_students?.class_seat_no ?? ''}</td><td>${s.exam_seat_students?.student_no ?? ''}</td></tr>`
      )
      .join('');
    w.document.write(`
      <html><head><title>${examSessionName}－${room.room_name}</title>
      <style>
        body{font-family:sans-serif;padding:24px;}
        h1{font-size:18px;} h2{font-size:14px;color:#666;}
        table{border-collapse:collapse;width:100%;margin-top:16px;}
        td,th{border:1px solid #999;padding:6px 10px;font-size:13px;text-align:center;}
      </style></head><body>
      <h1>${examSessionName}</h1>
      <h2>考場：${room.room_name}（座位數 ${room.seat_capacity}）</h2>
      <table><thead><tr><th>考場座位號</th><th>班級</th><th>原班座號</th><th>學號</th><th>簽名</th></tr></thead>
      <tbody>${rows.replace(/<\/tr>/g, '<td style="width:120px"></td></tr>')}</tbody></table>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <ModalShell title={`${room.room_name}－名單與座位預覽`} onClose={onClose}>
      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          <SeatGrid
            gridSize={room.grid_size}
            seats={seats.map((s) => ({ row: s.row_no, col: s.col_no, seatNo: s.seat_no, classId: s.class_id }))}
            colorFor={colorFor}
            labelFor={() => ''}
            seatContent={(seatNo) => {
              const seat = seats.find((s) => s.seat_no === seatNo);
              const stu = seat?.exam_seat_students;
              return stu?.class_seat_no != null ? `座號${stu.class_seat_no}` : seat?.class_id ? classLabelMap[seat.class_id] : '';
            }}
          />
          <p style={{ fontSize: 12, color: allSubmitted ? '#2D6A2D' : '#B08968', marginTop: 10 }}>
            {allSubmitted ? '各班名單皆已送出，可以列印座位表／簽到表。' : '尚有班級未完成名單輸入，暫時無法列印完整簽到表。'}
          </p>
          <button onClick={handlePrint} disabled={!allSubmitted} style={{ fontSize: 13, padding: '5px 14px', marginTop: 6 }}>
            列印座位表／簽到表
          </button>
        </>
      )}
    </ModalShell>
  );
}

// ============================================================
// 共用 Modal 外框
// ============================================================
function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 20, maxWidth: 720, width: '100%', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 14 }}>{title}</h3>
          <button onClick={onClose} style={{ fontSize: 12, padding: '3px 10px' }}>
            關閉
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
