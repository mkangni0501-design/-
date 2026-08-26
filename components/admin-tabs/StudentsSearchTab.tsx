'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = { id: string; label: string; academic_year: number; grade_level: string; class_name: string };
type EnrolledStudent = {
  id: string;
  student_no: string;
  seat_no: number | null;
  term: string;
  students?: { name: string; gender: string | null };
  classes?: { id: string; academic_year: number; department: string; grade_level: string; class_name: string };
};

type StudentDetail = {
  student_no: string;
  name: string;
  gender: string | null;
  thai_name: string | null;
  dob: string | null;
  id_number: string | null;
  nationality: string | null;
  religion: string | null;
  blood_type: string | null;
  address: string | null;
  phone: string | null;
  previous_school: string | null;
  previous_school_grade: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

const EDIT_FIELDS: { key: keyof StudentDetail; label: string }[] = [
  { key: 'name', label: '姓名' },
  { key: 'gender', label: '性別' },
  { key: 'thai_name', label: '泰文姓名' },
  { key: 'dob', label: '出生日期' },
  { key: 'id_number', label: '身分證/護照號碼' },
  { key: 'nationality', label: '國籍' },
  { key: 'religion', label: '宗教' },
  { key: 'blood_type', label: '血型' },
  { key: 'address', label: '地址' },
  { key: 'phone', label: '電話' },
  { key: 'previous_school', label: '原就讀學校' },
  { key: 'previous_school_grade', label: '原就讀年級' },
];

const ATTENDANCE_ISSUE_STATUSES = ['曠課', '遲到', '病假', '事假', '公假'] as const;

// 查詢學生：全校或依班級查詢目前在學學生名冊，可用學號/姓名關鍵字搜尋，也可以直接修正學生資料。
// 資料來源跟「既有學生快速建檔」「班級與導師設定」共用同一份 enrollments/students/classes，
// 只要建檔/編班有寫入成功，這裡就查得到，也可以用來快速確認批次上傳的結果對不對。
export default function StudentSearchPage() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [students, setStudents] = useState<EnrolledStudent[]>([]);
  const [attendanceSummary, setAttendanceSummary] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [myAppUserId, setMyAppUserId] = useState<string | null>(null);
  const [myHomeroomClassIds, setMyHomeroomClassIds] = useState<Set<string>>(new Set());
  const [editorNames, setEditorNames] = useState<Record<string, string>>({});

  const [editingStudentNo, setEditingStudentNo] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<StudentDetail | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadMyPermissions() {
    const appUser = await getCurrentAppUser();
    if (!appUser) return;
    setMyAppUserId(appUser.id);
    setIsAdmin(isAdminInCurrentView(appUser.role));

    if (appUser.role === 'homeroom_teacher') {
      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (teacherRow) {
        const { data: myClasses } = await supabase.from('classes').select('id').eq('homeroom_teacher_id', teacherRow.id);
        setMyHomeroomClassIds(new Set((myClasses ?? []).map((c: any) => c.id)));
      }
    }
  }

  async function loadClasses() {
    const { data } = await supabase
      .from('classes')
      .select('id, academic_year, grade_level, class_name')
      .order('academic_year', { ascending: false })
      .order('grade_level');
    setClasses(
      (data ?? []).map((c: any) => ({
        id: c.id,
        label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
        academic_year: c.academic_year,
        grade_level: c.grade_level,
        class_name: c.class_name,
      }))
    );
  }

  async function loadStudents() {
    setLoading(true);
    let query = supabase
      .from('enrollments')
      .select(
        'id, student_no, seat_no, term, students(name, gender), classes(id, academic_year, department, grade_level, class_name)'
      )
      .eq('is_current', true)
      .order('seat_no');
    if (classId) query = query.eq('class_id', classId);
    const { data, error } = await query;
    setLoadError(error ? '讀取學生名冊失敗：' + error.message : null);
    const rows = (data ?? []) as unknown as EnrolledStudent[];
    setStudents(rows);
    loadAttendanceSummary(rows.map((r) => r.student_no));
    setLoading(false);
  }

  // 出缺席狀況：統計目前顯示的每位學生已登錄的出缺勤次數（累計至今，不限學期範圍），
  // 只顯示「非出席」的幾種狀態，方便一眼看出哪些學生缺勤/請假偏多。
  async function loadAttendanceSummary(studentNos: string[]) {
    if (studentNos.length === 0) {
      setAttendanceSummary({});
      return;
    }
    const { data, error } = await supabase.from('attendance').select('student_no, status').in('student_no', studentNos);
    if (error) return; // 讀取失敗時不擋主要查詢流程，出缺席欄位就顯示空白
    const map: Record<string, Record<string, number>> = {};
    (data ?? []).forEach((r: any) => {
      map[r.student_no] = map[r.student_no] ?? {};
      map[r.student_no][r.status] = (map[r.student_no][r.status] ?? 0) + 1;
    });
    setAttendanceSummary(map);
  }

  useEffect(() => {
    loadMyPermissions();
    loadClasses();
  }, []);

  useEffect(() => {
    loadStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  function canEdit(s: EnrolledStudent) {
    if (isAdmin) return true;
    if (s.classes && myHomeroomClassIds.has(s.classes.id)) return true;
    return false;
  }

  async function openEdit(studentNo: string) {
    setEditError(null);
    setEditingStudentNo(studentNo);
    setEditForm(null);
    const { data, error } = await supabase
      .from('students')
      .select(
        'student_no, name, gender, thai_name, dob, id_number, nationality, religion, blood_type, address, phone, previous_school, previous_school_grade, updated_at, updated_by'
      )
      .eq('student_no', studentNo)
      .single();
    if (error) {
      setEditError('讀取學生詳細資料失敗：' + error.message);
      return;
    }
    setEditForm(data as StudentDetail);

    if (data?.updated_by && !editorNames[data.updated_by]) {
      const { data: editorRow } = await supabase.from('app_users').select('name').eq('id', data.updated_by).maybeSingle();
      if (editorRow) setEditorNames((prev) => ({ ...prev, [data.updated_by as string]: editorRow.name }));
    }
  }

  function closeEdit() {
    setEditingStudentNo(null);
    setEditForm(null);
    setEditError(null);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm || !myAppUserId) return;
    setSaving(true);
    setEditError(null);

    const payload: Record<string, any> = { updated_at: new Date().toISOString(), updated_by: myAppUserId };
    EDIT_FIELDS.forEach(({ key }) => {
      payload[key] = editForm[key] ?? null;
    });

    const { error } = await supabase.from('students').update(payload).eq('student_no', editForm.student_no);
    setSaving(false);
    if (error) {
      setEditError('儲存失敗：' + error.message + (error.message.includes('policy') ? '（您可能沒有修改這位學生的權限）' : ''));
      return;
    }
    closeEdit();
    loadStudents();
  }

  const keywordLower = keyword.trim().toLowerCase();
  const filtered = keywordLower
    ? students.filter(
        (s) => s.student_no.toLowerCase().includes(keywordLower) || (s.students?.name ?? '').toLowerCase().includes(keywordLower)
      )
    : students;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>查詢學生</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        查詢目前在學學生名冊，可選「全部班級」看全校，或指定單一班級；也可以用學號/姓名關鍵字搜尋。
        「出缺席狀況」為累計至今的紀錄（曠課/遲到/病假/事假/公假），要看某個月份或整學期的明細請到「學生出席紀錄查詢」頁面。
      </p>
      <ErrorBanner message={loadError} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: 8, minWidth: 200 }}>
          <option value="">全部班級（全校）</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          placeholder="搜尋學號或姓名"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ padding: 8, flex: 1, minWidth: 160 }}
        />
      </div>

      <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
        {loading ? '查詢中…' : `共 ${filtered.length} 位學生`}
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
            <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
            <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
            <th style={{ textAlign: 'right', padding: 6 }}>座號</th>
            <th style={{ textAlign: 'left', padding: 6 }}>學期</th>
            <th style={{ textAlign: 'left', padding: 6 }}>出缺席狀況</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s) => (
            <tr key={s.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{s.student_no}</td>
              <td style={{ padding: 6 }}>{s.students?.name ?? '—'}</td>
              <td style={{ padding: 6 }}>
                {s.classes ? `${s.classes.academic_year} ${s.classes.grade_level}${s.classes.class_name}` : '—'}
              </td>
              <td style={{ padding: 6, textAlign: 'right' }}>{s.seat_no ?? '—'}</td>
              <td style={{ padding: 6 }}>{s.term}</td>
              <td style={{ padding: 6, fontSize: 12, color: '#666' }}>
                {(() => {
                  const summary = attendanceSummary[s.student_no];
                  if (!summary) return '—';
                  const parts = ATTENDANCE_ISSUE_STATUSES.map((st) => [st, summary[st] ?? 0] as const).filter(([, n]) => n > 0);
                  return parts.length > 0 ? parts.map(([st, n]) => `${st}${n}`).join('　') : '全勤';
                })()}
              </td>
              <td style={{ padding: 6, textAlign: 'right' }}>
                {canEdit(s) && (
                  <button onClick={() => openEdit(s.student_no)} style={{ fontSize: 12, padding: '2px 8px' }}>
                    修正資料
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!loading && filtered.length === 0 && (
            <tr>
              <td colSpan={7} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                查無資料
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editingStudentNo && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={closeEdit}
        >
          <div
            style={{ background: '#fff', borderRadius: 8, padding: 24, width: 480, maxHeight: '85vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 15, marginBottom: 4 }}>修正學生資料（學號：{editingStudentNo}）</h2>

            {!editForm && !editError && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}
            <ErrorBanner message={editError} />

            {editForm && (
              <form onSubmit={handleSaveEdit}>
                <p style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
                  {editForm.updated_at
                    ? `上次修改：${new Date(editForm.updated_at).toLocaleString('zh-TW')}${
                        editForm.updated_by ? '，修改者：' + (editorNames[editForm.updated_by] ?? editForm.updated_by) : ''
                      }`
                    : '目前還沒有修改紀錄'}
                </p>
                {EDIT_FIELDS.map(({ key, label }) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 2 }}>{label}</label>
                    <input
                      type={key === 'dob' ? 'date' : 'text'}
                      value={(editForm[key] as string) ?? ''}
                      onChange={(e) => setEditForm({ ...editForm, [key]: e.target.value })}
                      style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button
                    type="submit"
                    disabled={saving}
                    style={{ flex: 1, padding: 10, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}
                  >
                    {saving ? '儲存中…' : '儲存'}
                  </button>
                  <button
                    type="button"
                    onClick={closeEdit}
                    style={{ flex: 1, padding: 10, background: '#eee', border: 'none', borderRadius: 6 }}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
