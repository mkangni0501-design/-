'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Candidate = {
  student_no: string;
  name: string;
  source_class_id: string;
  source_label: string;
  department: string;
  grade_level: string;
  class_name: string;
  proposed_department: string | null;
  proposed_grade_level: string | null;
  proposed_class_name: string;
  exclude: boolean;
};

const EXIT_STATUSES = ['退學', '畢業', '肄業'];

export default function PromotionPage() {
  const [sourceYear, setSourceYear] = useState(new Date().getFullYear());
  const [sourceTerm, setSourceTerm] = useState('下學期');
  const [targetYear, setTargetYear] = useState(new Date().getFullYear() + 1);
  const [targetTerm, setTargetTerm] = useState('上學期');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadCandidates() {
    setLoading(true);

    const { data: enrollRows } = await supabase
      .from('enrollments')
      .select('student_no, class_id, students(name), classes(department, grade_level, class_name, academic_year)')
      .eq('term', sourceTerm)
      .eq('is_current', true);

    const relevant = (enrollRows ?? []).filter((r: any) => r.classes?.academic_year === sourceYear);

    const list: Candidate[] = [];
    for (const r of relevant as any[]) {
      // 排除已經退學/畢業/肄業的學生（依最新一筆學籍狀態判斷）
      const { data: statusRows } = await supabase
        .from('student_status_changes')
        .select('status')
        .eq('student_no', r.student_no)
        .order('effective_date', { ascending: false })
        .limit(1);
      const latestStatus = statusRows?.[0]?.status;
      if (latestStatus && EXIT_STATUSES.includes(latestStatus)) continue;

      const { data: progressionRow } = await supabase
        .from('grade_progression')
        .select('next_department, next_grade_level')
        .eq('department', r.classes.department)
        .eq('grade_level', r.classes.grade_level)
        .maybeSingle();

      list.push({
        student_no: r.student_no,
        name: r.students.name,
        source_class_id: r.class_id,
        source_label: `${r.classes.department} ${r.classes.grade_level}${r.classes.class_name}`,
        department: r.classes.department,
        grade_level: r.classes.grade_level,
        class_name: r.classes.class_name,
        proposed_department: progressionRow?.next_department ?? null,
        proposed_grade_level: progressionRow?.next_grade_level ?? null,
        proposed_class_name: r.classes.class_name, // 預設班別不變
        exclude: false,
      });
    }
    setCandidates(list);
    setLoading(false);
  }

  function updateCandidate(studentNo: string, patch: Partial<Candidate>) {
    setCandidates((prev) => prev.map((c) => (c.student_no === studentNo ? { ...c, ...patch } : c)));
  }

  async function resolveOrCreateClass(department: string, gradeLevel: string, className: string, sourceClassId: string) {
    const { data: existing } = await supabase
      .from('classes')
      .select('id')
      .eq('academic_year', targetYear)
      .eq('department', department)
      .eq('grade_level', gradeLevel)
      .eq('class_name', className)
      .maybeSingle();
    if (existing) return existing.id;

    // 沿用原班級的導師當預設值，之後可以在「班級與導師設定」頁面再調整
    const { data: sourceClass } = await supabase.from('classes').select('homeroom_teacher_id').eq('id', sourceClassId).single();

    const { data: created, error } = await supabase
      .from('classes')
      .insert({
        academic_year: targetYear,
        department,
        grade_level: gradeLevel,
        class_name: className,
        homeroom_teacher_id: sourceClass?.homeroom_teacher_id ?? null,
      })
      .select('id')
      .single();
    if (error || !created) throw new Error(error?.message ?? '建立班級失敗');
    return created.id;
  }

  async function handleConfirm() {
    if (!confirm(`確定要把 ${candidates.filter((c) => !c.exclude).length} 位學生升級到 ${targetYear}學年度 ${targetTerm} 嗎？`)) return;

    const seatCounters: Record<string, number> = {};

    for (const c of candidates) {
      if (c.exclude) continue;
      if (!c.proposed_department || !c.proposed_grade_level) {
        alert(`${c.name} 沒有對應的升級年級設定，已略過，請先到「年級升級對照表」設定或手動調整`);
        continue;
      }
      try {
        const classId = await resolveOrCreateClass(c.proposed_department, c.proposed_grade_level, c.proposed_class_name, c.source_class_id);
        const seatKey = classId;
        seatCounters[seatKey] = (seatCounters[seatKey] ?? 0) + 1;

        // 舊的學籍紀錄標記為非現行
        await supabase.from('enrollments').update({ is_current: false }).eq('student_no', c.student_no).eq('is_current', true);

        const { error: insertErr } = await supabase.from('enrollments').insert({
          student_no: c.student_no,
          class_id: classId,
          term: targetTerm,
          seat_no: seatCounters[seatKey],
          is_current: true,
        });
        if (insertErr) throw new Error(insertErr.message);
      } catch (err: any) {
        alert(`${c.name} 處理失敗：${err.message}`);
      }
    }
    alert('升級作業完成');
    setCandidates([]);
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>升級作業</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        依「年級升級對照表」自動算出每個學生升級後的年級，班別預設不變。已標記退學/畢業/肄業的學生會自動排除。確認前可以個別調整，確認後才會真的建立新學期的學籍紀錄，原本的歷史紀錄不會被覆蓋。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13 }}>從</span>
        <input type="number" value={sourceYear} onChange={(e) => setSourceYear(Number(e.target.value))} style={{ padding: 6, width: 90 }} />
        <select value={sourceTerm} onChange={(e) => setSourceTerm(e.target.value)} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <span style={{ fontSize: 13 }}>升級到</span>
        <input type="number" value={targetYear} onChange={(e) => setTargetYear(Number(e.target.value))} style={{ padding: 6, width: 90 }} />
        <select value={targetTerm} onChange={(e) => setTargetTerm(e.target.value)} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <button onClick={loadCandidates} style={{ padding: '6px 14px' }}>
          {loading ? '載入中…' : '載入名單'}
        </button>
      </div>

      {candidates.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>學生</th>
                <th style={{ textAlign: 'left', padding: 6 }}>目前班級</th>
                <th style={{ textAlign: 'left', padding: 6 }}>升級後部別/年級</th>
                <th style={{ textAlign: 'left', padding: 6 }}>升級後班別</th>
                <th style={{ textAlign: 'center', padding: 6 }}>排除</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.student_no} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{c.name}</td>
                  <td style={{ padding: 6 }}>{c.source_label}</td>
                  <td style={{ padding: 6 }}>
                    {c.proposed_department && c.proposed_grade_level ? (
                      `${c.proposed_department} ${c.proposed_grade_level}`
                    ) : (
                      <span style={{ color: '#A32D2D' }}>⚠ 無對照設定</span>
                    )}
                  </td>
                  <td style={{ padding: 6 }}>
                    <input
                      value={c.proposed_class_name}
                      onChange={(e) => updateCandidate(c.student_no, { proposed_class_name: e.target.value })}
                      style={{ padding: 4, width: 80 }}
                    />
                  </td>
                  <td style={{ padding: 6, textAlign: 'center' }}>
                    <input type="checkbox" checked={c.exclude} onChange={(e) => updateCandidate(c.student_no, { exclude: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={handleConfirm} style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
            確認執行升級（{candidates.filter((c) => !c.exclude).length} 位）
          </button>
        </>
      )}
    </div>
  );
}
