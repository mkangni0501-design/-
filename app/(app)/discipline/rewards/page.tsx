'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentTeacherId } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { hasDepartment } from '@/lib/departments';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import ErrorBanner from '@/components/ErrorBanner';

// 獎懲登記（大功／小功／嘉獎／大過／小過／警告），可批次、最後填寫原因。
// - 訓導部門／系統管理員S（admin_a、admin_b 預設都掛在訓導部門）：全校任何班級、
//   6 種獎懲都能登記，可跨班勾選學生後一次送出。
// - 其他教師：只能對「自己有教過的班級」（導師班或排課過的班級）登記「嘉獎」「小功」，
//   單筆上限 1 小功；同樣可批次。這些限制在資料庫（sql/93）也有擋，不只是畫面限制。
// 點數採用 conduct_point_defaults 的數值（教師端由資料庫依此重算，不採用前端傳值）。

const ALL_TYPES = ['大功', '小功', '嘉獎', '大過', '小過', '警告'] as const;
const TEACHER_TYPES = ['嘉獎', '小功'] as const;
const FALLBACK_POINTS: Record<string, number> = { 嘉獎: 1, 小功: 3, 大功: 9, 警告: -1, 小過: -3, 大過: -9 };

type ClassOption = { id: string; label: string };
type StudentRow = { student_no: string; seat_no: number; name: string };
type RecentRow = { id: string; student_no: string; event_date: string; event_type: string; points: number; reason: string | null };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function RewardsPage() {
  const perms = useDepartmentPermissions();
  const isFull = perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'discipline');

  const [ready, setReady] = useState(false);
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({}); // student_no -> name（可跨班保留）
  const [eventType, setEventType] = useState<string>('嘉獎');
  const [eventDate, setEventDate] = useState(todayStr());
  const [reason, setReason] = useState('');
  const [pointDefaults, setPointDefaults] = useState<Record<string, number>>(FALLBACK_POINTS);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [nameByNo, setNameByNo] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typeOptions = isFull ? ALL_TYPES : TEACHER_TYPES;

  useEffect(() => {
    if (perms.loading) return;
    (async () => {
      setLoadError(null);
      const tid = await getCurrentTeacherId();
      setTeacherId(tid);

      const { data: defs } = await supabase.from('conduct_point_defaults').select('item, points');
      if (defs && defs.length > 0) {
        const map = { ...FALLBACK_POINTS };
        defs.forEach((d: any) => {
          if (d.item in map) map[d.item] = Number(d.points);
        });
        setPointDefaults(map);
      }

      let options: ClassOption[] = [];
      if (isFull) {
        const { data, error } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level')
          .order('class_name');
        if (error) setLoadError('讀取班級清單失敗：' + error.message);
        options = (data ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
      } else if (tid) {
        const [{ data: homeroom }, { data: sched }] = await Promise.all([
          supabase.from('classes').select('id').eq('homeroom_teacher_id', tid),
          supabase.from('class_schedule').select('class_id').eq('teacher_id', tid),
        ]);
        const ids = Array.from(
          new Set([...(homeroom ?? []).map((r: any) => r.id), ...(sched ?? []).map((r: any) => r.class_id)].filter(Boolean))
        );
        if (ids.length > 0) {
          const { data, error } = await supabase
            .from('classes')
            .select('id, academic_year, grade_level, class_name')
            .in('id', ids)
            .order('academic_year', { ascending: false })
            .order('grade_level')
            .order('class_name');
          if (error) setLoadError('讀取班級清單失敗：' + error.message);
          options = (data ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
        }
      }
      setClassOptions(options);
      setClassId(options[0]?.id ?? null);
      setEventType(isFull ? '嘉獎' : '嘉獎');
      setReady(true);
    })();
  }, [perms.loading, isFull]);

  async function loadRecent(studentNos: string[]) {
    if (studentNos.length === 0) {
      setRecent([]);
      return;
    }
    const { data } = await supabase
      .from('conduct_events')
      .select('id, student_no, event_date, event_type, points, reason')
      .in('student_no', studentNos)
      .order('event_date', { ascending: false })
      .limit(30);
    setRecent((data ?? []) as RecentRow[]);
  }

  useEffect(() => {
    if (!classId) {
      setStudents([]);
      return;
    }
    (async () => {
      const { data: enrollRaw, error } = await supabase
        .from('enrollments')
        .select('seat_no, student_no')
        .eq('class_id', classId)
        .eq('is_current', true)
        .order('seat_no');
      if (error) {
        setLoadError('讀取學生名單失敗：' + error.message);
        return;
      }
      const hidden = isFull ? new Set<string>() : await getHiddenStudentNos((enrollRaw ?? []).map((r: any) => r.student_no));
      const enroll = (enrollRaw ?? []).filter((r: any) => !hidden.has(r.student_no));
      const nos = enroll.map((r: any) => r.student_no);
      const { data: studs } = await supabase
        .from('students')
        .select('student_no, name')
        .in('student_no', nos.length > 0 ? nos : ['__none__']);
      const names = new Map((studs ?? []).map((s: any) => [s.student_no, s.name]));
      const rows: StudentRow[] = enroll.map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: names.get(r.student_no) ?? '（找不到姓名）',
      }));
      setStudents(rows);
      setNameByNo((prev) => {
        const next = { ...prev };
        rows.forEach((s) => (next[s.student_no] = s.name));
        return next;
      });
      loadRecent(nos);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, isFull]);

  const selectedCount = Object.keys(selected).length;
  const allInClassSelected = useMemo(
    () => students.length > 0 && students.every((s) => s.student_no in selected),
    [students, selected]
  );

  function toggleStudent(s: StudentRow) {
    setSelected((prev) => {
      const next = { ...prev };
      if (s.student_no in next) delete next[s.student_no];
      else next[s.student_no] = s.name;
      return next;
    });
  }
  function toggleAllInClass() {
    setSelected((prev) => {
      const next = { ...prev };
      if (allInClassSelected) students.forEach((s) => delete next[s.student_no]);
      else students.forEach((s) => (next[s.student_no] = s.name));
      return next;
    });
  }

  async function handleSubmit() {
    setMessage(null);
    if (selectedCount === 0) return alert('請先勾選學生。');
    if (!reason.trim()) return alert('請填寫原因。');
    if (!isFull && !(TEACHER_TYPES as readonly string[]).includes(eventType)) return alert('教師只能登記嘉獎或小功。');
    if (!isFull && !teacherId) return alert('找不到您的教師資料，無法登記。');

    const nos = Object.keys(selected);
    const ok = window.confirm(
      `確定為 ${nos.length} 位學生登記「${eventType}」（${eventDate}）？\n原因：${reason.trim()}\n\n登記後教師無法自行修改或刪除。`
    );
    if (!ok) return;

    setBusy(true);
    // 同一位學生同一天同一種獎懲只能有一筆（資料庫唯一限制），先查出已存在的並略過。
    const { data: existing } = await supabase
      .from('conduct_events')
      .select('student_no')
      .in('student_no', nos)
      .eq('event_date', eventDate)
      .eq('event_type', eventType);
    const existingSet = new Set((existing ?? []).map((r: any) => r.student_no));
    const toInsert = nos.filter((n) => !existingSet.has(n));
    if (toInsert.length === 0) {
      setBusy(false);
      setMessage('所選學生當天都已經登記過同一種獎懲，沒有新增任何紀錄。');
      return;
    }
    const points = pointDefaults[eventType] ?? FALLBACK_POINTS[eventType];
    const payload = toInsert.map((student_no) => ({
      student_no,
      event_date: eventDate,
      event_type: eventType,
      points,
      reason: reason.trim(),
      recorded_by: teacherId,
    }));
    const { error } = await supabase.from('conduct_events').insert(payload);
    setBusy(false);
    if (error) {
      alert('登記失敗：' + error.message);
      return;
    }
    setMessage(
      `已登記 ${toInsert.length} 位學生「${eventType}」` +
        (existingSet.size > 0 ? `；另有 ${existingSet.size} 位當天已登記過同一種獎懲，已略過` : '') +
        '。'
    );
    setSelected({});
    setReason('');
    loadRecent(students.map((s) => s.student_no));
  }

  if (perms.loading || !ready) {
    return (
      <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>獎懲登記</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        {isFull
          ? '訓導權限：可對全校任何學生登記大功、小功、嘉獎、大過、小過、警告，可跨班勾選後批次登記。'
          : '教師權限：只能對自己有教過的班級登記「嘉獎」或「小功」，單筆上限 1 小功；登記後無法自行修改或刪除。'}
      </p>
      <ErrorBanner message={loadError} />
      {message && <p style={{ fontSize: 13, color: '#3B6D11', marginBottom: 12 }}>{message}</p>}

      {classOptions.length === 0 ? (
        <p style={{ fontSize: 13, color: '#A36A2D' }}>
          目前沒有可登記的班級（教師需為導師或有排課的班級才能登記）。
        </p>
      ) : (
        <>
          <select
            value={classId ?? ''}
            onChange={(e) => setClassId(e.target.value)}
            style={{ padding: 8, marginBottom: 12, width: '100%', maxWidth: 320 }}
          >
            {classOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ width: 40, padding: 6 }}>
                  <input type="checkbox" checked={allInClassSelected} onChange={toggleAllInClass} title="全選／取消全選本班" />
                </th>
                <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.student_no} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input type="checkbox" checked={s.student_no in selected} onChange={() => toggleStudent(s)} />
                  </td>
                  <td style={{ padding: 6 }}>{s.seat_no}</td>
                  <td style={{ padding: 6 }}>{s.student_no}</td>
                  <td style={{ padding: 6 }}>{s.name}</td>
                </tr>
              ))}
              {students.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    這個班級目前沒有在學學生
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 12, maxWidth: 520 }}>
            <p style={{ fontSize: 13, marginBottom: 8 }}>
              已勾選 <b>{selectedCount}</b> 位學生
              {selectedCount > 0 && (
                <button onClick={() => setSelected({})} style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}>
                  清除勾選
                </button>
              )}
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <select value={eventType} onChange={(e) => setEventType(e.target.value)} style={{ padding: 8 }}>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}（{(pointDefaults[t] ?? FALLBACK_POINTS[t]) > 0 ? '+' : ''}
                    {pointDefaults[t] ?? FALLBACK_POINTS[t]}）
                  </option>
                ))}
              </select>
              <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={{ padding: 8 }} />
            </div>
            <textarea
              placeholder="原因（必填）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={{ width: '100%', padding: 8, marginBottom: 8 }}
            />
            <button
              onClick={handleSubmit}
              disabled={busy}
              style={{ padding: '8px 18px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}
            >
              {busy ? '登記中…' : '批次登記'}
            </button>
          </div>

          {recent.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2 style={{ fontSize: 14, marginBottom: 6 }}>本班最近的獎懲紀錄</h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 4 }}>{r.event_date}</td>
                      <td style={{ padding: 4 }}>{nameByNo[r.student_no] ?? r.student_no}</td>
                      <td style={{ padding: 4 }}>{r.event_type}</td>
                      <td style={{ padding: 4, color: '#666' }}>{r.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
