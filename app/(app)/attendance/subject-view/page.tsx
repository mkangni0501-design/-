'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { getSiteContentMap } from '@/lib/siteContent';
import { resolveCurrentTerm } from '@/lib/academicTerm';

type ClassSubjectOption = { class_id: string; subject: string; label: string; periodNos: number[]; slots: { weekday: number; period_no: number }[] };
type StudentRow = { student_no: string; seat_no: number; name: string };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;

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
          .select('term_start_date')
          .eq('academic_year', currentTerm.academic_year)
          .eq('term', currentTerm.term)
          .maybeSingle();
        const todayStr = new Date().toISOString().slice(0, 10);
        setTermDateRange({ start: termRow?.term_start_date ?? null, end: todayStr });
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
      const rows: StudentRow[] = (enrollRows ?? []).map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: r.students?.name ?? r.student_no,
      }));
      setStudents(rows);
      const studentNos = rows.map((r) => r.student_no);

      // 只查詢這個科目對應節次的出缺勤——RLS 本來就只會回傳任課教師自己教的節次，
      // 這裡再加上 period_no 篩選，是為了同一班若教超過一科時，不同科目的節次不會混在一起。
      // 【本輪修正】period_no 篩選只能先縮小 DB 查詢範圍（減少要抓的列數），
      // 不能只靠這個判斷「是不是這堂課的紀錄」——同一個 period_no 在不同星期幾
      // 可能是別科老師的課，所以多抓 record_date 回來，下面再用「日期換算出的
      // 星期幾」+ period_no 兩者都符合 opt.slots 裡的組合，才算數。
      let attQuery = supabase
        .from('attendance')
        .select('student_no, status, record_date, period_no')
        .in('student_no', studentNos.length > 0 ? studentNos : ['__none__'])
        .in('period_no', opt.periodNos.length > 0 ? opt.periodNos : [-1]);
      // 【本輪修正】限制在「這學期開學日 ~ 今天」的範圍內，理由見上面課表查詢
      // 那段的說明——不限制日期的話，會把其他學年學期、課表配置完全不同時期的
      // 出缺勤紀錄也混進來比對，多算或少算都有可能。開學日如果還沒在「學年學期
      // 設定」頁填，termDateRange.start 會是 null，這種情況沒辦法安全限縮日期，
      // 寧可維持「不限制」也不要用錯的日期範圍篩掉真正該算的紀錄。
      if (termDateRange.start) attQuery = attQuery.gte('record_date', termDateRange.start);
      if (termDateRange.end) attQuery = attQuery.lte('record_date', termDateRange.end);
      const { data: attRows, error: attErr } = await attQuery;
      if (attErr) {
        setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        setLoading(false);
        return;
      }
      const map: Record<string, Record<string, number>> = {};
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
        map[r.student_no] = map[r.student_no] ?? {};
        map[r.student_no][r.status] = (map[r.student_no][r.status] ?? 0) + 1;
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
                <td style={{ padding: 6 }}>{s.name}</td>
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
    </main>
  );
}
