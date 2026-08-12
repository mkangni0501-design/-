'use client';

import { Fragment, useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';

type SubjectRow = { enrollment_id: string; subject: string; midterm: number | null; final: number | null; daily: number | null };
type RankRow = {
  enrollment_id: string;
  total_score: number;
  class_rank?: number;
  midterm_total?: number | null;
  midterm_class_rank?: number | null;
  final_total?: number | null;
  final_class_rank?: number | null;
  daily_total?: number | null;
  daily_class_rank?: number | null;
};
type GradeRankRow = {
  grade_rank?: number;
  midterm_grade_rank?: number | null;
  final_grade_rank?: number | null;
  daily_grade_rank?: number | null;
};
type EnrollRow = { id: string; seat_no: number; name: string };
type ClassOption = { id: string; label: string };

const EXAM_TYPE_FIELD: Record<'期中考' | '期末考' | '平時分', 'midterm' | 'final' | 'daily'> = {
  期中考: 'midterm',
  期末考: 'final',
  平時分: 'daily',
};
const EXAM_TYPE_LABEL: Record<'期中考' | '期末考' | '平時分', string> = {
  期中考: '期中',
  期末考: '期末',
  平時分: '平時',
};
// 對應 class_rankings / grade_rankings view 上，各類別「總分」欄位的名稱
const EXAM_TYPE_TOTAL_FIELD: Record<'期中考' | '期末考' | '平時分', 'midterm_total' | 'final_total' | 'daily_total'> = {
  期中考: 'midterm_total',
  期末考: 'final_total',
  平時分: 'daily_total',
};
const EXAM_TYPE_CLASS_RANK_FIELD: Record<'期中考' | '期末考' | '平時分', 'midterm_class_rank' | 'final_class_rank' | 'daily_class_rank'> = {
  期中考: 'midterm_class_rank',
  期末考: 'final_class_rank',
  平時分: 'daily_class_rank',
};
const EXAM_TYPE_GRADE_RANK_FIELD: Record<'期中考' | '期末考' | '平時分', 'midterm_grade_rank' | 'final_grade_rank' | 'daily_grade_rank'> = {
  期中考: 'midterm_grade_rank',
  期末考: 'final_grade_rank',
  平時分: 'daily_grade_rank',
};

export default function ClassSummaryPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [className, setClassName] = useState('');
  const [classId, setClassId] = useState<string | null>(null);
  const [academicYear, setAcademicYear] = useState<number | null>(null);
  const [term, setTerm] = useState<string | null>(null);
  const [isHomeroom, setIsHomeroom] = useState(false);
  const [dailyLocked, setDailyLocked] = useState(false);
  const [enrollments, setEnrollments] = useState<EnrollRow[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subjectData, setSubjectData] = useState<Record<string, Record<string, SubjectRow>>>({}); // enrollment_id -> subject -> row
  const [classRank, setClassRank] = useState<Record<string, RankRow>>({});
  const [gradeRank, setGradeRank] = useState<Record<string, GradeRankRow>>({});
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [canSeeRemarks, setCanSeeRemarks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'all' | '期中考' | '期末考' | '平時分'>('all');

  const visibleExamTypes: Array<'期中考' | '期末考' | '平時分'> =
    viewMode === 'all' ? ['期中考', '期末考', '平時分'] : [viewMode];

  // 初始化：判斷身分。管理員可選任何班級；導師固定看自己導的班級。
  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);
      if (admin) setCanSeeRemarks(true);

      if (admin) {
        const { data: allClasses } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        const options = (allClasses ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
        }));
        setClassOptions(options);
        if (options.length > 0) setClassId(options[0].id);
        else setLoading(false);
        return;
      }

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (teacherRow) {
        const { data: cls } = await supabase
          .from('classes')
          .select('id, class_name, grade_level, academic_year')
          .eq('homeroom_teacher_id', teacherRow.id)
          .maybeSingle();
        if (cls) {
          setClassId(cls.id);
          setAcademicYear(cls.academic_year);
          setClassName(`${cls.grade_level}${cls.class_name}`);
          setCanSeeRemarks(true); // 導師本人
          setIsHomeroom(true);
          return;
        }
      }
      setLoading(false); // 既不是管理員也不是導師（例如任課教師），本頁無班級可看
    })();
  }, []);

  // 每次 classId 變動：重新載入該班的完整資料
  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }

      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('id, seat_no, term, students(name)')
        .eq('class_id', classId)
        .eq('is_current', true)
        .order('seat_no');
      const enrolls: EnrollRow[] = (enrollRows ?? []).map((r: any) => ({ id: r.id, seat_no: r.seat_no, name: r.students.name }));
      setEnrollments(enrolls);
      const enrollIds = enrolls.map((e) => e.id);
      let currentTerm: string | null = null;
      if (enrollRows && enrollRows.length > 0) {
        currentTerm = (enrollRows[0] as any).term;
        setTerm(currentTerm);
      }
      if (!academicYear) {
        const { data: clsRow } = await supabase.from('classes').select('academic_year').eq('id', classId).maybeSingle();
        if (clsRow) setAcademicYear(clsRow.academic_year);
      }

      // 各科明細：任課教師只會看到自己教的科目那幾列（RLS在資料庫層級自然過濾，非前端隱藏）
      const { data: subjectRows } = await supabase
        .from('subject_weighted_scores')
        .select('enrollment_id, subject, midterm, final, daily')
        .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);

      const subjSet = new Set<string>();
      const subjMap: Record<string, Record<string, SubjectRow>> = {};
      (subjectRows ?? []).forEach((r: any) => {
        subjSet.add(r.subject);
        subjMap[r.enrollment_id] = subjMap[r.enrollment_id] ?? {};
        subjMap[r.enrollment_id][r.subject] = r;
      });
      setSubjects(Array.from(subjSet));
      setSubjectData(subjMap);

      // 總分/班排名：class_rankings/grade_rankings 這兩個 view 已經在資料庫層級限制，
      // 只有該班導師與管理員查得到，任課教師查詢會得到空結果（不是前端隱藏，是查不到）
      // 除了「總表」(加權後總分/排名)，也一併取出期中/期末/平時各自的原始總分與排名。
      const { data: rankRows } = await supabase
        .from('class_rankings')
        .select(
          'enrollment_id, total_score, class_rank, midterm_total, midterm_class_rank, final_total, final_class_rank, daily_total, daily_class_rank'
        )
        .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);
      const rankMap: Record<string, RankRow> = {};
      (rankRows ?? []).forEach((r: any) => (rankMap[r.enrollment_id] = r));
      setClassRank(rankMap);

      const { data: gradeRows } = await supabase
        .from('grade_rankings')
        .select('enrollment_id, grade_rank, midterm_grade_rank, final_grade_rank, daily_grade_rank')
        .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);
      const gradeMap: Record<string, GradeRankRow> = {};
      (gradeRows ?? []).forEach(
        (r: any) =>
          (gradeMap[r.enrollment_id] = {
            grade_rank: r.grade_rank,
            midterm_grade_rank: r.midterm_grade_rank,
            final_grade_rank: r.final_grade_rank,
            daily_grade_rank: r.daily_grade_rank,
          })
      );
      setGradeRank(gradeMap);

      if (canSeeRemarks || isAdmin) {
        const { data: remarkRows } = await supabase
          .from('student_remarks')
          .select('enrollment_id, comment')
          .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);
        const remarkMap: Record<string, string> = {};
        (remarkRows ?? []).forEach((r: any) => (remarkMap[r.enrollment_id] = r.comment ?? ''));
        setRemarks(remarkMap);
      }

      // 查詢「平時分」目前是否已鎖定（決定要不要顯示「確認送出並鎖定」按鈕）
      if (academicYear && currentTerm) {
        const { data: windowRow } = await supabase
          .from('submission_windows')
          .select('is_locked')
          .eq('data_type', '平時分')
          .eq('scope', '班級')
          .eq('scope_ref', classId)
          .eq('academic_year', academicYear)
          .eq('term', currentTerm)
          .maybeSingle();
        setDailyLocked(!!windowRow?.is_locked);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  // 導師點下「確認送出並鎖定」：等同提前結束平時分輸入時間，
  // 鎖定後導師與任課教師都無法再修改平時分，須經管理員A審核修正申請才能再改。
  async function handleLockDailyScore() {
    if (!classId || !academicYear || !term) return;
    if (!confirm('確定要送出並鎖定本班平時分嗎？鎖定後，任何人（含你自己）都無法直接修改，需經管理員A審核才能再調整。')) {
      return;
    }
    const { error } = await supabase.from('submission_windows').upsert(
      {
        academic_year: academicYear,
        term,
        data_type: '平時分',
        scope: '班級',
        scope_ref: classId,
        is_locked: true,
      },
      { onConflict: 'academic_year,term,data_type,scope,scope_ref' }
    );
    if (error) {
      alert('鎖定失敗：' + error.message);
    } else {
      setDailyLocked(true);
      alert('已鎖定，班排名與年級排名將開始顯示。');
    }
  }

  async function handlePrintReportCard(enrollmentId: string) {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    const res = await fetch(`/api/reports/report-card/${enrollmentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      alert('產生成績單失敗');
      return;
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  }

  // 批次列印「目前這個班」全班成績單（導師印自己班、管理員印目前選到的班都能用）。
  // 教務部門要一次印多班／全校，請到「成績相關設定及查詢」→「批次列印成績單（多班／全校）」分頁。
  async function handleBatchPrintClass(skipIncomplete = false) {
    if (!classId) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    const url = `/api/reports/report-card/batch${skipIncomplete ? '?skipIncomplete=true' : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ classIds: [classId] }),
    });

    if (res.status === 409) {
      const body = await res.json();
      const names = (body.notReady ?? []).map((s: any) => `${s.studentName}(${s.reason})`).join('、');
      const confirmSkip = confirm(`以下學生尚未能產出成績單：\n${names}\n\n要跳過這些人、先列印其餘已完成的嗎？`);
      if (confirmSkip) return handleBatchPrintClass(true);
      return;
    }

    if (!res.ok) {
      alert('批次列印失敗，請稍後再試');
      return;
    }

    const skipped = res.headers.get('X-Skipped-Students');
    if (skipped) {
      const list = JSON.parse(decodeURIComponent(skipped));
      alert(`已跳過 ${list.length} 位尚未鎖定的學生：${list.map((s: any) => s.studentName).join('、')}`);
    }

    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, overflowX: 'auto' }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 成績總表</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        任課教師登入本頁時，只會看到自己授課科目的欄位；總分、排名、評語僅導師與管理員可見。
      </p>

      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      {isAdmin && classOptions.length > 0 && (
        <select
          value={classId ?? ''}
          onChange={(e) => setClassId(e.target.value)}
          className="no-print"
          style={{ padding: 8, marginBottom: 16, width: '100%', maxWidth: 320 }}
        >
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      {classId && (
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#666' }}>檢視/列印範圍：</span>
          {(['all', '期中考', '期末考', '平時分'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid #ccc',
                background: viewMode === v ? '#2C2C2A' : '#fff',
                color: viewMode === v ? '#fff' : '#2C2C2A',
              }}
            >
              {v === 'all' ? '全部' : v}
            </button>
          ))}
          <button
            onClick={() => window.print()}
            style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 6, background: '#2C2C2A', color: '#fff', border: 'none' }}
          >
            列印本頁（依目前選擇範圍）
          </button>
          <button
            onClick={() => handleBatchPrintClass()}
            className="no-print"
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, background: '#6B5B3A', color: '#fff', border: 'none' }}
          >
            批次列印全班成績單（PDF）
          </button>
        </div>
      )}

      {!classId && !loading && (
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（若您是任課教師，請改用「學生成績登錄」頁登錄成績）。</p>
      )}

      {isHomeroom && (
        <div className="no-print" style={{ marginBottom: 16 }}>
          {dailyLocked ? (
            <p style={{ fontSize: 13, color: '#3B6D11' }}>✓ 平時分已鎖定，班排名與年級排名已開放顯示。</p>
          ) : (
            <button
              onClick={handleLockDailyScore}
              style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13 }}
            >
              確認送出並鎖定平時分（提前結束輸入）
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        classId && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                {subjects.map((s) => (
                  <th key={s} colSpan={visibleExamTypes.length} style={{ padding: 6, borderLeft: '1px solid #eee' }}>
                    {s}
                  </th>
                ))}
                {visibleExamTypes.map((et) => (
                  <th key={'grp-' + et} colSpan={3} style={{ padding: 6, borderLeft: '1px solid #eee' }}>
                    {EXAM_TYPE_LABEL[et]}總分／排名
                  </th>
                ))}
                {viewMode === 'all' && (
                  <th colSpan={3} style={{ padding: 6, borderLeft: '1px solid #eee' }}>
                    總表（期中*比例＋期末*比例＋平時*比例）
                  </th>
                )}
                {canSeeRemarks && <th style={{ textAlign: 'left', padding: 6 }}>導師評語</th>}
                {canSeeRemarks && <th style={{ padding: 6 }}>成績單</th>}
              </tr>
              <tr style={{ fontSize: 11, color: '#999' }}>
                <th></th>
                <th></th>
                {subjects.map((s) =>
                  visibleExamTypes.map((et) => <th key={s + et}>{EXAM_TYPE_LABEL[et]}</th>)
                )}
                {visibleExamTypes.map((et) => (
                  <Fragment key={et}>
                    <th key={et + '-total'}>總分</th>
                    <th key={et + '-crank'}>班排名</th>
                    <th key={et + '-grank'}>年級排名</th>
                  </Fragment>
                ))}
                {viewMode === 'all' && (
                  <>
                    <th>總分</th>
                    <th>班排名</th>
                    <th>年級排名</th>
                  </>
                )}
                {canSeeRemarks && <th></th>}
                {canSeeRemarks && <th></th>}
              </tr>
            </thead>
            <tbody>
              {enrollments.map((en) => (
                <tr key={en.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{en.seat_no}</td>
                  <td style={{ padding: 6 }}>{en.name}</td>
                  {subjects.map((s) => {
                    const row = subjectData[en.id]?.[s];
                    return visibleExamTypes.map((et) => (
                      <td key={s + et} style={{ padding: 6, textAlign: 'center' }}>
                        {row?.[EXAM_TYPE_FIELD[et]] ?? '—'}
                      </td>
                    ));
                  })}
                  {visibleExamTypes.map((et) => (
                    <Fragment key={en.id + et}>
                      <td key={en.id + et + '-total'} style={{ padding: 6, textAlign: 'center', borderLeft: '1px solid #eee' }}>
                        {classRank[en.id]?.[EXAM_TYPE_TOTAL_FIELD[et]] ?? '—'}
                      </td>
                      <td key={en.id + et + '-crank'} style={{ padding: 6, textAlign: 'center' }}>
                        {classRank[en.id]?.[EXAM_TYPE_CLASS_RANK_FIELD[et]] ?? '—'}
                      </td>
                      <td key={en.id + et + '-grank'} style={{ padding: 6, textAlign: 'center' }}>
                        {gradeRank[en.id]?.[EXAM_TYPE_GRADE_RANK_FIELD[et]] ?? '—'}
                      </td>
                    </Fragment>
                  ))}
                  {viewMode === 'all' && (
                    <>
                      <td style={{ padding: 6, textAlign: 'center', borderLeft: '1px solid #eee' }}>{classRank[en.id]?.total_score ?? '—'}</td>
                      <td style={{ padding: 6, textAlign: 'center' }}>{classRank[en.id]?.class_rank ?? '—'}</td>
                      <td style={{ padding: 6, textAlign: 'center' }}>{gradeRank[en.id]?.grade_rank ?? '—'}</td>
                    </>
                  )}
                  {canSeeRemarks && <td style={{ padding: 6 }}>{remarks[en.id] ?? ''}</td>}
                  {canSeeRemarks && (
                    <td style={{ padding: 6, textAlign: 'center' }}>
                      <button onClick={() => handlePrintReportCard(en.id)} className="no-print" style={{ fontSize: 12, padding: '2px 8px' }}>
                        列印
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {enrollments.length === 0 && (
                <tr>
                  <td colSpan={99} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    這個班級目前沒有在學學生
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}
