'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { WEEKDAY_LABELS } from '@/lib/periodConfig';
import { resolveCurrentTerm } from '@/lib/academicTerm';

// 查詢教師/班級課表：選一位老師或一個班級，直接看整週課表（星期一～六 × 各節次），
// 不用像「學校課表」那樣一列一列看表格。開放給所有已登入使用者（老師本人也可以查自己的課表），
// 不歸在 /admin/ 底下、不受管理員權限限制。
//
// 【2026-08 修正】根因：原本直接呼叫 supabase.rpc('current_academic_term')，
// 沒有人到「學年學期設定」頁按過「設為目前生效」時 academicYear/term 就會是
// null，下面查課表的 useEffect 一開始就被擋下（見 guard 條件），導致「所有
// 帳號都完全看不到排課」——不是查詢邏輯錯，是根本沒有執行到查詢。改用
// resolveCurrentTerm()，查無「目前生效」時會自動退回最合理的一筆，頁面才能
// 正常運作。

type Option = { id: string; label: string; academicYear?: number };
type Cell = { subject: string; teacherName?: string; classLabel?: string };

export default function ScheduleLookupPage() {
  const [mode, setMode] = useState<'teacher' | 'class'>('teacher');
  const [teacherOptions, setTeacherOptions] = useState<Option[]>([]);
  const [classOptions, setClassOptions] = useState<Option[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [academicYear, setAcademicYear] = useState<number | null>(null);
  const [term, setTerm] = useState<string | null>(null);
  const [grid, setGrid] = useState<Record<string, Cell>>({}); // key: `${weekday}-${period}`
  const [maxPeriod, setMaxPeriod] = useState(8);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [{ data: teacherRows }, { data: classRows }, currentTerm] = await Promise.all([
        supabase.from('teachers').select('id, name').order('name'),
        supabase.from('classes').select('id, grade_level, class_name, academic_year').order('grade_level').order('class_name'),
        resolveCurrentTerm(),
      ]);
      setTeacherOptions((teacherRows ?? []).map((t: any) => ({ id: t.id, label: t.name })));
      setClassOptions((classRows ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}`, academicYear: c.academic_year })));
      if (currentTerm) {
        setAcademicYear(currentTerm.academic_year);
        setTerm(currentTerm.term);
      }
    })();
  }, []);

  useEffect(() => {
    setGrid({});
    if (!selectedId || academicYear == null || !term) return;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const filterCol = mode === 'teacher' ? 'teacher_id' : 'class_id';
      // 查班級課表時，優先用「這個班級自己的學年度」而不是全站目前生效的學年度——
      // 否則選一個非「目前生效學年度」的班級（例如查去年班級課表）時，會因為學年度
      // 對不起來而永遠查到空結果，即使那個班級當年確實有排課。
      const selectedClassYear = mode === 'class' ? classOptions.find((c) => c.id === selectedId)?.academicYear : undefined;
      const queryYear = selectedClassYear ?? academicYear;
      const { data, error } = await supabase
        .from('class_schedule')
        .select('weekday, period_no, subject, class_id, teacher_id, classes(grade_level, class_name), teachers(name)')
        .eq(filterCol, selectedId)
        .eq('academic_year', queryYear)
        .eq('term', term)
        .not('weekday', 'is', null)
        .not('period_no', 'is', null);
      setLoading(false);
      if (error) {
        setLoadError('讀取課表失敗：' + error.message);
        return;
      }
      const next: Record<string, Cell> = {};
      let maxP = 8;
      (data ?? []).forEach((r: any) => {
        const key = `${r.weekday}-${r.period_no}`;
        next[key] = {
          subject: r.subject,
          teacherName: r.teachers?.name,
          classLabel: r.classes ? `${r.classes.grade_level}${r.classes.class_name}` : undefined,
        };
        if (r.period_no > maxP) maxP = r.period_no;
      });
      setGrid(next);
      setMaxPeriod(maxP);
    })();
  }, [selectedId, mode, academicYear, term]);

  const periods = useMemo(() => Array.from({ length: maxPeriod }, (_, i) => i + 1), [maxPeriod]);
  const options = mode === 'teacher' ? teacherOptions : classOptions;

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>查詢教師/班級課表</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        選一位老師或一個班級，直接看整週課表。{academicYear != null && term ? `目前查詢的學年學期：${academicYear} 學年度／${term}` : ''}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as 'teacher' | 'class');
            setSelectedId('');
          }}
          style={{ padding: 6 }}
        >
          <option value="teacher">查教師課表</option>
          <option value="class">查班級課表</option>
        </select>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={{ padding: 6, minWidth: 200 }}>
          <option value="">{mode === 'teacher' ? '選擇教師' : '選擇班級'}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}
      {loading && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}

      {selectedId && !loading && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ padding: 6, border: '1px solid #eee', background: '#F5F5F3' }}></th>
              {WEEKDAY_LABELS.map((w) => (
                <th key={w} style={{ padding: 6, border: '1px solid #eee', background: '#F5F5F3' }}>
                  星期{w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p}>
                <td style={{ padding: 6, border: '1px solid #eee', background: '#F5F5F3', textAlign: 'center' }}>第{p}節</td>
                {WEEKDAY_LABELS.map((_, wi) => {
                  const cell = grid[`${wi + 1}-${p}`];
                  return (
                    <td key={wi} style={{ padding: 6, border: '1px solid #eee', textAlign: 'center' }}>
                      {cell ? (
                        <>
                          <div>{cell.subject}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{mode === 'teacher' ? cell.classLabel : cell.teacherName}</div>
                        </>
                      ) : (
                        <span style={{ color: '#ccc' }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
