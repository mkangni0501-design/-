'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type ClassTopRow = {
  class_id: string;
  name: string;
  seat_no: number;
  total_score: number;
  class_rank: number;
};
type GradeTopRow = {
  class_id: string;
  department: string;
  grade_level: string;
  name: string;
  seat_no: number;
  total_score: number;
  grade_rank: number;
};
type ClassLabel = { id: string; label: string };

// 全校排行榜：各班前三名、各年級前三名。
// 資料來源是 class_rankings / grade_rankings 這兩個資料庫view（已經套用加扣分規則計算好加權總分），
// 只有該班「期中考／期末考／平時分」三項都已鎖定，才會出現在這裡的總分排名裡
// （總分本身就是三項加權後的結果，任何一項還沒鎖定，加權總分就還不完整，不能拿來排名）。
export default function SchoolRankingsPage() {
  const [academicYear, setAcademicYear] = useState(new Date().getFullYear());
  const [term, setTerm] = useState('上學期');
  const [classLabels, setClassLabels] = useState<Record<string, string>>({});
  const [classTop, setClassTop] = useState<ClassTopRow[]>([]);
  const [gradeTop, setGradeTop] = useState<GradeTopRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);

    const { data: classRows } = await supabase.from('classes').select('id, grade_level, class_name');
    const labelMap: Record<string, string> = {};
    (classRows ?? []).forEach((c: any) => {
      labelMap[c.id] = `${c.grade_level}${c.class_name}`;
    });
    setClassLabels(labelMap);

    const { data: classTopRows, error: classErr } = await supabase
      .from('class_rankings')
      .select('class_id, name, seat_no, total_score, class_rank')
      .eq('academic_year', academicYear)
      .eq('term', term)
      .lte('class_rank', 3)
      .order('class_id')
      .order('class_rank');

    const { data: gradeTopRows, error: gradeErr } = await supabase
      .from('grade_rankings')
      .select('class_id, department, grade_level, name, seat_no, total_score, grade_rank')
      .eq('academic_year', academicYear)
      .eq('term', term)
      .lte('grade_rank', 3)
      .order('department')
      .order('grade_level')
      .order('grade_rank');

    const firstError = classErr ?? gradeErr;
    setLoadError(firstError ? '讀取全校排行榜失敗：' + firstError.message : null);
    setClassTop((classTopRows ?? []) as ClassTopRow[]);
    setGradeTop((gradeTopRows ?? []) as GradeTopRow[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academicYear, term]);

  // 依 class_id 分組
  const classGroups = new Map<string, ClassTopRow[]>();
  classTop.forEach((r) => {
    const list = classGroups.get(r.class_id) ?? [];
    list.push(r);
    classGroups.set(r.class_id, list);
  });

  // 依 部別+年級 分組
  const gradeGroups = new Map<string, GradeTopRow[]>();
  gradeTop.forEach((r) => {
    const key = `${r.department} ${r.grade_level}`;
    const list = gradeGroups.get(key) ?? [];
    list.push(r);
    gradeGroups.set(key, list);
  });

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>全校排行榜</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        只有該班「期中考／期末考／平時分」三項都已鎖定，才會出現在這裡（總分排名需要三項都鎖定才完整、才開放顯示）。
      </p>
      <ErrorBanner message={loadError} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          type="number"
          value={academicYear}
          onChange={(e) => setAcademicYear(Number(e.target.value))}
          style={{ padding: 8, width: 100 }}
        />
        <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ padding: 8 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>全校各班前三名</h2>
          {classGroups.size === 0 && <p style={{ fontSize: 13, color: '#999', marginBottom: 20 }}>目前沒有已鎖定的班級排名資料</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 28 }}>
            {Array.from(classGroups.entries()).map(([classId, rows]) => (
              <div key={classId} style={{ border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>{classLabels[classId] ?? classId}</p>
                {rows
                  .sort((a, b) => a.class_rank - b.class_rank)
                  .map((r) => (
                    <p key={r.seat_no} style={{ fontSize: 13, margin: '2px 0' }}>
                      第{r.class_rank}名　{r.name}（座號{r.seat_no}）　{r.total_score}分
                    </p>
                  ))}
              </div>
            ))}
          </div>

          <h2 style={{ fontSize: 14, marginBottom: 8 }}>全校各年級前三名</h2>
          {gradeGroups.size === 0 && <p style={{ fontSize: 13, color: '#999' }}>目前沒有已鎖定的年級排名資料</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {Array.from(gradeGroups.entries()).map(([key, rows]) => (
              <div key={key} style={{ border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>{key}</p>
                {rows
                  .sort((a, b) => a.grade_rank - b.grade_rank)
                  .map((r) => (
                    <p key={r.class_id + r.seat_no} style={{ fontSize: 13, margin: '2px 0' }}>
                      第{r.grade_rank}名　{r.name}（{classLabels[r.class_id] ?? ''}座號{r.seat_no}）　{r.total_score}分
                    </p>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
