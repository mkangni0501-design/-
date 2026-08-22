'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type LinkedStudent = { id: string; student_no: string; relation: string; name: string };
type TermRecord = {
  enrollment_id: string;
  academic_year: number;
  term: string;
  class_name: string;
  grade_level: string;
  total_score: number | null;
  class_rank: number | null;
  grade_rank: number | null;
  midterm_total: number | null;
  midterm_class_rank: number | null;
  midterm_grade_rank: number | null;
  final_total: number | null;
  final_class_rank: number | null;
  final_grade_rank: number | null;
  daily_total: number | null;
  daily_class_rank: number | null;
  daily_grade_rank: number | null;
};
type EditRequest = { id: string; field_name: string; target_table: string; new_value: string; status: string; requested_at: string };
type Guardian = { id: string; relation: string; name: string | null; phone: string | null };

// 可修改的欄位：本人（students 表）的地址/電話，以及每位監護人（guardians 表）的姓名/電話。
// guardian_id 為 null 代表改的是 students 表本身的欄位。
type EditableOption = { key: string; label: string; targetTable: 'students' | 'guardians'; guardianId: string | null; fieldName: string; currentValue: string };

export default function ParentPortalPage() {
  const [linkedStudents, setLinkedStudents] = useState<LinkedStudent[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LinkedStudent | null>(null);
  const [records, setRecords] = useState<TermRecord[]>([]);
  const [attendanceCounts, setAttendanceCounts] = useState<Record<string, number>>({});
  const [absencePeriods, setAbsencePeriods] = useState(0);
  const [alertThreshold, setAlertThreshold] = useState<number | null>(null);
  const [profile, setProfile] = useState<Record<string, string>>({});
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequest[]>([]);
  const [editKey, setEditKey] = useState('');
  const [editValue, setEditValue] = useState('');
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        router.push('/portal/login');
        return;
      }
      // 【2026-08-19】原本這裡完全沒有「還在載入」跟「載入完成但沒有綁定任何學生」
      // 這兩種狀態的畫面——不管是哪種情況，畫面上都只會看到標題「家長／學生查詢
      // 入口」，下面整片空白，這正是這次反映「登入以後什麼也看不見」的直接原因。
      // 這裡補上明確的載入中／查無資料訊息，不管背後真正卡在哪一步，至少畫面上
      // 會告訴使用者「現在是什麼狀態」，不會像一片空白一樣看起來像當機。
      const { data: accounts, error: accErr } = await supabase
        .from('portal_accounts')
        .select('id, student_no, relation, students(name)')
        .eq('auth_user_id', sessionData.session.user.id);

      if (accErr) {
        setLoadError('讀取綁定的學生資料時發生錯誤：' + accErr.message);
        setLoadingAccounts(false);
        return;
      }

      const list: LinkedStudent[] = (accounts ?? []).map((a: any) => ({
        id: a.id,
        student_no: a.student_no,
        relation: a.relation,
        name: a.students?.name ?? a.student_no,
      }));
      setLinkedStudents(list);
      if (list.length > 0) setSelected(list[0]);
      setLoadingAccounts(false);

      const { data: settingRow } = await supabase.from('attendance_alert_settings').select('threshold_periods').eq('id', 1).maybeSingle();
      if (settingRow) setAlertThreshold(settingRow.threshold_periods);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadEditRequests(studentNo: string) {
    const { data: reqRows } = await supabase
      .from('profile_edit_requests')
      .select('id, field_name, target_table, new_value, status, requested_at')
      .eq('student_no', studentNo)
      .order('requested_at', { ascending: false });
    setEditRequests((reqRows ?? []) as EditRequest[]);
  }

  useEffect(() => {
    if (!selected) return;
    (async () => {
      // 歷年各學期總分/排名（含期中/期末/平時分別統計）
      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('id, term, classes(academic_year, class_name, grade_level)')
        .eq('student_no', selected.student_no);

      const results: TermRecord[] = [];
      for (const e of enrollRows ?? []) {
        const cls: any = (e as any).classes;
        const { data: totalRow } = await supabase.from('student_total_scores').select('total_score').eq('enrollment_id', e.id).maybeSingle();
        const { data: classRankRow } = await supabase
          .from('class_rankings')
          .select('class_rank, midterm_total, midterm_class_rank, final_total, final_class_rank, daily_total, daily_class_rank')
          .eq('enrollment_id', e.id)
          .maybeSingle();
        const { data: gradeRankRow } = await supabase
          .from('grade_rankings')
          .select('grade_rank, midterm_grade_rank, final_grade_rank, daily_grade_rank')
          .eq('enrollment_id', e.id)
          .maybeSingle();
        results.push({
          enrollment_id: e.id,
          academic_year: cls.academic_year,
          term: (e as any).term,
          class_name: cls.class_name,
          grade_level: cls.grade_level,
          total_score: totalRow?.total_score ?? null,
          class_rank: classRankRow?.class_rank ?? null,
          grade_rank: gradeRankRow?.grade_rank ?? null,
          midterm_total: classRankRow?.midterm_total ?? null,
          midterm_class_rank: classRankRow?.midterm_class_rank ?? null,
          midterm_grade_rank: gradeRankRow?.midterm_grade_rank ?? null,
          final_total: classRankRow?.final_total ?? null,
          final_class_rank: classRankRow?.final_class_rank ?? null,
          final_grade_rank: gradeRankRow?.final_grade_rank ?? null,
          daily_total: classRankRow?.daily_total ?? null,
          daily_class_rank: classRankRow?.daily_class_rank ?? null,
          daily_grade_rank: gradeRankRow?.daily_grade_rank ?? null,
        });
      }
      results.sort((a, b) => a.academic_year - b.academic_year || a.term.localeCompare(b.term));
      setRecords(results);

      // 歷年出缺勤彙總（依狀態計數）+ 事假/病假/曠課累計節數（用來跟示警門檻比較）
      const { data: attendanceRows } = await supabase.from('attendance').select('status').eq('student_no', selected.student_no);
      const counts: Record<string, number> = {};
      (attendanceRows ?? []).forEach((r: any) => (counts[r.status] = (counts[r.status] ?? 0) + 1));
      setAttendanceCounts(counts);
      setAbsencePeriods((counts['事假'] ?? 0) + (counts['病假'] ?? 0) + (counts['曠課'] ?? 0));

      // 基本資料
      const { data: studentRow } = await supabase.from('students').select('address, phone').eq('student_no', selected.student_no).single();
      setProfile((studentRow as any) ?? {});

      // 監護人資料
      const { data: guardianRows } = await supabase
        .from('guardians')
        .select('id, relation, name, phone')
        .eq('student_no', selected.student_no);
      setGuardians((guardianRows ?? []) as Guardian[]);

      // 修改申請紀錄
      await loadEditRequests(selected.student_no);
    })();
  }, [selected]);

  const editableOptions: EditableOption[] = selected
    ? [
        { key: 'student:address', label: '本人現居地址', targetTable: 'students', guardianId: null, fieldName: 'address', currentValue: profile.address ?? '' },
        { key: 'student:phone', label: '本人聯絡電話', targetTable: 'students', guardianId: null, fieldName: 'phone', currentValue: profile.phone ?? '' },
        ...guardians.flatMap((g) => [
          { key: `guardian:${g.id}:name`, label: `${g.relation}姓名`, targetTable: 'guardians' as const, guardianId: g.id, fieldName: 'name', currentValue: g.name ?? '' },
          { key: `guardian:${g.id}:phone`, label: `${g.relation}電話`, targetTable: 'guardians' as const, guardianId: g.id, fieldName: 'phone', currentValue: g.phone ?? '' },
        ]),
      ]
    : [];

  useEffect(() => {
    if (editableOptions.length > 0 && !editableOptions.some((o) => o.key === editKey)) {
      setEditKey(editableOptions[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians, selected]);

  async function handleSubmitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const option = editableOptions.find((o) => o.key === editKey);
    if (!option) return;
    const account = linkedStudents.find((s) => s.student_no === selected.student_no);
    const { error } = await supabase.from('profile_edit_requests').insert({
      student_no: selected.student_no,
      field_name: option.fieldName,
      target_table: option.targetTable,
      guardian_id: option.guardianId,
      old_value: option.currentValue,
      new_value: editValue,
      requested_by: account?.id,
    });
    if (error) {
      alert('送出失敗：' + error.message);
      return;
    }
    alert('已送出，導師已收到通知，待核准後才會正式更新');
    setEditValue('');
    await loadEditRequests(selected.student_no);
  }

  const currentTerm = records[records.length - 1];
  const halfThreshold = alertThreshold !== null ? Math.ceil(alertThreshold / 2) : null;
  const showAlert = halfThreshold !== null && absencePeriods >= halfThreshold;

  function editRequestLabel(r: EditRequest) {
    const option = editableOptions.find((o) => o.fieldName === r.field_name && o.targetTable === r.target_table);
    return option?.label ?? `${r.target_table === 'guardians' ? '監護人' : '本人'} ${r.field_name}`;
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>家長／學生查詢入口</h1>

      {linkedStudents.length > 1 && (
        <select
          value={selected?.id}
          onChange={(e) => setSelected(linkedStudents.find((s) => s.id === e.target.value) ?? null)}
          style={{ padding: 8, marginBottom: 16 }}
        >
          {linkedStudents.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.relation}）
            </option>
          ))}
        </select>
      )}

      {loadingAccounts && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}

      {loadError && (
        <p style={{ fontSize: 13, color: '#B3261E', background: '#FDECEA', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px' }}>
          ⚠️ {loadError}
        </p>
      )}

      {!loadingAccounts && !loadError && linkedStudents.length === 0 && (
        <p style={{ fontSize: 13, color: '#666', background: '#f5f5f4', border: '1px solid #e5e5e0', borderRadius: 8, padding: '12px 16px' }}>
          目前這個帳號還沒有綁定任何學生資料，請聯絡導師或學校確認登入代碼與信箱是否正確、
          或是否已經完成帳號綁定。
        </p>
      )}

      {selected && (
        <>
          {showAlert && (
            <section
              style={{
                marginBottom: 24,
                padding: 16,
                background: '#FBEFE9',
                border: '2px solid #A36A2D',
                borderRadius: 8,
              }}
            >
              <p style={{ fontSize: 20, fontWeight: 700, color: '#A36A2D', marginBottom: 4 }}>
                ⚠ 出缺席提醒：事假＋病假＋曠課累計 {absencePeriods} 節
              </p>
              <p style={{ fontSize: 13, color: '#A36A2D' }}>已達學校示警門檻的一半，請多留意孩子的出缺席狀況。</p>
            </section>
          )}

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>本學期各期成績和排名</h2>
            {currentTerm ? (
              <>
                <p style={{ fontSize: 13, marginBottom: 8, color: '#666' }}>
                  {currentTerm.academic_year}學年度 {currentTerm.term}　{currentTerm.grade_level}
                  {currentTerm.class_name}
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 6 }}></th>
                      <th style={{ textAlign: 'right', padding: 6 }}>總分</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>年級排名</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>期中</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_total ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_class_rank ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_grade_rank ?? '尚未公布'}</td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>期末</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_total ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_class_rank ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_grade_rank ?? '尚未公布'}</td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>平時</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_total ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_class_rank ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_grade_rank ?? '尚未公布'}</td>
                    </tr>
                    <tr style={{ borderTop: '1px solid #eee', fontWeight: 700 }}>
                      <td style={{ padding: 6 }}>總表</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.total_score ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.class_rank ?? '尚未公布'}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.grade_rank ?? '尚未公布'}</td>
                    </tr>
                  </tbody>
                </table>
                <p style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                  總分／排名要導師送出並鎖定平時分後才會公布；期中/期末/平時各自的總分排名也遵循同一個時間點一起公布。
                </p>
              </>
            ) : (
              <p style={{ fontSize: 13, color: '#666' }}>目前沒有學期資料</p>
            )}
          </section>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>歷年成績</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 6 }}>學年度</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>學期</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>總分</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>年級排名</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.enrollment_id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{r.academic_year}</td>
                    <td style={{ padding: 6 }}>{r.term}</td>
                    <td style={{ padding: 6 }}>{r.grade_level}{r.class_name}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{r.total_score ?? '—'}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{r.class_rank ?? '—'}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{r.grade_rank ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>歷年出缺勤彙總</h2>
            <p style={{ fontSize: 13 }}>
              {Object.entries(attendanceCounts).length > 0
                ? Object.entries(attendanceCounts).map(([k, v]) => `${k} ${v}次`).join('　')
                : '全勤或尚無紀錄'}
            </p>
          </section>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>監護人資料</h2>
            {guardians.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>關係</th>
                    <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                    <th style={{ textAlign: 'left', padding: 6 }}>電話</th>
                  </tr>
                </thead>
                <tbody>
                  {guardians.map((g) => (
                    <tr key={g.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>{g.relation}</td>
                      <td style={{ padding: 6 }}>{g.name ?? '—'}</td>
                      <td style={{ padding: 6 }}>{g.phone ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 13, color: '#999' }}>尚無監護人資料，如需新增請聯絡導師。</p>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>修改基本資料</h2>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              送出後導師會立即收到通知，需經導師核准才會正式更新，核准前畫面上顯示的仍是原本的資料。
            </p>
            <form onSubmit={handleSubmitEdit} style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <select value={editKey} onChange={(e) => setEditKey(e.target.value)} style={{ padding: 8 }}>
                {editableOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                placeholder={`新的${editableOptions.find((o) => o.key === editKey)?.label ?? ''}`}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{ padding: 8, flex: 1, minWidth: 160 }}
                required
              />
              <button type="submit" style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
                送出申請
              </button>
            </form>
            {editRequests.length > 0 && (
              <ul style={{ fontSize: 12, color: '#666', paddingLeft: 18 }}>
                {editRequests.map((r) => (
                  <li key={r.id}>
                    {editRequestLabel(r)} → {r.new_value}（{r.status}）
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
