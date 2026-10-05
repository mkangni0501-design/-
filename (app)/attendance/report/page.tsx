'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import { fetchAttendanceForStudents } from '@/lib/attendanceQueries';
import { resolveCurrentTerm, estimateTermStart } from '@/lib/academicTerm';
import { getEffectivePeriodCount } from '@/lib/periodConfig';
import { departmentForGrade } from '@/lib/gradeMapping';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = { id: string; label: string };
type StudentRow = { student_no: string; seat_no: number; name: string };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;
const EXCEPTION_STATUSES = ['曠課', '遲到', '病假', '事假', '公假'] as const;
type ExceptionRecord = { status: string; date: string; period: number };
const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
function formatRecordDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}（週${WEEKDAY_LABEL[d.getDay()]}）`;
}

function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 查看學生出席紀錄（月報／學期）：讓導師與管理員快速確認某個班級的出缺勤統計，
// 不用像「學生出缺席登錄（一週）」頁面一樣一週一週翻查。
function AttendanceReportPageInner() {
  const searchParams = useSearchParams();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isHomeroom, setIsHomeroom] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(searchParams?.get('classId') ?? null);
  const [className, setClassName] = useState('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [viewMode, setViewMode] = useState<'month' | 'term'>('month');
  const [monthValue, setMonthValue] = useState(currentMonthValue());
  const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [noClass, setNoClass] = useState(false);
  const [exceptions, setExceptions] = useState<Record<string, ExceptionRecord[]>>({});
  const [detailStudent, setDetailStudent] = useState<StudentRow | null>(null);
  const [rangeNote, setRangeNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      // 改用 isAdminInCurrentView()，讓「切換身分」在這頁也生效（見 attendance/mobile 同樣的修正）
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        const { data, error } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        if (error) {
          setLoadError('讀取班級清單失敗：' + error.message);
          return;
        }
        const options = (data ?? []).map((c: any) => ({ id: c.id, label: `${c.academic_year} ${c.grade_level}${c.class_name}` }));
        setClassOptions(options);
        if (!classId && options.length > 0) setClassId(options[0].id);
        if (options.length === 0) setNoClass(true);
        return;
      }

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (!teacherRow) {
        setNoClass(true);
        return;
      }
      const { data: cls } = await supabase
        .from('classes')
        .select('id, class_name, grade_level')
        .eq('homeroom_teacher_id', teacherRow.id)
        .maybeSingle();
      if (!cls) {
        setNoClass(true);
        return;
      }
      setIsHomeroom(true);
      setClassId(cls.id);
      setClassName(`${cls.grade_level}${cls.class_name}`);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      setLoadError(null);

      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }

      // 【本輪修正】enrollments 每位學生「上學期」「下學期」各有一列，原本沒有依學期過濾，
      // 同一位學生會被撈兩次（名單重複、React key 重複），改成只取目前學期、並以學號去重。
      const currentTerm = await resolveCurrentTerm();
      const { data: enrollRawAll, error: enrollErr } = await supabase
        .from('enrollments')
        .select('seat_no, student_no, term')
        .eq('class_id', classId)
        .order('seat_no');
      if (enrollErr) {
        setLoadError('讀取學生名單失敗：' + enrollErr.message);
        setLoading(false);
        return;
      }
      const preferTerm = currentTerm?.term;
      const seen = new Set<string>();
      const enrollRowsRaw = [
        ...(enrollRawAll ?? []).filter((r: any) => r.term === preferTerm),
        ...(enrollRawAll ?? []).filter((r: any) => r.term !== preferTerm),
      ].filter((r: any) => (seen.has(r.student_no) ? false : (seen.add(r.student_no), true)));
      enrollRowsRaw.sort((a: any, b: any) => a.seat_no - b.seat_no);
      const hiddenNos = isAdmin ? new Set<string>() : await getHiddenStudentNos((enrollRowsRaw ?? []).map((r: any) => r.student_no));
      const enrollRows = (enrollRowsRaw ?? []).filter((r: any) => !hiddenNos.has(r.student_no));
      const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
      const { data: studentRows } = await supabase
        .from('students')
        .select('student_no, name')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__']);
      const nameByStudentNo = new Map((studentRows ?? []).map((s: any) => [s.student_no, s.name]));
      const rows: StudentRow[] = (enrollRows ?? []).map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: nameByStudentNo.get(r.student_no) ?? '（找不到姓名）',
      }));
      setStudents(rows);

      // 【本輪修正】反映事項「只有少部分學生有資料，例如某生出缺席狀況只有病假2節、
      // 出席卻是0」——根因跟 attendance/subject-view 頁之前修過的問題完全一樣：
      // attendance 這張表只有老師「實際點過、跟預設值不同」的節次才會存成一筆紀錄，
      // 「出席」只是畫面上沒存檔時的預設值，資料庫裡幾乎不會有 status='出席' 的列
      // （只要老師沒特別把某節從出席改回出席存檔，那一節根本不會有紀錄）。原本這裡
      // 是直接數「資料庫裡實際有幾列 status='出席'」，全校每個學生的出席數字因此
      // 幾乎一定是 0，不是只有這一位學生的問題。修法跟 subject-view 一致：不要數
      // 「資料庫有幾列」，改成先把這個班級「到目前為止總共應該上了幾節課」都列出來，
      // 每一位學生每一節都算一格，資料庫有紀錄就用那筆的狀態，沒有紀錄就當作「出席」。
      //
      // 【本輪再次修正】上一輪的做法是用 class_schedule（課表排的科目節次）決定「有哪些
      // 節次」，這裡有漏洞：class_schedule 只包含「排了科目老師」的節次，像早自習、午休、
      // 班會、彈性課程這類沒有排科目老師、但導師登錄出缺勤頁面（attendance/weekly、
      // attendance/mobile）仍然會照樣開放輸入的節次，並不在 class_schedule 裡；這些節次
      // 即使資料庫裡有曠課/遲到/病假/事假/公假的紀錄，因為不在 class_schedule 枚舉出來的
      // 「有課節次」清單裡，就會被整段跳過、完全不會被算進任何欄位——不只出席被低估，
      // 曠課/遲到/病假/事假/公假這些例外紀錄也會一起被漏算，全校都受影響。
      // 真正決定「這一天總共有幾節」的資料來源，是導師登錄頁本來就在用的
      // getEffectivePeriodCount()（依「班級>部別>全校」找 period_config 設定的堂數），
      // 不是 class_schedule；這裡改成跟登錄頁一樣的依據，才能涵蓋所有真正開放登錄出缺勤
      // 的節次，不會漏算。
      let termStart: string | null = null;
      let termEnd: string | null = null;
      if (currentTerm) {
        const { data: termRow } = await supabase
          .from('academic_terms')
          .select('term_start_date, term_end_date')
          .eq('academic_year', currentTerm.academic_year)
          .eq('term', currentTerm.term)
          .maybeSingle();
        termStart = termRow?.term_start_date ?? null;
        termEnd = termRow?.term_end_date ?? null;
      }
      const todayStr = toDateStr(new Date());

      let rangeStart: string | null;
      let rangeEnd: string;
      if (viewMode === 'month') {
        const [y, m] = monthValue.split('-').map(Number);
        rangeStart = toDateStr(new Date(y, m - 1, 1));
        const monthEnd = toDateStr(new Date(y, m, 0));
        rangeEnd = monthEnd < todayStr ? monthEnd : todayStr; // 還沒發生的日期不算「已出席」
      } else {
        rangeStart = termStart;
        rangeEnd = termEnd && termEnd < todayStr ? termEnd : todayStr; // 學期結束後不再往後累計
      }
      setRangeNote(null);
      if (viewMode === 'term' && !rangeStart && currentTerm) {
        // 【本輪修正】反映事項「讀取出缺勤紀錄失敗：canceling statement due to
        // statement timeout」——上一輪這裡是另外查「這個班級最早一筆出缺勤紀錄」
        // 當下限，但那筆查詢本身仍然是「不限日期、對整張表找最舊一筆」，對於
        // RLS 判斷成本較高的身分（任課教師）一樣可能逼近逾時，而且沒有解決
        // 「主查詢的日期下限本身沒收斂」這個真正的根因。改成不查資料庫，直接
        // 用「學年度＋學期」估出一個合理的開學日下限（見 estimateTermStart），
        // 保證查詢範圍被收斂在「這學期」等級，不會再退化成整張表。
        rangeStart = estimateTermStart(currentTerm.academic_year, currentTerm.term);
        setRangeNote(
          `學年學期設定裡尚未填寫本學期開學日，暫以「${currentTerm.academic_year} ${currentTerm.term}」推算的開學日（約 ${rangeStart}）起算，實際節數可能略有誤差，請開發人員盡快到「學年學期設定」頁補上正確的開學日。`
        );
      }

      const { data: classRow } = await supabase.from('classes').select('grade_level').eq('id', classId).maybeSingle();
      const department = departmentForGrade(classRow?.grade_level ?? '');
      // period_config 每個星期幾的堂數是固定的（不會因為日期不同而變），所以只需要各查一次
      // （最多6個星期幾），不用每一天都各查一次，避免整學期範圍要查上百次。
      const periodCountsByWeekday: Record<number, number> = {};
      await Promise.all(
        [1, 2, 3, 4, 5, 6].map(async (wd) => {
          periodCountsByWeekday[wd] = await getEffectivePeriodCount(wd, department, classId);
        })
      );

      const scheduledDates: { dateStr: string; period_no: number }[] = [];
      const scheduledSet = new Set<string>();
      if (rangeStart) {
        const cursor = new Date(`${rangeStart}T00:00:00`);
        const end = new Date(`${rangeEnd}T00:00:00`);
        while (cursor <= end) {
          const weekday = cursor.getDay() || 7; // 0(週日)->7；period_config 只設定1~6，週日一律視為0節
          const dateStr = toDateStr(cursor);
          const count = periodCountsByWeekday[weekday] ?? 0;
          for (let p = 1; p <= count; p++) {
            scheduledDates.push({ dateStr, period_no: p });
            scheduledSet.add(`${dateStr}|${p}`);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      // 【本輪修正】改用 fetchAttendanceForStudents()：逐學生查詢，避免「一大串
      // 學號 IN + 日期範圍」讓查詢規劃器選到不理想的索引、退化成掃描全校全學期
      // 規模的資料（詳見 lib/attendanceQueries.ts 的說明），這是「已經把日期收斂
      // 在這學期、還是逾時／很慢」的真正根因。
      const { data: attRows, error: attErr } = await fetchAttendanceForStudents(studentNos, rangeStart, rangeEnd);
      if (attErr) {
        setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        setLoading(false);
        return;
      }
      const existingByKey: Record<string, string> = {};
      (attRows ?? []).forEach((r: any) => {
        existingByKey[`${r.student_no}|${r.record_date}|${r.period_no}`] = r.status;
      });

      // 【本輪修正】反映事項「本校是夜校，各部別節次數都不同，應該依照本校各部別
      // 實際設定的節次做顯示與計算；學期累計出席節數遠超過該部別一週最多節次數
      // 乘上週數的理論上限」——前兩輪在這裡加的「把 attendance 表裡實際存在、
      // 但不在 scheduledSet 裡的節次也算進去」，對這個學校是錯的：這些「不在
      // 目前部別節次設定裡」的紀錄，不是節次設定調整前的合理舊資料，而是不該
      // 存在的錯誤資料（例如超過該部別實際節次數的髒資料），加進去計算反而讓
      // 出席節數遠超過理論上限。改回嚴格只依照 scheduledDates（getEffectivePeriodCount
      // 依「班級>部別>全校」period_config 算出來的節次清單）計算——這樣才是
      // 真正「依照本校所設定的各部別節次做顯示與計算」，任何不在這個部別節次
      // 設定範圍內的紀錄都不會被算進統計、也不會出現在下面的明細清單裡。
      const map: Record<string, Record<string, number>> = {};
      rows.forEach((s) => {
        map[s.student_no] = {};
        scheduledDates.forEach(({ dateStr, period_no }) => {
          const status = existingByKey[`${s.student_no}|${dateStr}|${period_no}`] ?? '出席';
          map[s.student_no][status] = (map[s.student_no][status] ?? 0) + 1;
        });
      });
      setSummary(map);
      const exc: Record<string, ExceptionRecord[]> = {};
      (attRows ?? []).forEach((r: any) => {
        if (r.status === '出席' || !(EXCEPTION_STATUSES as readonly string[]).includes(r.status)) return;
        if (!scheduledSet.has(`${r.record_date}|${r.period_no}`)) return; // 不在這個部別的節次設定範圍內，視為錯誤資料，不顯示
        (exc[r.student_no] = exc[r.student_no] ?? []).push({ status: r.status, date: r.record_date, period: r.period_no });
      });
      setExceptions(exc);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, viewMode, monthValue, isAdmin]);

  if (noClass) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>學生出席紀錄查詢</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（本頁僅提供導師與管理員使用）。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 學生出席紀錄</h1>
      <ErrorBanner message={loadError} />

      {isAdmin && classOptions.length > 0 && (
        <select
          value={classId ?? ''}
          onChange={(e) => setClassId(e.target.value)}
          style={{ padding: 8, marginBottom: 12, width: '100%', maxWidth: 320 }}
        >
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" checked={viewMode === 'month'} onChange={() => setViewMode('month')} />
          月報
        </label>
        {viewMode === 'month' && (
          <input type="month" value={monthValue} onChange={(e) => setMonthValue(e.target.value)} style={{ padding: 6 }} />
        )}
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="radio" checked={viewMode === 'term'} onChange={() => setViewMode('term')} />
          學期（累計目前已登錄的紀錄）
        </label>
      </div>

      {rangeNote && <p style={{ fontSize: 12, color: '#A36A2D', marginBottom: 8 }}>{rangeNote}</p>}
      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
              <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
              {STATUS_OPTIONS.map((s) => (
                <th key={s} style={{ textAlign: 'right', padding: 6 }}>
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.student_no} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>{s.seat_no}</td>
                <td style={{ padding: 6 }}>
                  <button
                    onClick={() => setDetailStudent(s)}
                    style={{ background: 'none', border: 'none', padding: 0, color: '#185FA5', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}
                  >
                    {s.name}
                  </button>
                </td>
                {STATUS_OPTIONS.map((opt) => (
                  <td key={opt} style={{ padding: 6, textAlign: 'right' }}>
                    {summary[s.student_no]?.[opt] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={2 + STATUS_OPTIONS.length} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                  這個班級目前沒有在學學生
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {detailStudent && (
        <div
          onClick={() => setDetailStudent(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 8, padding: 20, width: '100%', maxWidth: 480, maxHeight: '80vh', overflowY: 'auto' }}
          >
            <h2 style={{ fontSize: 15, marginBottom: 4 }}>
              {detailStudent.seat_no} 號 {detailStudent.name}　出缺席明細
            </h2>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
              {viewMode === 'month' ? `${monthValue} 月` : '本學期'}（只列出曠課、遲到、病假、事假、公假）
            </p>
            {(exceptions[detailStudent.student_no] ?? []).length === 0 ? (
              <p style={{ fontSize: 13, color: '#999' }}>這段期間沒有任何曠課、遲到、病假、事假、公假紀錄。</p>
            ) : (
              EXCEPTION_STATUSES.map((st) => {
                const list = (exceptions[detailStudent.student_no] ?? []).filter((r) => r.status === st);
                if (list.length === 0) return null;
                return (
                  <div key={st} style={{ marginBottom: 12 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                      {st}　共 {list.length} 節
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                      {list.map((r) => (
                        <li key={`${r.date}|${r.period}`}>
                          {formatRecordDate(r.date)}　{r.date}　第 {r.period} 節
                          {classId && (
                            // 【本輪修正】反映事項「點修正以後是另開新分頁或對話框，這樣修正完
                            // 關閉還能繼續做同一個人其他筆的修正」——原本用一般連結會在原分頁
                            // 跳走，這個明細視窗、班級/日期的查詢條件都會不見，修完一筆要重新
                            // 整個查詢流程才能回來改下一筆。加上 target="_blank" 改成開新分頁，
                            // 原本這個分頁（連同明細視窗）完全不受影響，改完關掉新分頁就能繼續
                            // 點下一筆的「修正」。
                            <a
                              href={`/attendance/weekly?classId=${classId}&date=${r.date}&student=${detailStudent.student_no}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ marginLeft: 8, fontSize: 12, color: '#185FA5' }}
                            >
                              修正 ↗
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
            <button onClick={() => setDetailStudent(null)} style={{ padding: '6px 16px', marginTop: 4 }}>
              關閉
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

export default function AttendanceReportPage() {
  return (
    <Suspense fallback={null}>
      <AttendanceReportPageInner />
    </Suspense>
  );
}
