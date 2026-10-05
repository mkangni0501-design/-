'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { getSiteContentMap } from '@/lib/siteContent';
import { resolveCurrentTerm, estimateTermStart } from '@/lib/academicTerm';
import { fetchAttendanceForStudents } from '@/lib/attendanceQueries';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';

type ClassSubjectOption = { class_id: string; subject: string; label: string; periodNos: number[]; slots: { weekday: number; period_no: number }[] };
type StudentRow = { student_no: string; seat_no: number; name: string };

// 在台灣（UTC+8）午夜到早上8點之間，UTC 日期會是前一天，導致「星期一」卻顯示成上週日的日期。
// 改用本地時間的年/月/日組字串，才會跟畫面上的「星期幾」對得起來——跟
// attendance/weekly/page.tsx 的 toDateStr() 是同一套算法。
function toLocalDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;
const EXCEPTION_STATUSES = ['曠課', '遲到', '病假', '事假', '公假'] as const;
type ExceptionRecord = { status: string; date: string; period: number };
const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
function formatRecordDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}（週${WEEKDAY_LABEL[d.getDay()]}）`;
}

// 任課教師出席查詢：只能看到自己授課班級、自己教的那個科目所對應節次的出缺勤狀況，
// 不會看到同班其他科目/節次的紀錄（跟導師「學生出缺席登錄（一週）」頁面不同，那是全班全節次）。
export default function SubjectAttendanceViewPage() {
  const isMobile = useIsMobile();
  const [siteContent, setSiteContent] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<ClassSubjectOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [summary, setSummary] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noAssignment, setNoAssignment] = useState(false);
  const [termDateRange, setTermDateRange] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [exceptions, setExceptions] = useState<Record<string, ExceptionRecord[]>>({});
  const [detailStudent, setDetailStudent] = useState<StudentRow | null>(null);

  useEffect(() => {
    getSiteContentMap().then(setSiteContent);
  }, []);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).maybeSingle();
      if (!teacherRow) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }

      // 【2026-08 修正】原本沒有依學年學期篩選，會把過去學年度的任課紀錄也混進來，
      // 選單裡出現早已結束的班級/科目。改成只抓目前生效學年學期的任課紀錄。
      //
      // 【本輪修正】反映事項「統計的總節數還是錯誤，國文一星期不只4節卻只算出4節、
      // 班會一星期一節卻有20節事假，請用科目確認從開學至今的出缺席公式」——
      // 根因：class_schedule 只記錄「目前這個學年學期」的課表，同一個
      // （星期幾,第幾節）在不同學期代表不同科目是正常的；但下面查 attendance
      // 紀錄時完全沒有限制日期範圍，等於把這個學生「從入學到現在、不管哪個
      // 學年學期」的全部出缺勤都撈出來，拿去跟「只有這學期」的課表比對——換學期
      // 之後課表通常會變動，上學期同一個節次可能是別科，於是被誤判成/誤判不是
      // 這學期這堂課的紀錄，兩種方向的誤差都有可能發生（該算的沒算到、不該算的
      // 算進去了），這才是即使已經改成比對「星期幾+第幾節」、數字還是兜不起來的
      // 真正原因。改成額外查 academic_terms 拿到「這學期開學日」，出缺勤紀錄限制
      // 在「開學日 ~ 今天」這個範圍內，不再撈到其他學期的舊資料。
      const currentTerm = await resolveCurrentTerm();
      if (currentTerm) {
        const { data: termRow } = await supabase
          .from('academic_terms')
          .select('term_start_date, term_end_date')
          .eq('academic_year', currentTerm.academic_year)
          .eq('term', currentTerm.term)
          .maybeSingle();
        const todayStr = new Date().toISOString().slice(0, 10);
        // 【本輪修正】反映事項「任課班級出席查詢，所有項目都無統計，一樣出現
        // 『canceling statement due to statement timeout』」——根因：這裡原本
        // 「開學日還沒填」時 termDateRange.start 直接是 null，下面查 attendance
        // 完全不會加日期下限，等於對整張表（全校、系統啟用以來所有資料）下查詢；
        // 任課教師本身不符合 RLS 裡能被快速判斷的身分（系統管理員／訓導部門／
        // 導師本班），要靠 enrollments/class_schedule 的 EXISTS 子查詢逐列判斷，
        // 候選列數一旦沒有日期範圍收斂到整張表等級，就足以逾時——這才是「所有
        // 項目都查不到統計」的根因，不是這個科目真的沒有資料。改成開學日沒填時，
        // 用「學年度＋學期」估出一個合理的開學日下限（estimateTermStart），
        // 不再讓查詢範圍退化成不限制。
        //
        // 【本輪再修正】反映事項「學期日期到了以後不會自動停止計算，目前仍在
        // 進行統計中」——這裡原本不管 term_end_date、一律用「今天」當統計上限，
        // 學期結束日期過了以後還是會繼續往「今天」累計，不會在學期結束那天停住。
        // 改成比照 attendance/report 頁同樣的規則：有填 term_end_date、而且已經
        // 過了，就固定用 term_end_date 當上限，不再往後累計；還沒到期末日，才用
        // 今天當上限。
        const start = termRow?.term_start_date ?? estimateTermStart(currentTerm.academic_year, currentTerm.term);
        const termEnd = termRow?.term_end_date ?? null;
        const end = termEnd && termEnd < todayStr ? termEnd : todayStr;
        setTermDateRange({ start, end });
      }
      let scheduleQuery = supabase
        .from('class_schedule')
        .select('class_id, subject, weekday, period_no, classes(grade_level, class_name)')
        .eq('teacher_id', teacherRow.id);
      if (currentTerm) scheduleQuery = scheduleQuery.eq('academic_year', currentTerm.academic_year).eq('term', currentTerm.term);
      const { data: scheduleRows, error } = await scheduleQuery;
      if (error) {
        setLoadError('讀取任課資料失敗：' + error.message);
        setLoading(false);
        return;
      }
      if (!scheduleRows || scheduleRows.length === 0) {
        setNoAssignment(true);
        setLoading(false);
        return;
      }

      const grouped = new Map<string, ClassSubjectOption>();
      scheduleRows.forEach((r: any) => {
        const key = `${r.class_id}|${r.subject}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            class_id: r.class_id,
            subject: r.subject,
            label: `${r.classes?.grade_level ?? ''}${r.classes?.class_name ?? ''}－${r.subject}`,
            periodNos: [],
            slots: [],
          });
        }
        // 【本輪修正】反映事項「任課教師無法看到自己授課的班級學生出缺席狀況，
        // 出現 invalid input syntax for type integer: "null""：根因是
        // sql/14school_timetable_split.sql 把 class_schedule.period_no 放寬成可以是
        // null（「任課教師設定」頁只設定誰教哪班哪科、還沒排入實際星期/節次時，
        // period_no 就會是 null），這裡原本沒有濾掉，null 混進 periodNos 之後，
        // 下面 .in('period_no', opt.periodNos) 就會把 null 當成整數值送進查詢，
        // 觸發這個 PostgREST 錯誤。period_no 是 null 代表這筆任課紀錄根本還沒有
        // 對應到任何實際節次，本來就不可能有出缺勤資料（attendance.period_no 是
        // not null），直接跳過、不算進 periodNos 即可。
        //
        // 【本輪修正，另一個更嚴重的問題】反映事項「【任課班級出席查詢】出席的
        // 結束看起來異常，一星期才一堂課，卻累計出26筆、比例明顯不對」——根因：
        // period_no 只代表「一天裡的第幾節」（例如「第3節」），同一個 period_no
        // 在不同星期幾會是完全不同的課（星期一第3節可能是數學、星期三第3節可能
        // 是這裡的作文）。下面查 attendance 原本只用 period_no 篩選、完全沒篩選
        // 星期幾，等於把「所有星期在第3節上課的紀錄」都算進來，不管是不是真的
        // 「作文」這堂課——這就是為什麼「一星期一堂課」的科目，總筆數跟其他状态
        // 分佈會遠超過實際上課次數。這裡額外記錄每個 (星期幾, 第幾節) 的正確
        // 組合（slots），下面查完 attendance 之後改用「日期換算出的星期幾」+
        // period_no 兩者都對得上，才算是這堂課的紀錄。
        if (r.period_no == null || r.weekday == null) return;
        const entry = grouped.get(key)!;
        if (!entry.periodNos.includes(r.period_no)) entry.periodNos.push(r.period_no);
        if (!entry.slots.some((s) => s.weekday === r.weekday && s.period_no === r.period_no)) {
          entry.slots.push({ weekday: r.weekday, period_no: r.period_no });
        }
      });
      const opts = Array.from(grouped.values());
      setOptions(opts);
      if (opts.length > 0) setSelectedKey(`${opts[0].class_id}|${opts[0].subject}`);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selectedKey) return;
    const opt = options.find((o) => `${o.class_id}|${o.subject}` === selectedKey);
    if (!opt) return;
    (async () => {
      setLoading(true);
      setLoadError(null);

      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('seat_no, student_no, students(name)')
        .eq('class_id', opt.class_id)
        .eq('is_current', true)
        .order('seat_no');
      if (enrollErr) {
        setLoadError('讀取學生名單失敗：' + enrollErr.message);
        setLoading(false);
        return;
      }
      // 【本輪新增】反映事項「已登記為休學、轉學、退學的同學，仍出現在導師與任課
      // 老師的點名冊、成績輸入等頁面」——這頁（任課班級出席查詢）原本完全沒有套用
      // getHiddenStudentNos()，attendance/weekly、ScoresEntryTab.tsx 等其他頁面
      // 很早就有這層過濾，這頁當時漏加了，任課老師查自己教的班級，休學/轉學/退學
      // 的學生還是會顯示在名單裡。這頁本來就只給任課教師自己看自己教的節次，沒有
      // 管理員視角這回事，所以不用像其他頁面那樣額外判斷 isAdmin，一律套用過濾。
      const hiddenNos = await getHiddenStudentNos((enrollRows ?? []).map((r: any) => r.student_no));
      const rows: StudentRow[] = (enrollRows ?? [])
        .filter((r: any) => !hiddenNos.has(r.student_no))
        .map((r: any) => ({
          student_no: r.student_no,
          seat_no: r.seat_no,
          name: r.students?.name ?? r.student_no,
        }));
      setStudents(rows);
      const studentNos = rows.map((r) => r.student_no);

      // 【本輪修正】反映事項「開學日已經填了（5/11～9/30），還是逾時／開啟很慢」
      // ——原本是一次對 attendance 下「一大串學號 IN + period_no IN + 日期範圍」，
      // 這種組合查詢規劃器不一定會用上 (student_no, record_date, period_no) 這組
      // 複合索引，選錯索引就會退化成掃描全校整學期規模的資料，不是只有這個班級
      // 這堂課（詳見 lib/attendanceQueries.ts 的說明）。改用
      // fetchAttendanceForStudents()：逐學生查詢（每次都是單一學號相等條件，
      // 精準命中索引），period_no 篩選則保留在下面「日期換算星期幾 + period_no
      // 都要對到 opt.slots」那段就好，不用在 SQL 這層先篩一次。
      //
      // 限制在「這學期開學日 ~ 今天」的範圍內，理由見上面課表查詢那段的說明。
      // 只有在完全找不到目前生效的學年學期（currentTerm 是 null，代表
      // academic_terms 整張表都還沒有任何資料）時，termDateRange.start 才會
      // 維持 null——這種情況下確實沒有任何依據可以估出合理範圍，只能維持不限制。
      const { data: attRows, error: attErr } = await fetchAttendanceForStudents(
        studentNos,
        termDateRange.start,
        termDateRange.end ?? toLocalDateStr(new Date())
      );
      if (attErr) {
        setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        setLoading(false);
        return;
      }
      const map: Record<string, Record<string, number>> = {};
      // 現有紀錄先整理成 { "student_no|date|period_no": status } 方便查找。
      const existingByKey: Record<string, string> = {};
      (attRows ?? []).forEach((r: any) => {
        // record_date 是 'YYYY-MM-DD' 字串，直接 new Date(...) 在某些瀏覽器時區下
        // 會被當成 UTC 午夜、換算回本地時間可能跳到前一天，算出來的星期幾就錯了；
        // 這裡補上 'T00:00:00' 讓它明確用本地時區解析，跟其他頁面算星期幾的方式一致。
        const d = new Date(`${r.record_date}T00:00:00`);
        const weekday = d.getDay() || 7; // 0(週日)->7，跟 weekly/mobile 兩頁算法一致
        // 一定要「星期幾」跟「第幾節」兩者都對到 opt.slots 裡同一組，才算是這堂課
        // 的紀錄——只比對其中一項都不夠精準（同一星期幾裡，別節可能是別的課；
        // 同一節次裡，別的星期幾也可能是別的課）。
        const isThisClass = opt.slots.some((s) => s.weekday === weekday && s.period_no === r.period_no);
        if (!isThisClass) return;
        existingByKey[`${r.student_no}|${r.record_date}|${r.period_no}`] = r.status;
      });

      // 【本輪新增】反映事項「這頁也要點學生名字看到他哪些天不在」——把這堂課
      // 範圍內、非出席的紀錄依學生整理起來，點姓名時列出日期＋第幾節＋狀態。
      const exc: Record<string, ExceptionRecord[]> = {};
      (attRows ?? []).forEach((r: any) => {
        if (!(EXCEPTION_STATUSES as readonly string[]).includes(r.status)) return;
        const d = new Date(`${r.record_date}T00:00:00`);
        const weekday = d.getDay() || 7;
        const isThisClass = opt.slots.some((s) => s.weekday === weekday && s.period_no === r.period_no);
        if (!isThisClass) return;
        (exc[r.student_no] = exc[r.student_no] ?? []).push({ status: r.status, date: r.record_date, period: r.period_no });
      });
      setExceptions(exc);

      // 【本輪修正】反映事項「所有人的出席、曠課、遲到、病假、事假、公假總和節數
      // 應該要一樣，但是並沒有」——根因：attendance 這張表只有老師「實際點過」的
      // 節次才會有一筆紀錄，畫面上顯示的預設「出席」只是前端沒存檔的預設值，不是
      // 真的寫進資料庫的一筆——如果某節課老師剛好沒點開那一格、直接跳過（畫面上
      // 看起來還是出席，但資料庫根本沒有那一列），這裡原本用「資料庫實際有幾列」
      // 去加總，這位學生那一節就完全不會被算進任何統計，導致每個人的總筆數
      // 不一樣多。改成不是去數「資料庫裡有幾列」，是先把這堂課「從開學到今天」
      // 應該要上的每一次課（依 opt.slots 的星期幾＋第幾節，逐日推算實際日期）
      // 都列出來，每一次×每個學生都算一格，資料庫有紀錄就用那筆的狀態，沒有
      // 紀錄就當作「出席」——這樣不管老師有沒有每次都手動存檔，全班/同一科目
      // 所有學生的總節數保證一樣多（都等於這學期到今天為止實際上了幾次課）。
      const scheduledDates: { dateStr: string; period_no: number }[] = [];
      if (termDateRange.start && termDateRange.end) {
        const cursor = new Date(`${termDateRange.start}T00:00:00`);
        const end = new Date(`${termDateRange.end}T00:00:00`);
        while (cursor <= end) {
          const weekday = cursor.getDay() || 7;
          const dateStr = toLocalDateStr(cursor);
          opt.slots.forEach((s) => {
            if (s.weekday === weekday) scheduledDates.push({ dateStr, period_no: s.period_no });
          });
          cursor.setDate(cursor.getDate() + 1);
        }
      }
      rows.forEach((s) => {
        map[s.student_no] = {};
        scheduledDates.forEach(({ dateStr, period_no }) => {
          const status = existingByKey[`${s.student_no}|${dateStr}|${period_no}`] ?? '出席';
          map[s.student_no][status] = (map[s.student_no][status] ?? 0) + 1;
        });
      });
      setSummary(map);
      setLoading(false);
    })();
  }, [selectedKey, options, termDateRange]);

  if (noAssignment) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>任課班級出席查詢</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有指派的任課班級/科目。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>任課班級出席查詢</h1>
      {isMobile ? (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>說明</summary>
          <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            {siteContent['page_hint.attendance_subject_view'] ?? '只會顯示您自己授課節次的出缺勤累計次數（累計至今），不包含同班其他科目/節次的紀錄。'}
          </p>
        </details>
      ) : (
        <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
          {siteContent['page_hint.attendance_subject_view'] ?? '只會顯示您自己授課節次的出缺勤累計次數（累計至今），不包含同班其他科目/節次的紀錄。'}
        </p>
      )}
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {options.length > 1 && (
        <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} style={{ padding: 8, marginBottom: 16, width: '100%', maxWidth: 320 }}>
          {options.map((o) => (
            <option key={`${o.class_id}|${o.subject}`} value={`${o.class_id}|${o.subject}`}>
              {o.label}
            </option>
          ))}
        </select>
      )}

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
              這學期到今天為止、這堂課的紀錄（只列出曠課、遲到、病假、事假、公假）
            </p>
            {(exceptions[detailStudent.student_no] ?? []).length === 0 ? (
              <p style={{ fontSize: 13, color: '#999' }}>這段期間這堂課沒有任何曠課、遲到、病假、事假、公假紀錄。</p>
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
