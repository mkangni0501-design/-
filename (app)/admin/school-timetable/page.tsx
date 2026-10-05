'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { SCHOOL_TIMETABLE_SHEET_NAME } from '@/lib/excelTemplates';
import { resolveTeacherByName, uploadSchoolTimetableSheet } from '@/lib/bulkHandlers';
import ErrorBanner from '@/components/ErrorBanner';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type ClassOption = { id: string; label: string };
type ScheduleRow = {
  id: string;
  academic_year: number;
  term: string;
  weekday: number;
  period_no: number;
  subject: string;
  classes?: { grade_level: string; class_name: string };
  teachers?: { name: string };
};

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六'];

const emptyForm = {
  academic_year: new Date().getFullYear(),
  term: '上學期',
  class_id: '',
  weekday: 1,
  period_no: '',
  subject: '',
  teacher_name: '',
};

// 學校課表：管理每個班級每週各節次實際由哪位教師教哪一科（class_schedule，含星期/節次）。
// 供「學生出缺席輸入（一週出缺勤頁）」「手機版每日出缺勤登錄」判斷教師今天教哪些節次，
// 也是【代課安排】頁查詢「這節誰沒課可以代」的資料來源（都是查同一張 class_schedule）。
// 若只需要設定「誰教哪班哪科」而不需要指定星期/節次，請到「任課教師設定」頁。
// 只是想「查」哪位老師/哪個班級整週課表長怎樣（不需要修改），請到【查詢教師/班級課表】頁，
// 那頁開放給所有教職員，不需要教務部門權限。
export default function SchoolTimetableAdminPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchTeacherName, setBatchTeacherName] = useState('');

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }

  const [armedAction, setArmedAction] = useState<'delete' | 'edit' | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ successCount: number; errors: string[] } | null>(null);

  async function handleBulkUploadFile(file: File) {
    setUploading(true);
    setUploadResult(null);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames.find((n) => n === SCHOOL_TIMETABLE_SHEET_NAME || n === '學校課表(現況)') ?? wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      // 「學校課表(現況)」下載版只有1列表頭，跟可上傳範本（2列表頭）差1列，補一列空白對齊，
      // 兩種格式都能直接上傳，不用使用者自己另外調整。
      const rows = sheetName === '學校課表(現況)' ? [[], ...aoa] : aoa;
      const result = await uploadSchoolTimetableSheet(rows);
      setUploadResult(result);
    } catch (err: any) {
      setUploadResult({ successCount: 0, errors: [err.message ?? '上傳失敗'] });
    } finally {
      setUploading(false);
      load();
    }
  }

  async function handleBatchDelete() {
    if (selected.size === 0 || !perms.userId) return;
    if (canWriteDirect) {
      const { error } = await supabase.from('class_schedule').delete().in('id', Array.from(selected));
      setArmedAction(null);
      if (error) {
        alert('批次刪除失敗：' + error.message);
        return;
      }
    } else {
      for (const id of Array.from(selected)) {
        const row = rows.find((r) => r.id === id);
        await writeGoverned('class_schedule', 'delete', {}, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: id,
          beforeSnapshot: row ?? null,
        });
      }
      setArmedAction(null);
      alert(`已送出 ${selected.size} 筆刪除申請，等教務主管核准後才會真正刪除。`);
    }
    setSelected(new Set());
    load();
  }

  async function handleBatchChangeTeacher() {
    if (selected.size === 0 || !batchTeacherName.trim() || !perms.userId) return;
    const teacherId = await resolveTeacherByName(batchTeacherName);
    if (!teacherId) return;
    if (canWriteDirect) {
      const { error } = await supabase.from('class_schedule').update({ teacher_id: teacherId }).in('id', Array.from(selected));
      setArmedAction(null);
      if (error) {
        alert('批次修改失敗：' + error.message);
        return;
      }
    } else {
      for (const id of Array.from(selected)) {
        const row = rows.find((r) => r.id === id);
        await writeGoverned('class_schedule', 'update', { teacher_id: teacherId }, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: id,
          beforeSnapshot: row ?? null,
        });
      }
      setArmedAction(null);
      alert(`已送出 ${selected.size} 筆改任課教師申請，等教務主管核准後才會生效。`);
    }
    setBatchTeacherName('');
    setSelected(new Set());
    load();
  }

  async function load() {
    const { data, error } = await supabase
      .from('class_schedule')
      .select('id, academic_year, term, weekday, period_no, subject, class_id, teacher_id')
      .not('weekday', 'is', null)
      .order('academic_year', { ascending: false })
      .order('weekday')
      .order('period_no');
    setLoadError(error ? '讀取學校課表失敗：' + error.message : null);

    const { data: classRows } = await supabase.from('classes').select('id, academic_year, grade_level, class_name');
    const classList = (classRows ?? []) as any[];
    setClasses(classList.map((c) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` })));
    const classMap = new Map(classList.map((c) => [c.id, { grade_level: c.grade_level, class_name: c.class_name }]));

    const { data: teacherRows } = await supabase.from('teachers').select('id, name');
    const teacherMap = new Map((teacherRows ?? []).map((t: any) => [t.id, t.name]));

    setRows(
      (data ?? []).map((r: any) => ({
        ...r,
        classes: classMap.get(r.class_id),
        teachers: teacherMap.has(r.teacher_id) ? { name: teacherMap.get(r.teacher_id) } : undefined,
      }))
    );
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    try {
      const teacherId = await resolveTeacherByName(form.teacher_name);
      if (!teacherId) throw new Error('請填寫任課教師姓名');
      const payload = {
        class_id: form.class_id,
        academic_year: Number(form.academic_year),
        term: form.term,
        weekday: Number(form.weekday),
        period_no: Number(form.period_no),
        subject: form.subject,
        teacher_id: teacherId,
      };
      if (canWriteDirect) {
        const { error } = await supabase
          .from('class_schedule')
          .upsert(payload, { onConflict: 'class_id,academic_year,term,weekday,period_no' });
        if (error) throw new Error(error.message);
      } else {
        const existing = rows.find(
          (r) =>
            r.academic_year === payload.academic_year &&
            r.term === payload.term &&
            r.weekday === payload.weekday &&
            r.period_no === payload.period_no &&
            (r as any).class_id === payload.class_id
        );
        const { error, pending } = await writeGoverned(
          'class_schedule',
          existing ? 'update' : 'insert',
          payload,
          {
            myDepartments: perms.myDepartments,
            isSystemAdmin: perms.isSystemAdmin,
            requestedBy: perms.userId,
            recordKey: existing?.id,
            beforeSnapshot: existing ?? null,
          }
        );
        if (error) throw new Error(error);
        if (pending) alert('已送出申請，等教務主管核准後才會生效。');
      }
      setForm({ ...emptyForm, academic_year: form.academic_year, term: form.term, class_id: form.class_id });
      load();
    } catch (err: any) {
      alert('新增失敗：' + err.message);
    }
  }

  async function handleDelete(id: string) {
    if (!perms.userId) return;
    const row = rows.find((r) => r.id === id);
    if (canWriteDirect) {
      await supabase.from('class_schedule').delete().eq('id', id);
    } else {
      const { pending } = await writeGoverned('class_schedule', 'delete', {}, {
        myDepartments: perms.myDepartments,
        isSystemAdmin: perms.isSystemAdmin,
        requestedBy: perms.userId,
        recordKey: id,
        beforeSnapshot: row ?? null,
      });
      if (pending) alert('已送出刪除申請，等教務主管核准後才會真正刪除。');
    }
    setConfirmDeleteId(null);
    load();
  }

  if (perms.loading) return null;

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學校課表</h1>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        設定每個班級每週各節次實際由哪位教師教哪一科，一般由【排課系統】排課後自動寫入，這裡可以手動微調。
        這裡設定的星期/節次會用來判斷教師「今天」該登錄哪些節次的出缺勤。
      </p>

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，這裡的新增／修改／刪除會先送給教務主管核准。
        </p>
      )}
      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
        日常如果只是臨時異動（例如代課，建議改到【代課安排】頁登記，會自動通知相關教師），請直接用下面「手動新增單一堂課」，
        或在下方清單勾選後「批次修改教師」。
      </p>

      {canWriteDirect && (
        <div style={{ marginBottom: 20 }}>
          <h2 id="bulk-upload" style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>整批上傳（一鍵匯入／覆蓋）</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            上傳「{SCHOOL_TIMETABLE_SHEET_NAME}」範本，或「下載完整資料快照」裡的「學校課表(現況)」都可以直接上傳，同一格（班級/星期/節次）會直接覆蓋成上傳檔案裡的內容。
          </p>
          <input
            type="file"
            accept=".xlsx"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleBulkUploadFile(f);
              e.target.value = '';
            }}
          />
          {uploading && <p style={{ fontSize: 12, color: '#2C6E9E' }}>上傳中…</p>}
          {uploadResult && (
            <div style={{ fontSize: 12, marginTop: 8 }}>
              <p style={{ color: '#3B6D11' }}>成功寫入 {uploadResult.successCount} 筆</p>
              {uploadResult.errors.length > 0 && (
                <ul style={{ color: '#A32D2D', paddingLeft: 18 }}>
                  {uploadResult.errors.slice(0, 30).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {uploadResult.errors.length > 30 && <li>…還有 {uploadResult.errors.length - 30} 則錯誤</li>}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <h2 id="manual-add" style={{ fontSize: 13, color: '#666', marginBottom: 8, marginTop: 8 }}>手動新增單一堂課</h2>
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          type="number"
          placeholder="學年度"
          value={form.academic_year}
          onChange={(e) => setForm({ ...form, academic_year: Number(e.target.value) })}
          style={{ width: 90, padding: 6 }}
          required
        />
        <select value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })} style={{ padding: 6 }} required>
          <option value="">選擇班級</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })} style={{ padding: 6 }}>
          {WEEKDAY_LABELS.map((w, i) => (
            <option key={w} value={i + 1}>
              星期{w}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="節次"
          value={form.period_no}
          onChange={(e) => setForm({ ...form, period_no: e.target.value })}
          style={{ width: 70, padding: 6 }}
          required
        />
        <input
          placeholder="科目"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          style={{ width: 100, padding: 6 }}
          required
        />
        <input
          placeholder="任課教師姓名（打字輸入，不存在會自動建立）"
          value={form.teacher_name}
          onChange={(e) => setForm({ ...form, teacher_name: e.target.value })}
          style={{ width: 240, padding: 6 }}
          required
        />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增課表' : '送出新增申請'}
        </button>
      </form>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="class_schedule" />}

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#666' }}>已選取 {selected.size} 筆</span>
          {armedAction === null && (
            <>
              <input
                placeholder="批次改任課教師姓名"
                value={batchTeacherName}
                onChange={(e) => setBatchTeacherName(e.target.value)}
                style={{ padding: 4, fontSize: 12, width: 200 }}
              />
              <button onClick={() => setArmedAction('edit')} style={{ fontSize: 12, padding: '4px 10px' }}>
                批次修改教師
              </button>
              <button onClick={() => setArmedAction('delete')} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                批次刪除
              </button>
              <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消選取
              </button>
            </>
          )}
          {armedAction === 'edit' && (
            <>
              <span style={{ fontSize: 12 }}>確定要把這 {selected.size} 筆的任課教師都改成「{batchTeacherName}」嗎？</span>
              <button onClick={handleBatchChangeTeacher} style={{ fontSize: 12, padding: '4px 10px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
          {armedAction === 'delete' && (
            <>
              <span style={{ fontSize: 12, color: '#A32D2D' }}>確定要刪除這 {selected.size} 筆嗎？此動作無法復原。</span>
              <button onClick={handleBatchDelete} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定刪除
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }}>
              <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleSelectAll} />
            </th>
            <th style={{ textAlign: 'left', padding: 6 }}>學年/學期</th>
            <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
            <th style={{ textAlign: 'left', padding: 6 }}>星期</th>
            <th style={{ textAlign: 'left', padding: 6 }}>節次</th>
            <th style={{ textAlign: 'left', padding: 6 }}>科目</th>
            <th style={{ textAlign: 'left', padding: 6 }}>任課教師</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} />
              </td>
              <td style={{ padding: 6 }}>{r.academic_year} {r.term}</td>
              <td style={{ padding: 6 }}>{r.classes ? `${r.classes.grade_level}${r.classes.class_name}` : '—'}</td>
              <td style={{ padding: 6 }}>星期{WEEKDAY_LABELS[r.weekday - 1] ?? r.weekday}</td>
              <td style={{ padding: 6 }}>{r.period_no}</td>
              <td style={{ padding: 6 }}>{r.subject}</td>
              <td style={{ padding: 6 }}>{r.teachers?.name ?? '—'}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>
                {confirmDeleteId === r.id ? (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <button onClick={() => handleDelete(r.id)} style={{ fontSize: 12, color: '#A32D2D' }}>
                      確定刪除
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} style={{ fontSize: 12 }}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDeleteId(r.id)} style={{ fontSize: 12 }}>
                    刪除
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
