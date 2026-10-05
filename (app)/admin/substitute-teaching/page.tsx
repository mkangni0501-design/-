'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';
import { resolveCurrentTerm } from '@/lib/academicTerm';

// 代課安排：登記某節課由誰代課。
//
// 【2026-08-10 修正／重寫】這輪處理兩個問題：
// 1.「代課安排頁缺乏請假的節次與代課教師名字」——原本近期代課紀錄那張表是用 PostgREST
//    的 FK 關聯語法（teachers!xxx_fkey(name)）內嵌撈教師姓名，這種寫法在多個外鍵指到
//    同一張表（original_teacher_id／substitute_teacher_id 都指到 teachers）時很容易因為
//    Supabase 版本或關聯快取沒更新而整欄查不到、直接顯示空白。這裡改成穩紮穩打的作法：
//    分開查代課紀錄（只帶 id）跟教師名單，再自己用 Map 對應姓名，不依賴 PostgREST 猜
//    關聯，節次(period_no)本來就是自己的欄位，一定讀得到——這樣「節次」跟「代課教師
//    名字」就不會再因為關聯語法問題而顯示空白。
// 2.「無同一天批次排代功能」——原本一次只能選一位請假教師來安排代課。現在改成「同一天
//    批次代課安排」：先選好日期，可以一次加入好幾位請假教師（例如今天有3位老師請假），
//    每位老師底下各自勾選要代課的節次、各自指定代課教師，最後一次「批次送出」全部
//    建立，不用一位一位分開跑完整流程。
//
// 需先執行 sql/23academic_terms_and_substitute_teaching.sql（原始資料表/RPC）
// 及 sql/31substitute_notifications.sql（完成代課後自動通知相關教師，只有「直接寫入」
// 生效那一刻會觸發；送審中的申請要等核准後才會發通知）。

type TeacherOption = { id: string; name: string };
type PeriodOption = { class_id: string; period_no: number; subject: string; classLabel: string };
type AssignmentRow = {
  id: string;
  substitute_date: string;
  period_no: number;
  subject: string;
  status: string;
  reason: string | null;
  original_teacher_id: string;
  substitute_teacher_id: string;
  classes: { class_name: string; grade_level: string } | null;
};

type BatchEntry = {
  key: string;
  teacherId: string;
  teacherName: string;
  periodOptions: PeriodOption[];
  loadingPeriods: boolean;
  periodNote: string;
  selectedPeriods: Set<number>;
  availableTeachers: TeacherOption[] | null;
  availableNote: string;
  substituteTeacherId: string;
  showAllTeachersFallback: boolean;
  reason: string;
};

const WEEKDAY_LABEL = ['', '一', '二', '三', '四', '五', '六', '日'];

// JS Date.getDay()：0=週日...6=週六。系統其他地方（weekday 欄位）用 1=一...7=日，這裡統一轉換，
// 避免使用者自己選「星期幾」又跟日期挑到的星期對不上。
function weekdayOfDate(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00');
  const js = d.getDay(); // 0..6
  return js === 0 ? 7 : js;
}

function newEntry(teacherId: string, teacherName: string): BatchEntry {
  return {
    key: teacherId,
    teacherId,
    teacherName,
    periodOptions: [],
    loadingPeriods: false,
    periodNote: '',
    selectedPeriods: new Set(),
    availableTeachers: null,
    availableNote: '',
    substituteTeacherId: '',
    showAllTeachersFallback: false,
    reason: '',
  };
}

export default function SubstituteTeachingPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [teacherNameById, setTeacherNameById] = useState<Record<string, string>>({});
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentTerm, setCurrentTerm] = useState<{ academic_year: number; term: string } | null>(null);
  const [useOtherTerm, setUseOtherTerm] = useState(false);
  const [otherYear, setOtherYear] = useState<number>(new Date().getFullYear());
  const [otherTerm, setOtherTerm] = useState<'上學期' | '下學期'>('上學期');
  const effectiveYear = useOtherTerm ? otherYear : currentTerm?.academic_year;
  const effectiveTerm = useOtherTerm ? otherTerm : currentTerm?.term;

  // ---------- 同一天批次代課安排 ----------
  const [leaveDate, setLeaveDate] = useState('');
  const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [addTeacherId, setAddTeacherId] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    // 【2026-08 修正】原本直接呼叫 supabase.rpc('current_academic_term')，還沒有人
    // 到「學年學期設定」頁按過「設為目前生效」時就會查無資料，currentTerm 一直是
    // null，導致下面選節次/送出代課安排全部被擋下（見 loadPeriodsForEntry 等處的
    // effectiveYear/effectiveTerm guard）——這就是「完全無法進行代課安排」的根因。
    // 改用 resolveCurrentTerm()，查無「目前生效」時會自動退回最合理的一筆。
    const [{ data: teacherData }, currentTermResolved, { data: assignmentData, error }] = await Promise.all([
      supabase.from('teachers').select('id, name').order('name'),
      resolveCurrentTerm(),
      supabase
        .from('substitute_assignments')
        .select('id, substitute_date, period_no, subject, status, reason, original_teacher_id, substitute_teacher_id, classes(class_name, grade_level)')
        .order('substitute_date', { ascending: false })
        .limit(150),
    ]);
    const teacherList = (teacherData ?? []).map((t: any) => ({ id: t.id, name: t.name }));
    setTeachers(teacherList);
    setTeacherNameById(Object.fromEntries(teacherList.map((t: TeacherOption) => [t.id, t.name])));
    if (currentTermResolved) {
      setCurrentTerm(currentTermResolved);
      setOtherYear(currentTermResolved.academic_year);
      setOtherTerm(currentTermResolved.term as '上學期' | '下學期');
    }
    if (error) {
      setLoadError('讀取代課紀錄失敗：' + error.message + '（請確認 sql/23academic_terms_and_substitute_teaching.sql 是否已執行）');
    } else {
      setAssignments((assignmentData as any) ?? []);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // 換日期時，之前加入的請假教師名單清掉重來——代課日期是這個批次共用的，換日期表示重新規劃。
  useEffect(() => {
    setEntries([]);
  }, [leaveDate]);

  function updateEntry(key: string, patch: Partial<BatchEntry>) {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  async function loadPeriodsForEntry(key: string, teacherId: string) {
    if (!leaveDate || !effectiveYear || !effectiveTerm) return;
    updateEntry(key, { loadingPeriods: true, periodNote: '' });
    const weekday = weekdayOfDate(leaveDate);
    const { data, error } = await supabase
      .from('class_schedule')
      .select('class_id, period_no, subject, classes(grade_level, class_name)')
      .eq('teacher_id', teacherId)
      .eq('academic_year', effectiveYear)
      .eq('term', effectiveTerm)
      .eq('weekday', weekday)
      .order('period_no');
    if (error) {
      updateEntry(key, { loadingPeriods: false, periodNote: '查詢這位老師當天的課表失敗：' + error.message });
      return;
    }
    const opts = (data ?? []).map((r: any) => ({
      class_id: r.class_id,
      period_no: r.period_no,
      subject: r.subject,
      classLabel: r.classes ? `${r.classes.grade_level}${r.classes.class_name}` : '',
    }));
    updateEntry(key, {
      loadingPeriods: false,
      periodOptions: opts,
      selectedPeriods: new Set(opts.map((o) => o.period_no)), // 預設全部勾選，管理者可自行取消不需要代課的節次
      periodNote: opts.length === 0 ? `這位老師在 星期${WEEKDAY_LABEL[weekday]}（${leaveDate}）查不到排定的課，請確認「學校課表」是否已經排好這學期的課表。` : '',
    });
  }

  async function loadAvailableForEntry(key: string, entry: BatchEntry) {
    if (entry.selectedPeriods.size === 0 || !leaveDate || !effectiveYear || !effectiveTerm) {
      updateEntry(key, { availableTeachers: null, availableNote: '', substituteTeacherId: '' });
      return;
    }
    updateEntry(key, { availableTeachers: null, availableNote: '', substituteTeacherId: '', showAllTeachersFallback: false });
    const weekday = weekdayOfDate(leaveDate);
    const firstPeriod = Math.min(...Array.from(entry.selectedPeriods));
    const { data, error } = await supabase.rpc('available_substitute_teachers', {
      p_academic_year: effectiveYear,
      p_term: effectiveTerm,
      p_weekday: weekday,
      p_period_no: firstPeriod,
      p_date: leaveDate,
    });
    if (error) {
      updateEntry(key, { availableNote: '查詢空堂教師失敗：' + error.message });
      return;
    }
    // 同一批次裡，其他請假教師／已經被指定去代別堂課的老師，這節也不該再被列為候選人
    const busyIds = new Set<string>([entry.teacherId, ...entries.filter((e) => e.key !== key).map((e) => e.teacherId)]);
    const list = (data ?? []).map((r: any) => ({ id: r.teacher_id, name: r.teacher_name })).filter((t: TeacherOption) => !busyIds.has(t.id));
    updateEntry(key, {
      availableTeachers: list,
      availableNote:
        list.length === 0
          ? `第${firstPeriod}節（星期${WEEKDAY_LABEL[weekday]}）目前查不到空堂老師，可以按「改成從全體教師選擇」手動指定（請自行確認對方那節是否真的沒課）。`
          : entry.selectedPeriods.size > 1
          ? `以下是第${firstPeriod}節（勾選節次中最早一節）查到的空堂老師，若代課教師在其他勾選節次仍有課，請人工確認。`
          : '',
    });
  }

  function togglePeriod(entry: BatchEntry, period_no: number) {
    const next = new Set(entry.selectedPeriods);
    if (next.has(period_no)) next.delete(period_no);
    else next.add(period_no);
    updateEntry(entry.key, { selectedPeriods: next });
  }

  // 節次勾選變動後，重新查一次空堂教師
  useEffect(() => {
    entries.forEach((e) => {
      loadAvailableForEntry(e.key, e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.map((e) => `${e.key}:${Array.from(e.selectedPeriods).sort().join(',')}`).join('|')]);

  function handleAddTeacher() {
    if (!addTeacherId) return;
    if (entries.some((e) => e.teacherId === addTeacherId)) {
      alert('這位老師已經在這個批次裡了');
      return;
    }
    const t = teachers.find((t) => t.id === addTeacherId);
    if (!t) return;
    const entry = newEntry(t.id, t.name);
    setEntries((prev) => [...prev, entry]);
    setAddTeacherId('');
    loadPeriodsForEntry(entry.key, t.id);
  }

  function handleRemoveEntry(key: string) {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }

  async function handleBatchSubmit() {
    if (!leaveDate) {
      alert('請先選擇請假日期');
      return;
    }
    if (entries.length === 0) {
      alert('請至少加入一位請假教師');
      return;
    }
    if (!effectiveYear || !effectiveTerm) {
      alert('讀不到目前生效的學年學期，請稍後再試、或勾選上方「這個日期不屬於目前這學期」自行指定');
      return;
    }
    if (!perms.userId) {
      alert('讀不到目前登入身分，請重新整理頁面');
      return;
    }
    const missing = entries.filter((e) => e.selectedPeriods.size > 0 && !e.substituteTeacherId);
    if (missing.length > 0) {
      alert(`「${missing.map((e) => e.teacherName).join('、')}」還沒選代課教師，請選好再送出`);
      return;
    }
    const usable = entries.filter((e) => e.selectedPeriods.size > 0 && e.substituteTeacherId);
    if (usable.length === 0) {
      alert('目前沒有勾選任何節次，請至少勾選一節');
      return;
    }

    setBusy(true);
    const weekday = weekdayOfDate(leaveDate);
    const errors: string[] = [];
    let pendingCount = 0;
    let okCount = 0;
    for (const entry of usable) {
      const rowsToCreate = entry.periodOptions.filter((p) => entry.selectedPeriods.has(p.period_no));
      for (const p of rowsToCreate) {
        const payload = {
          academic_year: effectiveYear,
          term: effectiveTerm,
          class_id: p.class_id,
          weekday,
          period_no: p.period_no,
          subject: p.subject,
          original_teacher_id: entry.teacherId,
          substitute_teacher_id: entry.substituteTeacherId,
          substitute_date: leaveDate,
          reason: entry.reason || null,
          created_by: perms.userId,
        };
        const { error, pending } = await writeGoverned('substitute_assignments', 'insert', payload, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
        });
        if (error) errors.push(`${entry.teacherName} 第${p.period_no}節：${error}`);
        else if (pending) pendingCount++;
        else okCount++;
      }
    }
    setBusy(false);

    if (errors.length > 0) alert('部分節次新增失敗：\n' + errors.join('\n'));
    if (okCount > 0) alert(`已成功安排 ${okCount} 節代課。`);
    if (pendingCount > 0) alert(`已送出 ${pendingCount} 節代課申請，等教務主管核准後才會生效並發送通知。`);
    // 完成後（直接寫入的部分）會由資料庫的觸發器自動發站內通知給原任課教師與代課教師
    // （見 sql/31substitute_notifications.sql）；送審中的部分要等核准後才會觸發。
    setLeaveDate('');
    setEntries([]);
    await load();
  }

  async function handleCancel(row: AssignmentRow) {
    if (!perms.userId) return;
    const { error, pending } = await writeGoverned(
      'substitute_assignments',
      'update',
      { status: '已取消' },
      {
        myDepartments: perms.myDepartments,
        isSystemAdmin: perms.isSystemAdmin,
        requestedBy: perms.userId,
        recordKey: row.id,
        beforeSnapshot: row,
      }
    );
    if (error) {
      alert('取消失敗：' + error);
      return;
    }
    if (pending) alert('已送出取消申請，等教務主管核准後才會真正取消。');
    await load();
  }

  if (perms.loading) return null;

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>代課安排</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 20 }}>
        先選好日期，再依序加入當天請假的老師——可以一次加入好幾位，各自勾選要代課的節次、各自指定代課教師（系統會直接列出這節真的沒課的老師供您挑選），最後一次「批次送出」全部建立。完成安排後，會自動發站內通知給原任課教師與代課教師。屬教務部門權限。
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，這裡的新增／取消會先送給教務主管核准，核准後才會生效並發出通知。
        </p>
      )}
      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />
      <MyPendingChangesList userId={perms.userId ?? ''} tableName="substitute_assignments" />

      <section id="batch-assign" style={{ border: '1px solid #eee', borderRadius: 6, padding: 16, marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>同一天批次代課安排</h2>

        <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input type="checkbox" checked={useOtherTerm} onChange={(e) => setUseOtherTerm(e.target.checked)} />
          這個日期不屬於目前這學期（自行指定學年度／學期）
        </label>
        {useOtherTerm && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input type="number" value={otherYear} onChange={(e) => setOtherYear(Number(e.target.value))} style={{ padding: 6, width: 90 }} placeholder="學年度" />
            <select value={otherTerm} onChange={(e) => setOtherTerm(e.target.value as any)} style={{ padding: 6 }}>
              <option value="上學期">上學期</option>
              <option value="下學期">下學期</option>
            </select>
          </div>
        )}
        {!useOtherTerm && currentTerm && (
          <p style={{ fontSize: 11, color: '#999', marginBottom: 10 }}>
            目前依系統設定的生效學期：{currentTerm.academic_year} 學年度／{currentTerm.term}
          </p>
        )}

        <label style={{ display: 'block', marginBottom: 14, fontSize: 13 }}>
          請假日期
          <input type="date" value={leaveDate} onChange={(e) => setLeaveDate(e.target.value)} style={{ display: 'block', padding: 6, marginTop: 4 }} />
        </label>

        {leaveDate && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
              <select value={addTeacherId} onChange={(e) => setAddTeacherId(e.target.value)} style={{ padding: 6, flex: 1, maxWidth: 260 }}>
                <option value="">選擇請假教師加入這批次…</option>
                {teachers
                  .filter((t) => !entries.some((e) => e.teacherId === t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <button type="button" onClick={handleAddTeacher} disabled={!addTeacherId} style={{ padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>
                加入
              </button>
            </div>

            {entries.map((entry) => (
              <div key={entry.key} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 12, marginBottom: 12, background: '#fafafa' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>{entry.teacherName}</strong>
                  <button type="button" onClick={() => handleRemoveEntry(entry.key)} style={{ fontSize: 12, color: '#A32D2D', cursor: 'pointer', background: 'none', border: 'none' }}>
                    移除
                  </button>
                </div>

                {entry.loadingPeriods && <p style={{ fontSize: 12, color: '#999' }}>查詢當天課表中…</p>}
                {entry.periodNote && <p style={{ fontSize: 12, color: '#A36A00' }}>{entry.periodNote}</p>}
                {entry.periodOptions.length > 0 && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                    {entry.periodOptions.map((p) => (
                      <label key={p.period_no} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={entry.selectedPeriods.has(p.period_no)} onChange={() => togglePeriod(entry, p.period_no)} />
                        第{p.period_no}節（{p.classLabel}／{p.subject}）
                      </label>
                    ))}
                  </div>
                )}

                {entry.selectedPeriods.size > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <p style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>代課教師：</p>
                    {entry.availableNote && <p style={{ fontSize: 12, color: '#A36A00', marginBottom: 6 }}>{entry.availableNote}</p>}
                    {entry.availableTeachers === null && <p style={{ fontSize: 12, color: '#999' }}>查詢中…</p>}
                    {entry.availableTeachers && entry.availableTeachers.length > 0 && !entry.showAllTeachersFallback && (
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {entry.availableTeachers.map((t) => (
                          <label key={t.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="radio"
                              name={`substitute-${entry.key}`}
                              checked={entry.substituteTeacherId === t.id}
                              onChange={() => updateEntry(entry.key, { substituteTeacherId: t.id })}
                            />
                            {t.name}
                          </label>
                        ))}
                      </div>
                    )}
                    {(entry.showAllTeachersFallback || (entry.availableTeachers && entry.availableTeachers.length === 0)) && (
                      <select
                        value={entry.substituteTeacherId}
                        onChange={(e) => updateEntry(entry.key, { substituteTeacherId: e.target.value })}
                        style={{ padding: 6, marginTop: 4 }}
                      >
                        <option value="">從全體教師選擇（請自行確認是否真的沒課）</option>
                        {teachers
                          .filter((t) => t.id !== entry.teacherId)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {entry.availableTeachers && entry.availableTeachers.length > 0 && !entry.showAllTeachersFallback && (
                      <button
                        type="button"
                        onClick={() => updateEntry(entry.key, { showAllTeachersFallback: true })}
                        style={{ display: 'block', marginTop: 6, fontSize: 12, padding: '3px 10px', background: 'transparent', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}
                      >
                        改成從全體教師選擇
                      </button>
                    )}
                  </div>
                )}

                <input
                  value={entry.reason}
                  onChange={(e) => updateEntry(entry.key, { reason: e.target.value })}
                  placeholder="請假事由（例：病假，選填）"
                  style={{ padding: 6, fontSize: 13, width: '100%', maxWidth: 300 }}
                />
              </div>
            ))}

            {entries.length > 0 && (
              <button type="button" onClick={handleBatchSubmit} disabled={busy} style={{ padding: '8px 18px', fontSize: 13, cursor: 'pointer' }}>
                {busy ? '處理中…' : `批次送出（共 ${entries.length} 位教師）`}
              </button>
            )}
          </>
        )}
      </section>

      <section id="recent-history">
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>近期代課紀錄</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>日期</th>
              <th style={{ padding: 8 }}>班級</th>
              <th style={{ padding: 8 }}>節次</th>
              <th style={{ padding: 8 }}>科目</th>
              <th style={{ padding: 8 }}>請假教師</th>
              <th style={{ padding: 8 }}>代課教師</th>
              <th style={{ padding: 8 }}>請假理由</th>
              <th style={{ padding: 8 }}>狀態</th>
              <th style={{ padding: 8 }}></th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: 8 }}>{a.substitute_date}</td>
                <td style={{ padding: 8 }}>{a.classes ? `${a.classes.grade_level}${a.classes.class_name}` : '—'}</td>
                <td style={{ padding: 8 }}>第{a.period_no}節</td>
                <td style={{ padding: 8 }}>{a.subject}</td>
                <td style={{ padding: 8 }}>{teacherNameById[a.original_teacher_id] ?? '—'}</td>
                <td style={{ padding: 8 }}>{teacherNameById[a.substitute_teacher_id] ?? '—'}</td>
                <td style={{ padding: 8 }}>{a.reason || '—'}</td>
                <td style={{ padding: 8 }}>{a.status}</td>
                <td style={{ padding: 8 }}>
                  {a.status === '已排定' && (
                    <button onClick={() => handleCancel(a)} style={{ fontSize: 12, padding: '4px 10px' }}>
                      取消
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 16, color: '#999', textAlign: 'center' }}>
                  尚無代課紀錄
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
