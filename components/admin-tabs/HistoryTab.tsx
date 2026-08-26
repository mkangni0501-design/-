'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type TermRecord = {
  enrollment_id: string;
  academic_year: number;
  term: string;
  class_name: string;
  grade_level: string;
  total_score: number | null;
  class_rank: number | null;
};

// 這個頁面目前開放給管理員／導師使用，直接用學號查詢歷年紀錄。
// 跟舊系統最大的差異：完全不用任何「文字拼接」去對到成績總表，
// 而是用 enrollments.student_no 這個真正的外鍵一路 join 過去，
// 所以不會出現舊系統「個人歷年成績表」裡那種大量 #N/A 的狀況。
export default function HistoryQueryPage() {
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState('');
  const [records, setRecords] = useState<TermRecord[]>([]);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    setSearched(true);
    const { data: student } = await supabase.from('students').select('name').eq('student_no', studentNo).maybeSingle();
    setStudentName(student?.name ?? '');

    const { data: enrollRows } = await supabase
      .from('enrollments')
      .select('id, term, classes(academic_year, class_name, grade_level)')
      .eq('student_no', studentNo)
      .order('id');

    const results: TermRecord[] = [];
    for (const e of enrollRows ?? []) {
      const cls: any = (e as any).classes;
      const { data: totalRow } = await supabase.from('student_total_scores').select('total_score').eq('enrollment_id', e.id).maybeSingle();
      const { data: rankRow } = await supabase.from('class_rankings').select('class_rank').eq('enrollment_id', e.id).maybeSingle();
      results.push({
        enrollment_id: e.id,
        academic_year: cls.academic_year,
        term: (e as any).term,
        class_name: cls.class_name,
        grade_level: cls.grade_level,
        total_score: totalRow?.total_score ?? null,
        class_rank: rankRow?.class_rank ?? null,
      });
    }
    // 依學年、學期排序，方便一眼看出成長趨勢
    results.sort((a, b) => a.academic_year - b.academic_year || a.term.localeCompare(b.term));
    setRecords(results);
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>歷年成績查詢</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          placeholder="輸入學號"
          value={studentNo}
          onChange={(e) => setStudentNo(e.target.value)}
          style={{ padding: 8, flex: 1 }}
        />
        <button onClick={handleSearch} style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          查詢
        </button>
      </div>

      {searched && records.length === 0 && <p style={{ fontSize: 13, color: '#666' }}>查無此學號的歷年紀錄。</p>}

      {records.length > 0 && (
        <>
          <p style={{ fontSize: 14, marginBottom: 8 }}>{studentName}（學號 {studentNo}）</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>學年度</th>
                <th style={{ textAlign: 'left', padding: 6 }}>學期</th>
                <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
                <th style={{ textAlign: 'right', padding: 6 }}>總分</th>
                <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
