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
  MAX_CLASSES_PER_ROOM,
  listExamSessions,
  createExamSession,
  deleteExamSession,
  listExamRooms,
  autoSyncRoomsForSession,
  setExcludedClasses,
  listClassOptionsWithHeadcount,
  listExamRoomClasses,
  saveAllRoomClassGroups,
  computeGroupsFromRoomClasses,
  findGroupOf,
  toggleGroupMember,
  saveAllocatedCounts,
  computeAllocatedCounts,
  autoBalanceAllocation,
  validateAllocation,
  ValidationResult,
  generateSeatLayout,
  confirmRoomSeatLayout,
  sendExamSession,
  listRoomSeats,
  listRosterStatus,
  escapeHtml,
  buildSignInRows,
  buildRoomExportData,
} from '@/lib/examSeating';

// ============================================================
// 教務處【考試分班】頁
// 流程：新增考試 → 系統自動把所有班級設為考場（考場名稱＝班級名稱，座位數＝該班人數，
//      不需要教務處另行手動新增）→ 各考場旁邊直接展開選擇應試班級（最多4班，考場自己班級一定
//      包含，選了誰對方考場也會自動勾選回來），編輯完用同一個【儲存】鍵一次存檔 →
//      試算＋雙驗證（可手動修改）→ 儲存 → 各考場產生梅花座位表 → 確認 →
//      全部考場完成後【發送考場表】通知導師 → 發送後可預覽各考場名單/座位並列印座位表、簽到表。
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
        新增考試 → 系統自動把所有班級設為考場，勾選需要共用考場的班級（按一次【儲存應試班級】即可）→ 試算各考場人數（雙驗證後儲存）→ 產生梅花座位表並確認 → 全部考場完成後發送通知各班導師。
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
// 單一考試的編排畫面：考場清單（＝所有班級自動列出）→ 展開勾選應試班級群組（一個儲存鍵存全部）→
// 試算/儲存人數 → 各考場梅花座位表 → 確認 → 發送
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

  const [syncNotices, setSyncNotices] = useState<string[]>([]);

  // 不擔任考場的班級：本地暫存的編輯狀態，勾選完批次按下【儲存】才會真正寫入資料庫、
  // 觸發下面考場清單的自動排除／同步（避免每勾一個班級就存檔+重新整理一次，很卡）。
  const [pendingExcludedIds, setPendingExcludedIds] = useState<Set<string>>(new Set(session.excluded_class_ids ?? []));
  const [savedExcludedIds, setSavedExcludedIds] = useState<Set<string>>(new Set(session.excluded_class_ids ?? []));
  const [savingExcluded, setSavingExcluded] = useState(false);

  // 應試班級共用群組：本地暫存的編輯狀態，按下唯一的【儲存應試班級】鍵才會真正寫入資料庫
  const [groups, setGroups] = useState<string[][]>([]);
  const [savedGroups, setSavedGroups] = useState<string[][]>([]);
  const [savingGroups, setSavingGroups] = useState(false);

  const [allRoomsReviewOpen, setAllRoomsReviewOpen] = useState(false);
  const [detailRoomId, setDetailRoomId] = useState<string | null>(null);

  const [matrix, setMatrix] = useState<Record<string, Record<string, number>> | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  async function reload(excludedOverride?: Set<string>) {
    setLoading(true);
    try {
      const effectiveExcluded = excludedOverride ?? savedExcludedIds;
      const classRows = await listClassOptionsWithHeadcount(session.academic_year);
      setClassOptions(classRows);
      // 步驟1：所有班級（扣掉勾選「不擔任考場」的班級）自動設為考場，不用教務處另行手動新增，
      // 也會自動把還沒確認的考場座位數同步成班級目前的真實人數。
      if (session.status === '編排中') {
        const sync = await autoSyncRoomsForSession(session.id, session.academic_year, Array.from(effectiveExcluded), classRows);
        const msgs: string[] = [];
        if (sync.skippedEmpty.length > 0) msgs.push(`${sync.skippedEmpty.join('、')} 目前沒有在校學生，未建立考場`);
        if (sync.skippedTooBig.length > 0) msgs.push(`${sync.skippedTooBig.join('、')} 人數超過49人，超出單一考場座位上限，未自動建立考場`);
        if (sync.removedExcluded.length > 0) msgs.push(`${sync.removedExcluded.join('、')} 已設為不擔任考場，考場已移除`);
        for (const u of sync.updatedCapacities) msgs.push(`${u.label} 考場座位數已從 ${u.oldCapacity} 自動校正為 ${u.newCapacity}（目前班級人數）`);
        for (const m of sync.confirmedMismatches) msgs.push(`${m.label} 座位表已確認，但目前班級人數（${m.currentHeadcount}）跟座位數（${m.roomCapacity}）不同，請確認後重新產生座位表`);
        setSyncNotices(msgs);
      }
      const roomRows = await listExamRooms(session.id);
      setRooms(roomRows);
      const rcRows = await listExamRoomClasses(roomRows.map((r) => r.id));
      setRoomClasses(rcRows);
      const g = computeGroupsFromRoomClasses(roomRows, rcRows, classRows);
      setGroups(g);
      setSavedGroups(g);
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

  function toggleExcludedPending(classId: string) {
    const next = new Set(pendingExcludedIds);
    if (next.has(classId)) next.delete(classId);
    else next.add(classId);
    setPendingExcludedIds(next);
  }

  const excludedDirty =
    pendingExcludedIds.size !== savedExcludedIds.size || [...pendingExcludedIds].some((id) => !savedExcludedIds.has(id));

  async function handleSaveExcluded() {
    setSavingExcluded(true);
    setError(null);
    try {
      await setExcludedClasses(session.id, Array.from(pendingExcludedIds));
      setSavedExcludedIds(new Set(pendingExcludedIds));
      await reload(pendingExcludedIds);
      onSent(); // 順便刷新上層的考試清單，讓 session.excluded_class_ids 保持同步
      setNotice('已儲存不擔任考場班級');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingExcluded(false);
    }
  }

  const classLabelMap = useMemo(() => Object.fromEntries(classOptions.map((c) => [c.id, c.label])), [classOptions]);
  const labelToClassId = useMemo(() => Object.fromEntries(classOptions.map((c) => [c.label, c.id])), [classOptions]);
  const roomLabelMap = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r.room_name])), [rooms]);

  const groupsDirty = JSON.stringify([...groups].map((g) => [...g].sort())) !== JSON.stringify([...savedGroups].map((g) => [...g].sort()));

  function handleToggleGroup(ownerId: string, targetId: string) {
    setGroups((prev) => toggleGroupMember(prev, ownerId, targetId));
  }

  // ---- 步驟2：一次儲存所有考場目前的應試班級分配（只需要這一個儲存鍵） ----
  async function handleSaveGroups() {
    setError(null);
    setSavingGroups(true);
    try {
      const assignments = rooms.map((r) => {
        const ownerId = labelToClassId[r.room_name];
        const classIds = ownerId ? findGroupOf(groups, ownerId) : [];
        return { examRoomId: r.id, classIds };
      });
      await saveAllRoomClassGroups(assignments);
      setNotice('已儲存所有考場的應試班級');
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingGroups(false);
    }
  }

  // ---- 試算各班在各考場的人數（步驟3）----
  function buildClassRoomMap(): Record<string, string[]> {
    const classRoomMap: Record<string, string[]> = {};
    for (const rc of roomClasses) {
      classRoomMap[rc.class_id] = classRoomMap[rc.class_id] ?? [];
      classRoomMap[rc.class_id].push(rc.exam_room_id);
    }
    return classRoomMap;
  }

  function runComputation() {
    setError(null);
    const classRoomMap = buildClassRoomMap();
    const inputs = Object.entries(classRoomMap).map(([classId, roomIds]) => ({
      classId,
      headcount: classOptions.find((c) => c.id === classId)?.headcount ?? 0,
      rooms: roomIds.map((roomId) => ({ examRoomId: roomId, capacity: rooms.find((r) => r.id === roomId)?.seat_capacity ?? 0 })),
    }));
    const raw = computeAllocatedCounts(inputs);
    // 橫向加總 computeAllocatedCounts 已經保證正確；如果縱向（考場座位數）兜不起來
    // （例如考場座位數是建立當下的快照，之後班級人數又有異動），這裡自動微調到符合兩項驗證。
    const balanced = autoBalanceAllocation({
      matrix: raw,
      roomCapacities: Object.fromEntries(rooms.map((r) => [r.id, r.seat_capacity])),
      classRoomMap,
    });
    setMatrix(balanced);
    runValidation(balanced, classRoomMap);
  }

  // 手動調整後如果又不符合兩項驗證，可以再按一次自動調整（不影響已經手動改過的其他部分邏輯，
  // 只是重新搬動名額讓兩項驗證都符合），仍然保留自由手動調整每一格的功能。
  function handleAutoBalance() {
    if (!matrix) return;
    setError(null);
    const classRoomMap = buildClassRoomMap();
    const balanced = autoBalanceAllocation({
      matrix,
      roomCapacities: Object.fromEntries(rooms.map((r) => [r.id, r.seat_capacity])),
      classRoomMap,
    });
    setMatrix(balanced);
    runValidation(balanced, classRoomMap);
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
    runValidation(next, buildClassRoomMap());
  }

  async function handleSaveMatrix() {
    if (!matrix || !validation || !validation.horizontalOk || !validation.verticalOk) {
      setError('人數加總尚未一致，請先按【自動調整】或手動修正橫向／縱向加總後再儲存。');
      return;
    }
    setError(null);
    try {
      const rows = roomClasses.map((rc) => ({
        id: rc.id,
        exam_room_id: rc.exam_room_id,
        class_id: rc.class_id,
        allocated_count: matrix[rc.exam_room_id]?.[rc.class_id] ?? 0,
      }));
      await saveAllocatedCounts(rows);
      setNotice('已儲存各考場分配人數');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const allConfirmed = rooms.length > 0 && rooms.every((r) => r.confirmed);
  const [rosterStatus, setRosterStatus] = useState<RosterStatus[]>([]);
  const [downloadingExcel, setDownloadingExcel] = useState(false);
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

  async function handleDownloadAllExcel() {
    setError(null);
    setDownloadingExcel(true);
    try {
      const seatsByRoom = await Promise.all(rooms.map((r) => listRoomSeats(r.id)));
      const exportData = rooms.map((r, i) => buildRoomExportData(r, seatsByRoom[i], classLabelMap));
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const usedNames = new Set<string>();
      function uniqueSheetName(base: string): string {
        let name = base.slice(0, 31);
        let n = 1;
        while (usedNames.has(name)) {
          const suffix = `(${n++})`;
          name = base.slice(0, 31 - suffix.length) + suffix;
        }
        usedNames.add(name);
        return name;
      }
      for (const data of exportData) {
        const signInAoa: (string | number)[][] = [
          ['班級', '原班座號', '學號', '姓名', '簽名'],
          ...data.signInRows.map((r) => [r.classLabel, r.classSeatNo ?? '', r.studentNo ?? '', r.name, '']),
        ];
        const signInWs = XLSX.utils.aoa_to_sheet(signInAoa);
        signInWs['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
        XLSX.utils.book_append_sheet(wb, signInWs, uniqueSheetName(`${data.roomName}簽到表`));

        const grid: string[][] = Array.from({ length: data.gridSize }, () => Array.from({ length: data.gridSize }, () => ''));
        for (const cell of data.seatGrid) {
          grid[cell.row][cell.col] = [cell.classLabel, cell.classSeatNo != null ? `座號${cell.classSeatNo}` : '', cell.name].filter(Boolean).join(' ');
        }
        const seatWs = XLSX.utils.aoa_to_sheet(grid);
        seatWs['!cols'] = Array.from({ length: data.gridSize }, () => ({ wch: 16 }));
        XLSX.utils.book_append_sheet(wb, seatWs, uniqueSheetName(`${data.roomName}座位表`));
      }
      XLSX.writeFile(wb, `${session.name}_考場簽到表座位表.xlsx`);
    } catch (e: any) {
      setError('匯出 Excel 失敗：' + (e?.message ?? String(e)));
    } finally {
      setDownloadingExcel(false);
    }
  }

  if (loading) return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;

  const allRostersSubmitted = rosterStatus.length > 0 && rosterStatus.every((rs) => rs.submitted);

  return (
    <section style={{ borderTop: '2px solid #eee', paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 15 }}>
          {session.name}（{session.academic_year} {session.term}）
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {(session.status === '已發送' || session.status === '已完成') && (
            <button onClick={handleDownloadAllExcel} disabled={!allRostersSubmitted || downloadingExcel} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600 }}>
              {downloadingExcel ? '匯出中…' : '一鍵下載所有考場簽到表／座位表（Excel）'}
            </button>
          )}
        </div>
      </div>
      {(session.status === '已發送' || session.status === '已完成') && !allRostersSubmitted && (
        <p style={{ fontSize: 12, color: '#B08968', marginBottom: 8 }}>提示：所有班級都需完成【完成名單】送出後，才能一鍵下載 Excel。</p>
      )}

      {syncNotices.length > 0 && session.status === '編排中' && (
        <ul style={{ fontSize: 12, color: '#B08968', marginBottom: 8, paddingLeft: 18 }}>
          {syncNotices.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}

      {/* ---- 不擔任考場班級（批次勾選完，按【儲存】才會套用，下面的考場清單才會自動排除） ---- */}
      {session.status === '編排中' && (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>不擔任考場班級</div>
          <p style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>勾選的班級不會被自動建立成考場（教室不方便當考場時使用），但該班學生仍可以被安排到其他班級的考場應試。勾選完按【儲存】後，下面的考場清單才會套用。</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 4, maxHeight: 160, overflowY: 'auto', marginBottom: 8 }}>
            {classOptions.map((c) => (
              <label key={c.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={pendingExcludedIds.has(c.id)} disabled={savingExcluded} onChange={() => toggleExcludedPending(c.id)} />
                {c.label}（{c.headcount}人）
              </label>
            ))}
          </div>
          <button onClick={handleSaveExcluded} disabled={savingExcluded || !excludedDirty} style={{ fontSize: 13, padding: '5px 14px', fontWeight: 600 }}>
            {savingExcluded ? '儲存中…' : '儲存'}
          </button>
          {excludedDirty && !savingExcluded && <span style={{ fontSize: 12, color: '#B08968', marginLeft: 8 }}>有尚未儲存的變更</span>}
        </div>
      )}

      {/* ---- 考場清單（所有班級自動設為考場，座位數＝該班目前在校人數） ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
        {rooms.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>目前沒有可用的考場（可能是還沒有任何班級有在校學生）。</p>}
        {rooms.map((room) => {
          const myClasses = roomClasses.filter((rc) => rc.exam_room_id === room.id);
          const submittedCount = rosterStatus.filter((rs) => myClasses.some((mc) => mc.class_id === rs.class_id) && rs.submitted).length;
          const ownerId = labelToClassId[room.room_name];
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
                  {(session.status === '已發送' || session.status === '已完成') && (
                    <button onClick={() => setDetailRoomId(room.id)} style={{ fontSize: 12, padding: '3px 10px' }}>
                      預覽／列印
                    </button>
                  )}
                </div>
              </div>

              {/* ---- 步驟2：應試班級選單，直接展開在考場旁邊，最多4班；考場自己的班級一定包含，
                    勾選其他班級後對方的考場也會自動連動勾選回來 ---- */}
              {session.status === '編排中' ? (
                ownerId ? (
                  <GroupPicker room={room} ownerId={ownerId} classOptions={classOptions} groups={groups} onToggle={handleToggleGroup} />
                ) : (
                  <p style={{ fontSize: 12, color: '#A32D2D', marginTop: 4 }}>找不到對應的班級資料（該班可能已異動），請重新整理頁面。</p>
                )
              ) : (
                myClasses.length > 0 && (
                  <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    應試班級：{myClasses.map((mc) => `${classLabelMap[mc.class_id] ?? mc.class_id}(${mc.allocated_count}人)`).join('、')}
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>

      {session.status === '編排中' && rooms.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button onClick={handleSaveGroups} disabled={savingGroups || !groupsDirty} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600 }}>
            {savingGroups ? '儲存中…' : '儲存應試班級'}
          </button>
          {groupsDirty && <span style={{ fontSize: 12, color: '#B08968', marginLeft: 8 }}>有尚未儲存的變更</span>}
        </div>
      )}

      {/* ---- 步驟3-4：試算各考場人數＋雙驗證（依分組簡化，只顯示有共用考場的班級群組） ---- */}
      {session.status === '編排中' && roomClasses.length > 0 && (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ fontSize: 13 }}>試算各考場人數（可手動修改，橫向／縱向加總一致才能儲存）</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={runComputation} style={{ fontSize: 12, padding: '4px 12px' }}>
                依座位數比例試算
              </button>
              {matrix && (
                <button onClick={handleAutoBalance} style={{ fontSize: 12, padding: '4px 12px' }}>
                  自動調整
                </button>
              )}
            </div>
          </div>
          {matrix &&
            (() => {
              const multiGroups = savedGroups.filter((g) => g.length > 1);
              if (multiGroups.length === 0) {
                return <p style={{ fontSize: 12, color: '#999' }}>目前沒有共用考場的班級群組（每班都各自使用自己的考場，人數自動等於班級人數，不需要試算）。</p>;
              }
              return multiGroups.map((group, i) => {
                const groupRooms = group.map((cid) => rooms.find((r) => r.room_name === classLabelMap[cid])).filter((r): r is ExamRoom => !!r);
                const groupClassOptions = classOptions.filter((c) => group.includes(c.id));
                return (
                  <div key={i} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>群組：{groupClassOptions.map((c) => c.label).join('、')}</div>
                    <AllocationMatrix matrix={matrix} rooms={groupRooms} classOptions={groupClassOptions} onEditCell={editMatrixCell} />
                  </div>
                );
              });
            })()}
          {matrix && validation && !validation.horizontalOk && (
            <ul style={{ fontSize: 12, color: '#A32D2D', marginTop: 6 }}>
              {validation.horizontalErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {matrix && validation && !validation.verticalOk && (
            <ul style={{ fontSize: 12, color: '#A32D2D', marginTop: 6 }}>
              {validation.verticalErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
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

      {/* ---- 步驟5-6：瀏覽所有考場的梅花座位表，一鍵確認（必要時可先手動微調）；全部確認後就近發送考場表 ---- */}
      {session.status === '編排中' && rooms.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button onClick={() => setAllRoomsReviewOpen(true)} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600 }}>
            瀏覽所有考場座位表並一鍵確認
          </button>
          <button onClick={handleSend} disabled={!allConfirmed} style={{ fontSize: 13, padding: '6px 16px', fontWeight: 600, marginLeft: 8 }}>
            發送考場表
          </button>
          <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>
            {rooms.filter((r) => r.confirmed).length}/{rooms.length} 個考場已確認
          </span>
          {!allConfirmed && <p style={{ fontSize: 12, color: '#B08968', marginTop: 6 }}>提示：所有考場都需完成座位表【確認】後，才能發送考場表。</p>}
        </div>
      )}
      {allRoomsReviewOpen && (
        <AllRoomsSeatReview
          rooms={rooms.filter((r) => !r.confirmed && roomClasses.some((rc) => rc.exam_room_id === r.id && rc.allocated_count > 0))}
          roomClasses={roomClasses}
          classLabelMap={classLabelMap}
          onClose={() => setAllRoomsReviewOpen(false)}
          onConfirmedAll={async () => {
            setAllRoomsReviewOpen(false);
            setNotice('已確認所有考場的座位表');
            await reload();
          }}
          setError={setError}
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
// 應試班級選單：直接展開顯示在考場旁邊（不用另外開視窗），最多選 4 個班級。
// 考場自己的班級一定包含（不能取消）；勾選其他班級後，會維持對稱——
// 對方的考場也會自動連動勾選回來，形成一個互相共用考場的群組。
// ============================================================
function GroupPicker({
  room,
  ownerId,
  classOptions,
  groups,
  onToggle,
}: {
  room: ExamRoom;
  ownerId: string;
  classOptions: ClassOption[];
  groups: string[][];
  onToggle: (ownerId: string, targetId: string) => void;
}) {
  const group = findGroupOf(groups, ownerId);
  const ownerLabel = classOptions.find((c) => c.id === ownerId)?.label ?? room.room_name;
  const labelOf = (id: string) => classOptions.find((c) => c.id === id)?.label ?? id;

  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed #eee', paddingTop: 8 }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        應試班級（最多 {MAX_CLASSES_PER_ROOM} 班，已選 {group.length}/{MAX_CLASSES_PER_ROOM}）
      </div>
      <div style={{ fontSize: 12, color: '#2D6A2D', marginBottom: 4 }}>✓ {ownerLabel}（本班教室，一定包含）</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
        {classOptions
          .filter((c) => c.id !== ownerId)
          .map((c) => {
            const checked = group.includes(c.id);
            const elsewhereGroup = findGroupOf(groups, c.id);
            const takenElsewhere = !checked && elsewhereGroup.length > 1;
            const full = !checked && group.length >= MAX_CLASSES_PER_ROOM;
            const disabled = takenElsewhere || full;
            const title = takenElsewhere ? `已安排在「${elsewhereGroup.map(labelOf).join('、')}」共用考場` : undefined;
            return (
              <label key={c.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, color: disabled ? '#bbb' : '#333' }} title={title}>
                <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(ownerId, c.id)} />
                {c.label}（{c.headcount}人）
              </label>
            );
          })}
      </div>
    </div>
  );
}

// ============================================================
// 分配人數矩陣（班級 x 考場）
// ============================================================
function AllocationMatrix({
  matrix,
  rooms,
  classOptions,
  onEditCell,
}: {
  matrix: Record<string, Record<string, number>>;
  rooms: ExamRoom[];
  classOptions: ClassOption[];
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
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: '1px solid #eee', padding: '4px 8px', textAlign: 'center' };

// ============================================================
// 瀏覽所有考場的梅花座位表，一鍵確認（點兩個座位可以互換，必要時手動微調）
// ============================================================
function AllRoomsSeatReview({
  rooms,
  roomClasses,
  classLabelMap,
  onClose,
  onConfirmedAll,
  setError,
}: {
  rooms: ExamRoom[]; // 只包含尚未確認、且已經有分配人數的考場（＝啟用中的考場）
  roomClasses: ExamRoomClass[];
  classLabelMap: Record<string, string>;
  onClose: () => void;
  onConfirmedAll: () => Promise<void> | void;
  setError: (m: string | null) => void;
}) {
  const [layouts, setLayouts] = useState<Record<string, SeatCell[]>>({});
  const [selected, setSelected] = useState<{ roomId: string; seatNo: number } | null>(null);
  const [saving, setSaving] = useState(false);

  function generateOne(room: ExamRoom): SeatCell[] {
    const myClasses = roomClasses.filter((rc) => rc.exam_room_id === room.id);
    return generateSeatLayout({
      gridSize: room.grid_size,
      capacity: room.seat_capacity,
      classCounts: myClasses.map((rc) => ({ classId: rc.class_id, count: rc.allocated_count })),
    });
  }

  useEffect(() => {
    const initial: Record<string, SeatCell[]> = {};
    for (const room of rooms) initial[room.id] = generateOne(room);
    setLayouts(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function regenerate(roomId: string) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    setLayouts((prev) => ({ ...prev, [roomId]: generateOne(room) }));
    setSelected(null);
  }

  function handleSeatClick(roomId: string, seatNo: number) {
    if (!selected || selected.roomId !== roomId) {
      setSelected({ roomId, seatNo });
      return;
    }
    if (selected.seatNo === seatNo) {
      setSelected(null); // 再點一次同一格＝取消選取
      return;
    }
    // 點第二格：互換這兩個座位目前坐的班級（同一考場內），人數不會因此改變
    setLayouts((prev) => {
      const seats = prev[roomId].map((s) => ({ ...s }));
      const a = seats.find((s) => s.seatNo === selected.seatNo)!;
      const b = seats.find((s) => s.seatNo === seatNo)!;
      const tmp = a.classId;
      a.classId = b.classId;
      b.classId = tmp;
      return { ...prev, [roomId]: seats };
    });
    setSelected(null);
  }

  async function confirmAll() {
    setSaving(true);
    setError(null);
    try {
      await Promise.all(rooms.map((room) => confirmRoomSeatLayout(room.id, layouts[room.id] ?? [])));
      await onConfirmedAll();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (rooms.length === 0) {
    return (
      <ModalShell title="所有考場座位表" onClose={onClose}>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可以確認的考場（可能都已確認，或還沒有考場已儲存分配人數）。</p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`所有考場座位表（共 ${rooms.length} 間）`} onClose={onClose}>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
        點一個座位、再點另一個座位可以互換兩人的座位（僅限同一個考場內）；每間考場也可以單獨按【重新排列】。確認後會直接套用到全部考場。
      </p>
      {rooms.map((room) => {
        const myClasses = roomClasses.filter((rc) => rc.exam_room_id === room.id);
        const colorFor: Record<string, string> = {};
        const palette = ['#F4D7C3', '#CDE7D8', '#CFE0F4', '#F4EBC3', '#E3D3F4', '#F4C3D7', '#C3F4E9', '#DDE0E3'];
        myClasses.forEach((rc, i) => (colorFor[rc.class_id] = palette[i % palette.length]));
        return (
          <div key={room.id} style={{ marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
              <strong style={{ fontSize: 13 }}>
                {room.room_name}（{room.grid_size}×{room.grid_size}）
              </strong>
              <button onClick={() => regenerate(room.id)} style={{ fontSize: 12, padding: '3px 10px' }}>
                重新排列
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6, fontSize: 12 }}>
              {myClasses.map((rc) => (
                <span key={rc.class_id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 12, height: 12, background: colorFor[rc.class_id], display: 'inline-block', borderRadius: 2 }} />
                  {classLabelMap[rc.class_id] ?? rc.class_id}（{rc.allocated_count}人）
                </span>
              ))}
            </div>
            <SeatGrid
              gridSize={room.grid_size}
              seats={layouts[room.id] ?? []}
              colorFor={colorFor}
              labelFor={(classId) => (classId ? classLabelMap[classId] ?? '' : '')}
              onSeatClick={(seatNo) => handleSeatClick(room.id, seatNo)}
              highlightSeatNo={selected?.roomId === room.id ? selected.seatNo : undefined}
            />
          </div>
        );
      })}
      <button onClick={confirmAll} disabled={saving} style={{ fontSize: 14, padding: '8px 20px', fontWeight: 600 }}>
        {saving ? '確認中…' : `一鍵確認全部（${rooms.length} 間考場）`}
      </button>
    </ModalShell>
  );
}

function SeatGrid({
  gridSize,
  seats,
  colorFor,
  labelFor,
  seatContent,
  onSeatClick,
  highlightSeatNo,
}: {
  gridSize: number;
  seats: { row: number; col: number; seatNo: number; classId: string | null }[];
  colorFor: Record<string, string>;
  labelFor: (classId: string | null) => string;
  seatContent?: (seatNo: number) => React.ReactNode;
  onSeatClick?: (seatNo: number) => void;
  highlightSeatNo?: number;
}) {
  const bySeat = new Map<string, (typeof seats)[number]>();
  seats.forEach((s) => bySeat.set(`${s.row}-${s.col}`, s));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridSize}, 56px)`, gap: 4 }}>
      {Array.from({ length: gridSize }).map((_, row) =>
        Array.from({ length: gridSize }).map((__, col) => {
          const seat = bySeat.get(`${row}-${col}`);
          if (!seat) return <div key={`${row}-${col}`} style={{ width: 56, height: 44 }} />;
          const highlighted = highlightSeatNo === seat.seatNo;
          return (
            <div
              key={`${row}-${col}`}
              onClick={onSeatClick ? () => onSeatClick(seat.seatNo) : undefined}
              style={{
                width: 56,
                height: 44,
                border: highlighted ? '2px solid #B08968' : '1px solid #ccc',
                borderRadius: 4,
                background: seat.classId ? colorFor[seat.classId] ?? '#eee' : '#f7f7f7',
                fontSize: 10,
                padding: 2,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                cursor: onSeatClick ? 'pointer' : 'default',
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
    const signInRows = buildSignInRows(seats, classLabelMap);
    const bodyRows = signInRows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.classLabel)}</td><td>${escapeHtml(r.classSeatNo ?? '')}</td><td>${escapeHtml(r.studentNo ?? '')}</td><td>${escapeHtml(
            r.name
          )}</td><td></td></tr>`
      )
      .join('');

    const bySeat = new Map(seats.map((s) => [`${s.row_no}-${s.col_no}`, s]));
    let gridHtml = `<div style="display:grid;grid-template-columns:repeat(${room.grid_size}, 1fr);gap:3px;margin-top:10px;">`;
    for (let row = 0; row < room.grid_size; row++) {
      for (let col = 0; col < room.grid_size; col++) {
        const seat = bySeat.get(`${row}-${col}`);
        if (!seat) {
          gridHtml += `<div style="border:1px solid #ddd;border-radius:3px;height:52px;"></div>`;
          continue;
        }
        const stu = seat.exam_seat_students;
        const cls = seat.class_id ? classLabelMap[seat.class_id] ?? '' : '';
        gridHtml += `<div style="border:1px solid #999;border-radius:3px;height:52px;padding:2px;font-size:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
          <div style="color:#666;">#${seat.seat_no}</div>
          <div style="font-weight:600;">${escapeHtml(cls)}</div>
          <div>${stu?.class_seat_no != null ? `座號${escapeHtml(stu.class_seat_no)} ` : ''}${escapeHtml(stu?.students?.name ?? '')}</div>
        </div>`;
      }
    }
    gridHtml += `</div>`;

    w.document.write(`
      <html><head><title>${escapeHtml(examSessionName)}－${escapeHtml(room.room_name)}</title>
      <style>
        @page { size: A4; margin: 12mm; }
        body{font-family:sans-serif;padding:0;font-size:12px;}
        h1{font-size:16px;margin:0 0 2px;} h2{font-size:12px;color:#666;margin:0 0 8px;font-weight:400;}
        h3{font-size:13px;margin:14px 0 4px;}
        table{border-collapse:collapse;width:100%;margin-top:4px;}
        td,th{border:1px solid #999;padding:3px 6px;font-size:11px;text-align:center;}
        .page{page-break-inside:avoid;}
      </style></head><body>
      <div class="page">
        <h1>${escapeHtml(examSessionName)}</h1>
        <h2>考場：${escapeHtml(room.room_name)}（座位數 ${room.seat_capacity}）</h2>
        <h3>座位表</h3>
        ${gridHtml}
        <h3>簽到表（依班級、原班座號排序）</h3>
        <table><thead><tr><th>班級</th><th>原班座號</th><th>學號</th><th>姓名</th><th>簽名</th></tr></thead>
        <tbody>${bodyRows}</tbody></table>
      </div>
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
              const cls = seat?.class_id ? classLabelMap[seat.class_id] : '';
              return (
                <>
                  <div style={{ fontWeight: 600 }}>{cls}</div>
                  <div>
                    {stu?.class_seat_no != null ? `座號${stu.class_seat_no} ` : ''}
                    {stu?.students?.name ?? ''}
                  </div>
                </>
              );
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
