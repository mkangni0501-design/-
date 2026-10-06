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
// 資料來源是 class_rankings_for_class() / grade_rankings_for_class() 這兩支資料庫函式（已經套用加扣分規則計算好加權總分，每次只算單班/單年級），
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

  // 逐班呼叫 class_rankings_for_class()／grade_rankings_for_class()（sql/50、88），
  // 每次只算「一個班」或「同部別同年級」的學生，不再查全校範圍的
  // class_rankings／grade_rankings view（一次算 1300+ 位學生，會 statement timeout）。
  async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function load() {
    setLoading(true);
    setLoadError(null);

    const { data: classRows, error: classListErr } = await supabase
      .from('classes')
      .select('id, academic_year, department, grade_level, class_name');
    if (classListErr) {
      setLoadError('讀取全校排行榜失敗：' + classListErr.message);
      setLoading(false);
      return;
    }
    const labelMap: Record<string, string> = {};
    (classRows ?? []).forEach((c: any) => {
      labelMap[c.id] = `${c.grade_level}${c.class_name}`;
    });
    setClassLabels(labelMap);

    const yearClasses = (classRows ?? []).filter((c: any) => c.academic_year === academicYear);

    let firstError: string | null = null;

    // 各班前三名：每班呼叫一次
    const classResults = await mapWithLimit(yearClasses, 4, async (c: any) => {
      const { data, error } = await supabase.rpc('class_rankings_for_class', { p_class_id: c.id, p_term: term });
      if (error && !firstError) firstError = error.message;
      return ((data ?? []) as any[])
        .filter((r) => r.class_rank != null && r.total_score != null && Number(r.class_rank) <= 3)
        .map((r) => ({
          class_id: r.class_id,
          name: r.name,
          seat_no: r.seat_no,
          total_score: r.total_score,
          class_rank: Number(r.class_rank),
        })) as ClassTopRow[];
    });

    // 各年級前三名：同部別＋同年級只需呼叫一次（任選其中一個班當代表，函式會算整個年級）
    const gradeReps = new Map<string, any>();
    yearClasses.forEach((c: any) => {
      const key = `${c.department}|${c.grade_level}`;
      if (!gradeReps.has(key)) gradeReps.set(key, c);
    });
    const gradeResults = await mapWithLimit(Array.from(gradeReps.values()), 4, async (c: any) => {
      const { data, error } = await supabase.rpc('grade_rankings_for_class', { p_class_id: c.id, p_term: term });
      if (error && !firstError) firstError = error.message;
      return ((data ?? []) as any[])
        .filter((r) => r.grade_rank != null && r.total_score != null && Number(r.grade_rank) <= 3)
        .map((r) => ({
          class_id: r.class_id,
          department: r.department,
          grade_level: r.grade_level,
          name: r.name,
          seat_no: r.seat_no,
          total_score: r.total_score,
          grade_rank: Number(r.grade_rank),
        })) as GradeTopRow[];
    });

    setLoadError(firstError ? '讀取全校排行榜失敗：' + firstError : null);
    setClassTop(classResults.flat());
    setGradeTop(gradeResults.flat());
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
