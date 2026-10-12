'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

// 殘留科目清理（見 sql/103）：
// 「班級成績總表」會把成績表裡有分數的科目都列成欄位，但「學生成績登錄」的科目下拉
// 只列排課科目＋科目與比重設定，所以誤植/遺留的科目沒有任何地方可以修正或刪除。
// 這裡把「成績表有分數、但該年級該學期的科目與比重設定裡沒有」的科目全部列出來，
// 讓教務處可以：刪除這些分數，或改掛到正確的科目。刪除／修改都會留下成績稽核紀錄。

type OrphanRow = {
  class_id: string;
  class_label: string;
  academic_year: number;
  term: string;
  grade_level: string;
  subject: string;
  score_count: number;
  student_count: number;
};

type Group = {
  key: string;
  academic_year: number;
  term: string;
  grade_level: string;
  subject: string;
  classes: { class_id: string; label: string; score_count: number; student_count: number }[];
  total: number;
};

export default function OrphanSubjectsPanel() {
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | ''>('');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<OrphanRow[]>([]);
  const [curriculumSubjects, setCurriculumSubjects] = useState<Record<string, string[]>>({});
  const [targetByGroup, setTargetByGroup] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 二段式確認（LINE 內建瀏覽器擋 window.confirm，所以用畫面內的「再按一次確認」）
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('classes').select('academic_year');
      const ys = Array.from(new Set((data ?? []).map((r: any) => Number(r.academic_year)))).sort((a, b) => b - a);
      setYears(ys);
      if (ys.length > 0) setYear(ys[0]);
    })();
  }, []);

  async function load() {
    if (year === '') return;
    setLoading(true);
    setError(null);
    setArmed(null);
    const [orphanRes, curriRes] = await Promise.all([
      supabase.rpc('orphan_score_subjects', { p_academic_year: year, p_term: term || null }),
      supabase.from('curriculum').select('term, grade_level, subject').eq('academic_year', year).range(0, 4999),
    ]);
    setLoading(false);
    if (orphanRes.error) {
      setError('讀取殘留科目失敗：' + orphanRes.error.message + '（如果是找不到函式，請先執行 sql/103）');
      setRows([]);
      return;
    }
    setRows((orphanRes.data ?? []) as OrphanRow[]);
    const map: Record<string, string[]> = {};
    (curriRes.data ?? []).forEach((r: any) => {
      const k = `${year}|${r.term}|${r.grade_level}`;
      (map[k] = map[k] ?? []).push(r.subject);
    });
    setCurriculumSubjects(map);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, term]);

  const groups: Group[] = useMemo(() => {
    const m = new Map<string, Group>();
    rows.forEach((r) => {
      const key = `${r.academic_year}|${r.term}|${r.grade_level}|${r.subject}`;
      let g = m.get(key);
      if (!g) {
        g = { key, academic_year: r.academic_year, term: r.term, grade_level: r.grade_level, subject: r.subject, classes: [], total: 0 };
        m.set(key, g);
      }
      g.classes.push({ class_id: r.class_id, label: r.class_label, score_count: Number(r.score_count), student_count: Number(r.student_count) });
      g.total += Number(r.score_count);
    });
    return Array.from(m.values());
  }, [rows]);

  async function runDelete(g: Group, classId: string | null) {
    setBusy(true);
    setMessage(null);
    const { data, error: err } = await supabase.rpc('delete_orphan_score_subject', {
      p_academic_year: g.academic_year,
      p_term: g.term,
      p_grade_level: g.grade_level,
      p_subject: g.subject,
      p_class_id: classId,
    });
    setBusy(false);
    setArmed(null);
    if (err) {
      setError('刪除失敗：' + err.message);
      return;
    }
    setMessage(`已刪除「${g.subject}」共 ${data ?? 0} 筆成績。`);
    load();
  }

  async function runMove(g: Group, classId: string | null) {
    const target = targetByGroup[g.key];
    if (!target) {
      alert('請先選擇要改掛到哪一個正確的科目');
      return;
    }
    setBusy(true);
    setMessage(null);
    const { data, error: err } = await supabase.rpc('move_orphan_score_subject', {
      p_academic_year: g.academic_year,
      p_term: g.term,
      p_grade_level: g.grade_level,
      p_old_subject: g.subject,
      p_new_subject: target,
      p_class_id: classId,
    });
    setBusy(false);
    setArmed(null);
    if (err) {
      setError('搬移失敗：' + err.message);
      return;
    }
    const res = data as { moved: number; skipped: number } | null;
    setMessage(
      `已把「${g.subject}」的 ${res?.moved ?? 0} 筆成績改掛到「${target}」。` +
        (res && res.skipped > 0 ? `另有 ${res.skipped} 筆因為該學生「${target}」同一種考試已經有分數，沒有覆蓋，仍留在下方清單，請確認後決定是否刪除。` : '')
    );
    load();
  }

  const btn: React.CSSProperties = { fontSize: 12, padding: '3px 10px', cursor: 'pointer' };
  const armedStyle: React.CSSProperties = { ...btn, background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 };

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 10, lineHeight: 1.7 }}>
        這裡列出「成績表裡有分數，但該學年度／學期／年級的【科目與比重設定】裡已經沒有」的科目（例如誤植、遺留的科目）。
        這些科目會出現在班級成績總表的欄位，卻在登錄頁和科目設定裡找不到，所以無法修正。
        你可以<b>刪除</b>這些分數，或<b>改掛</b>到正確的科目（學生在正確科目同一種考試已有分數的不會被覆蓋）。
        刪除與修改都會寫入成績稽核紀錄。完全沒設定過科目與比重的舊學期不會被列入。
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={year} onChange={(e) => setYear(e.target.value === '' ? '' : Number(e.target.value))} style={{ padding: 6 }}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y} 學年度
            </option>
          ))}
        </select>
        <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ padding: 6 }}>
          <option value="">上下學期都看</option>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <button onClick={load} style={btn} disabled={loading}>
          重新整理
        </button>
      </div>

      <ErrorBanner message={error} />
      {message && (
        <p style={{ fontSize: 12, color: '#2E6B3A', background: '#EEF7EF', border: '1px solid #bfe0c4', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>{message}</p>
      )}
      {loading && <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>}
      {!loading && !error && groups.length === 0 && (
        <p style={{ fontSize: 13, color: '#2E6B3A' }}>目前沒有殘留科目，所有成績都對得上科目與比重設定。</p>
      )}

      {groups.map((g) => {
        const options = (curriculumSubjects[`${g.academic_year}|${g.term}|${g.grade_level}`] ?? []).filter((s) => s !== '全勤' && s !== '出缺席');
        const isOpen = expanded.has(g.key);
        return (
          <div key={g.key} style={{ border: '1px solid #E5E1D8', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 14 }}>{g.subject}</b>
              <span style={{ fontSize: 12, color: '#666' }}>
                {g.academic_year} 學年度 {g.term}・{g.grade_level}・{g.classes.length} 班・共 {g.total} 筆成績
              </span>
              <button
                style={btn}
                onClick={() =>
                  setExpanded((prev) => {
                    const n = new Set(prev);
                    if (n.has(g.key)) n.delete(g.key);
                    else n.add(g.key);
                    return n;
                  })
                }
              >
                {isOpen ? '收合班級' : '展開看各班'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <select
                value={targetByGroup[g.key] ?? ''}
                onChange={(e) => setTargetByGroup((p) => ({ ...p, [g.key]: e.target.value }))}
                style={{ padding: 4, fontSize: 12 }}
              >
                <option value="">改掛到…（選正確科目）</option>
                {options.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {armed === `move|${g.key}|all` ? (
                <>
                  <button style={armedStyle} disabled={busy} onClick={() => runMove(g, null)}>
                    確定：全部 {g.classes.length} 班改掛
                  </button>
                  <button style={btn} onClick={() => setArmed(null)}>取消</button>
                </>
              ) : (
                <button style={btn} disabled={busy || !targetByGroup[g.key]} onClick={() => setArmed(`move|${g.key}|all`)}>
                  全部班級改掛
                </button>
              )}
              {armed === `del|${g.key}|all` ? (
                <>
                  <button style={armedStyle} disabled={busy} onClick={() => runDelete(g, null)}>
                    確定：刪除全部 {g.total} 筆
                  </button>
                  <button style={btn} onClick={() => setArmed(null)}>取消</button>
                </>
              ) : (
                <button style={{ ...btn, color: '#A32D2D' }} disabled={busy} onClick={() => setArmed(`del|${g.key}|all`)}>
                  全部班級刪除
                </button>
              )}
            </div>
            {isOpen && (
              <table style={{ width: '100%', fontSize: 12, marginTop: 8, borderCollapse: 'collapse' }}>
                <tbody>
                  {g.classes.map((c) => (
                    <tr key={c.class_id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: '4px 6px' }}>{c.label}</td>
                      <td style={{ padding: '4px 6px', color: '#666' }}>
                        {c.student_count} 位學生・{c.score_count} 筆
                      </td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {armed === `move|${g.key}|${c.class_id}` ? (
                          <>
                            <button style={armedStyle} disabled={busy} onClick={() => runMove(g, c.class_id)}>確定改掛</button>{' '}
                            <button style={btn} onClick={() => setArmed(null)}>取消</button>
                          </>
                        ) : (
                          <button style={btn} disabled={busy || !targetByGroup[g.key]} onClick={() => setArmed(`move|${g.key}|${c.class_id}`)}>
                            此班改掛
                          </button>
                        )}{' '}
                        {armed === `del|${g.key}|${c.class_id}` ? (
                          <>
                            <button style={armedStyle} disabled={busy} onClick={() => runDelete(g, c.class_id)}>確定刪除</button>{' '}
                            <button style={btn} onClick={() => setArmed(null)}>取消</button>
                          </>
                        ) : (
                          <button style={{ ...btn, color: '#A32D2D' }} disabled={busy} onClick={() => setArmed(`del|${g.key}|${c.class_id}`)}>
                            此班刪除
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
