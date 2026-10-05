'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentTeacherId } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { resolveCurrentTerm } from '@/lib/academicTerm';

type ClubOption = { id: string; name: string };
type ScoreRow = {
  student_no: string;
  name: string;
  class_label: string;
  seat_no: number | null;
  score_midterm: number | null;
  score_final: number | null;
  score_daily: number | null;
  is_submitted: boolean;
};
type Weights = { midterm_weight: number; final_weight: number; daily_weight: number };

// 社團成績輸入頁：欄位比照現有其他科目（期中考／期末考／平時分），不是另外發明的評分方式。
// 老師可先「暫存」多次修改，正式送出後鎖定，系統會自動把這三項分數回寫進學期總成績的
// 「才藝」科目（見 sql/54clubs_module.sql），最終加權比重跟其他科目一樣，統一用教務處
// 「成績設定」（grading_rules）的全校期中/期末/平時比重去算，這裡不用也不能另外調整。
export default function ClubGradingPage() {
  const isMobile = useIsMobile();
  const [clubs, setClubs] = useState<ClubOption[]>([]);
  const [selectedClubId, setSelectedClubId] = useState('');
  const [weights, setWeights] = useState<Weights | null>(null);
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [noAssignment, setNoAssignment] = useState(false);
  const [term, setTerm] = useState<{ academic_year: number; term: string } | null>(null);

  useEffect(() => {
    (async () => {
      const teacherId = await getCurrentTeacherId();
      if (!teacherId) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }
      const t = await resolveCurrentTerm();
      setTerm(t);
      let q = supabase.from('clubs').select('id, name').eq('teacher_id', teacherId).eq('is_active', true);
      if (t) {
        q = q.eq('academic_year', t.academic_year).eq('term', t.term);
        const { data: ruleRow } = await supabase
          .from('grading_rules')
          .select('midterm_weight, final_weight, daily_weight')
          .eq('academic_year', t.academic_year)
          .eq('term', t.term)
          .maybeSingle();
        if (ruleRow) setWeights(ruleRow as Weights);
      }
      const { data, error: clubErr } = await q.order('name');
      if (clubErr) {
        setError('讀取社團資料失敗：' + clubErr.message);
        setLoading(false);
        return;
      }
      if (!data || data.length === 0) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }
      setClubs(data as ClubOption[]);
      setSelectedClubId(data[0].id);
      setLoading(false);
    })();
  }, []);

  async function loadClubData(clubId: string) {
    setLoading(true);
    setError(null);
    setSaveMsg(null);

    const { data: memberRows, error: memberErr } = await supabase
      .from('club_members')
      .select('student_no, students(name), enrollments(seat_no, term, classes(grade_level, class_name, academic_year))')
      .eq('club_id', clubId)
      .eq('status', '在社');
    if (memberErr) {
      setError('讀取社團名單失敗：' + memberErr.message);
      setLoading(false);
      return;
    }

    const { data: scoreRows } = await supabase
      .from('club_scores')
      .select('student_no, score_midterm, score_final, score_daily, is_submitted')
      .eq('club_id', clubId);
    const scoreMap = new Map((scoreRows ?? []).map((s: any) => [s.student_no, s]));

    const built: ScoreRow[] = (memberRows ?? []).map((r: any) => {
      const enrollmentList = Array.isArray(r.enrollments) ? r.enrollments : r.enrollments ? [r.enrollments] : [];
      const currentEnrollment = term ? enrollmentList.find((e: any) => e?.term === term.term && e?.classes?.academic_year === term.academic_year) ?? null : enrollmentList[0] ?? null;
      const existing: any = scoreMap.get(r.student_no);
      return {
        student_no: r.student_no,
        name: r.students?.name ?? r.student_no,
        class_label: currentEnrollment ? `${currentEnrollment.classes?.grade_level ?? ''}${currentEnrollment.classes?.class_name ?? ''}` : '－',
        seat_no: currentEnrollment?.seat_no ?? null,
        score_midterm: existing?.score_midterm ?? null,
        score_final: existing?.score_final ?? null,
        score_daily: existing?.score_daily ?? null,
        is_submitted: existing?.is_submitted ?? false,
      };
    });
    built.sort((a, b) => a.class_label.localeCompare(b.class_label) || (a.seat_no ?? 0) - (b.seat_no ?? 0));
    setRows(built);
    setLoading(false);
  }

  useEffect(() => {
    if (selectedClubId) loadClubData(selectedClubId);
  }, [selectedClubId]);

  function updateScore(studentNo: string, field: 'score_midterm' | 'score_final' | 'score_daily', value: string) {
    const num = value === '' ? null : Math.max(0, Math.min(100, Number(value)));
    setRows((prev) => prev.map((r) => (r.student_no === studentNo ? { ...r, [field]: num } : r)));
  }

  async function saveAll(submit: boolean) {
    setSaving(true);
    setError(null);
    setSaveMsg(null);
    const teacherId = await getCurrentTeacherId();

    // 【2026-08-24 修正】原本這裡不管暫存還是正式送出，都把 rows 裡「所有」
    // 學生（包含已經正式送出、被鎖定的）一起 upsert，且 is_submitted 統一
    // 設成這次按鈕的 submit 參數——這表示點「暫存」時，會把已經送出鎖定的
    // 學生的 is_submitted 從 true 又寫回 false，等於悄悄把鎖定解開；即使
    // RLS（club_teacher_manage_scores）的 using 子句本來就只允許在
    // is_submitted 還是 false 時才能更新，一般社團老師對已鎖定的列直接被
    // RLS 擋下也只會讓整個 upsert 失敗或部分失敗，不是我們要的行為。正確
    // 做法是从一開始就把已經送出鎖定的學生排除在外，不管暫存或正式送出，
    // 都只處理「還沒送出」的那些列。
    const editableRows = rows.filter((r) => !r.is_submitted);

    if (editableRows.length === 0) {
      setSaveMsg('所有學生都已經正式送出鎖定，沒有可以更新的項目。');
      setSaving(false);
      return;
    }

    if (submit) {
      const incomplete = editableRows.filter((r) => r.score_midterm === null && r.score_final === null && r.score_daily === null);
      if (incomplete.length > 0) {
        setError(`「${incomplete.map((r) => r.name).join('、')}」完全沒有輸入任何分數，無法正式送出`);
        setSaving(false);
        return;
      }
    }

    const upsertRows = editableRows.map((r) => ({
      club_id: selectedClubId,
      student_no: r.student_no,
      score_midterm: r.score_midterm,
      score_final: r.score_final,
      score_daily: r.score_daily,
      is_submitted: submit,
      submitted_at: submit ? new Date().toISOString() : null,
      recorded_by: teacherId,
    }));
    const { error: upsertErr } = await supabase.from('club_scores').upsert(upsertRows, { onConflict: 'club_id,student_no' });
    if (upsertErr) {
      setError((submit ? '正式送出' : '暫存') + '失敗：' + upsertErr.message);
    } else {
      setSaveMsg(submit ? '已正式送出並鎖定，分數已同步回寫學期總成績「才藝」科目' : '已暫存，尚未正式送出');
      loadClubData(selectedClubId);
    }
    setSaving(false);
  }

  if (noAssignment) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16 }}>社團成績輸入</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有指派給您的社團，如有需要請洽教務處。</p>
      </main>
    );
  }

  const anySubmitted = rows.some((r) => r.is_submitted);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>社團成績輸入</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
        欄位跟其他科目一樣分「期中考／期末考／平時分」三段，哪幾項有上就填哪幾項。正式送出後鎖定，會自動回寫進學期總成績的「才藝」科目，如需修改請洽教務處協助解鎖。
      </p>
      {weights && (
        <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
          本學期加權比例（與其他科目相同，於教務處「成績設定」調整）：期中 {Math.round(weights.midterm_weight * 100)}% ／期末 {Math.round(weights.final_weight * 100)}% ／平時{' '}
          {Math.round(weights.daily_weight * 100)}%
        </p>
      )}

      {clubs.length > 1 && (
        <select value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)} style={{ padding: 8, marginBottom: 16 }}>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      {error && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{error}</p>}
      {saveMsg && <p style={{ fontSize: 13, color: '#2D7A3A', marginBottom: 12 }}>{saveMsg}</p>}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16, minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>原班級</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>期中考</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>期末考</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>平時分</th>
                  <th style={{ textAlign: 'center', padding: 6 }}>狀態</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.student_no} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{r.student_no}</td>
                    <td style={{ padding: 6 }}>{r.class_label}</td>
                    <td style={{ padding: 6 }}>{r.name}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={r.is_submitted}
                        value={r.score_midterm ?? ''}
                        onChange={(e) => updateScore(r.student_no, 'score_midterm', e.target.value)}
                        style={{ width: 64, padding: 4, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: 'right' }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={r.is_submitted}
                        value={r.score_final ?? ''}
                        onChange={(e) => updateScore(r.student_no, 'score_final', e.target.value)}
                        style={{ width: 64, padding: 4, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: 'right' }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        disabled={r.is_submitted}
                        value={r.score_daily ?? ''}
                        onChange={(e) => updateScore(r.student_no, 'score_daily', e.target.value)}
                        style={{ width: 64, padding: 4, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: 'center', color: r.is_submitted ? '#2D7A3A' : '#999' }}>{r.is_submitted ? '已送出' : '未送出'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                      這個社團目前沒有在社學生
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={() => saveAll(false)} disabled={saving || rows.every((r) => r.is_submitted)} style={{ padding: '8px 20px' }}>
              暫存
            </button>
            <button onClick={() => saveAll(true)} disabled={saving || rows.every((r) => r.is_submitted)} style={{ padding: '8px 20px', fontWeight: 600 }}>
              正式送出並鎖定
            </button>
          </div>
          {anySubmitted && <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>已送出的學生分數欄位會鎖定無法再自行修改，如需更正請洽教務處協助解鎖。</p>}
        </>
      )}
    </main>
  );
}
