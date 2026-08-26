'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getSiteContentMap } from '@/lib/siteContent';
import { departmentForGrade } from '@/lib/gradeMapping';
import { getEffectivePeriodCount } from '@/lib/periodConfig';
import { resolveCurrentTerm } from '@/lib/academicTerm';

// 【2026-08-11 修正】根因：原本「導師/管理員決定當天可選節次」的 useEffect 只要
// isHomeroom 或 isAdmin 成立就會整個覆蓋 periods 狀態，換成 period_config 算出來的
// 一份通用清單（全部標成「導師登錄」）。這代表只要一位老師「同時是導師」，他自己
// 任課的節次（從 class_schedule 撈出來的）就會被這份通用清單整批蓋掉、完全消失，
// 導師沒辦法在這頁登錄自己教的課；而單純的任課教師（不是導師）雖然看得到自己的
// 課，但 classId 只會鎖死在「當天課表第一筆」的班級，如果同一天教兩個不同班級，
// 點第二個節次時 classId 不會跟著換，會顯示錯的班級名單——等於任課教師實質上也
// 沒辦法正確登錄。
//
// 修正：兩份清單改成合併顯示、不互相覆蓋，並且每個節次按鈕都各自帶自己的
// classId（不再共用一個全域 classId），選哪個節次就用哪個節次自己的班級：
//   - 「自己今天有授課的節次」（來自 class_schedule）：第一組顏色。
//   - 如果自己是導師：「導師班今天全部節次」（不論是不是自己教的）：第二組顏色，
//     供導師查詢/編輯整班的出缺勤。跟第一組重複的節次（同一節、同一個班就是自己
//     導師班）不重複顯示。
// 管理員視角維持原邏輯不變（自己選班級 → 依 period_config 產生節次清單）。

type PeriodSource = 'teach' | 'homeroom' | 'admin';
type PeriodEntry = {
  key: string;
  period_no: number;
  subject: string;
  teacherName: string;
  classId: string;
  classLabel?: string;
  source: PeriodSource;
};
type StudentRow = { student_no: string; seat_no: number; name: string };
type ClassOption = { id: string; label: string; grade_level: string };

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;
// 【2026-08-26 依回饋修正】同「一週出缺勤」頁的問題：這裡原本是寫死的常數，跟訓導處
// 在「出缺席示警門檻設定」頁可調整的 backfill_overdue_days 沒有連動，改成從資料庫讀取，
// 這個常數只當作讀不到設定時的備援值。
const DEFAULT_BACKDATE_GRACE_DAYS = 7;

const SOURCE_COLOR: Record<PeriodSource, { bg: string; text: string }> = {
  teach: { bg: '#2C2C2A', text: '#fff' }, // 自己任課節次
  homeroom: { bg: '#3F6B4A', text: '#fff' }, // 導師班全部節次
  admin: { bg: '#2C2C2A', text: '#fff' },
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function MobileAttendancePage() {
  const [date, setDate] = useState(todayStr);
  const [siteContent, setSiteContent] = useState<Record<string, string>>({});
  const [me, setMe] = useState<{ id: string; name: string; role: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isHomeroom, setIsHomeroom] = useState(false);
  const [homeroomTeacherId, setHomeroomTeacherId] = useState<string | null>(null);
  const [homeroomClassId, setHomeroomClassId] = useState<string | null>(null);
  const [homeroomClassLabel, setHomeroomClassLabel] = useState<string>('');
  const [teacherRowId, setTeacherRowId] = useState<string | null>(null);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [adminClassId, setAdminClassId] = useState<string | null>(null); // 只有管理員視角用
  const [periods, setPeriods] = useState<PeriodEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState<number | null>(null);
  // 【2026-08-26 新增】見上面 DEFAULT_BACKDATE_GRACE_DAYS 的說明。
  const [backdateGraceDays, setBackdateGraceDays] = useState<number>(DEFAULT_BACKDATE_GRACE_DAYS);
  const [notifyQueue, setNotifyQueue] = useState<{ student_no: string; name: string; count: number }[]>([]);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const notifyPrompt = notifyQueue[0] ?? null;

  const selectedEntry = periods.find((p) => p.key === selectedKey) ?? null;
  // 這個節次是不是「自己導師班的節次」（不論是導師班全部節次的 source='homeroom'，
  // 還是剛好自己也教到自己導師班那個 source='teach'）——用來判斷鎖定/補登範圍是否
  // 適用導師的放寬規則，而不是只要「我是某班導師」就對任何節次都放寬。
  const isEditingOwnHomeroom = isHomeroom && !!selectedEntry && selectedEntry.classId === homeroomClassId;

  useEffect(() => {
    getSiteContentMap().then(setSiteContent);
  }, []);

  // 身分載入：管理員(S/A/B)可選任一班級；一般老師先確定自己是不是導師、teacherRow id 是什麼
  // （這兩件事不受「選哪一天」影響，只需要抓一次）。
  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      setMe(appUser);
      // 改用 isAdminInCurrentView()：管理員帳號切到「教師視角」時，這裡也要跟著變成
      // 教師視角的邏輯（只能操作自己導師班/任課班），不然「切換身分」對這頁形同虛設。
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        const { data: allClasses } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        const options: ClassOption[] = (allClasses ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
          grade_level: c.grade_level,
        }));
        setClassOptions(options);
        if (options.length > 0) setAdminClassId(options[0].id);
        return;
      }

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).single();
      if (!teacherRow) return;
      setTeacherRowId(teacherRow.id);

      // 【2026-08 修正】根因：查「自己導的班級」原本沒有依學年度篩選，系統累積超過
      // 一學年資料後，同一位老師可能在不同學年都當過導師，`.maybeSingle()` 一查到
      // 兩筆（去年+今年）就會直接出錯、整段判斷失敗。改成先取得目前生效學年度，
      // 限定在這個學年度之內查詢。
      const currentTerm = await resolveCurrentTerm();
      const currentYear = currentTerm?.academic_year;

      let homeroomQuery = supabase
        .from('classes')
        .select('id, grade_level, class_name')
        .eq('homeroom_teacher_id', teacherRow.id);
      if (currentYear != null) homeroomQuery = homeroomQuery.eq('academic_year', currentYear);
      const { data: homeroomClass } = await homeroomQuery.maybeSingle();
      let resolved = homeroomClass ?? null;

      // 保險機制：用 teacher_id 找不到自己導的班級時，改用姓名比對一次
      // （避免同一位老師被系統記成兩筆不同的 teachers 資料，導致完全找不到自己導的班）。
      if (!resolved) {
        let allHomeroomQuery = supabase
          .from('classes')
          .select('id, grade_level, class_name, homeroom_teacher_id')
          .not('homeroom_teacher_id', 'is', null);
        if (currentYear != null) allHomeroomQuery = allHomeroomQuery.eq('academic_year', currentYear);
        const { data: allHomeroomClasses } = await allHomeroomQuery;
        const teacherIds = Array.from(new Set((allHomeroomClasses ?? []).map((c: any) => c.homeroom_teacher_id)));
        if (teacherIds.length > 0) {
          const { data: teacherNameRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          const nameById = new Map((teacherNameRows ?? []).map((t: any) => [t.id, t.name]));
          const match = (allHomeroomClasses ?? []).find((c: any) => nameById.get(c.homeroom_teacher_id) === appUser.name);
          if (match) resolved = match;
        }
      }

      if (resolved) {
        setHomeroomClassId(resolved.id);
        setHomeroomClassLabel(`${resolved.grade_level}${resolved.class_name}`);
        setIsHomeroom(true);
        setHomeroomTeacherId(teacherRow.id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 非管理員：依「選定的日期」重新算出當天可選節次清單（自己任課的節次 + 如果是
  // 導師，加上導師班當天全部節次）。日期變動（例如補登前幾天的紀錄）時要重新算，
  // 因為星期幾、期別節次數都可能不一樣。
  useEffect(() => {
    if (isAdmin) return;
    if (!teacherRowId) return;
    (async () => {
      const weekday = new Date(date).getDay() || 7;
      const currentTerm = await resolveCurrentTerm();

      let scheduleQuery = supabase
        .from('class_schedule')
        .select('period_no, subject, class_id')
        .eq('teacher_id', teacherRowId)
        .eq('weekday', weekday);
      if (currentTerm) scheduleQuery = scheduleQuery.eq('academic_year', currentTerm.academic_year).eq('term', currentTerm.term);
      const { data: teachRows } = await scheduleQuery;

      // 任課節次可能橫跨不同班級，先把用得到的班級名稱一次查回來，節次按鈕上才看得出來是哪個班。
      const classIds = Array.from(new Set((teachRows ?? []).map((r: any) => r.class_id)));
      const classLabelById = new Map<string, string>();
      if (homeroomClassId) classLabelById.set(homeroomClassId, homeroomClassLabel);
      const otherClassIds = classIds.filter((id) => id !== homeroomClassId);
      if (otherClassIds.length > 0) {
        const { data: classRows } = await supabase.from('classes').select('id, grade_level, class_name').in('id', otherClassIds);
        (classRows ?? []).forEach((c: any) => classLabelById.set(c.id, `${c.grade_level}${c.class_name}`));
      }

      const teachEntries: PeriodEntry[] = (teachRows ?? [])
        .slice()
        .sort((a: any, b: any) => a.period_no - b.period_no)
        .map((r: any) => ({
          key: `teach-${r.period_no}-${r.class_id}`,
          period_no: r.period_no,
          subject: r.subject,
          teacherName: me?.name ?? '',
          classId: r.class_id,
          classLabel: classLabelById.get(r.class_id),
          source: 'teach' as const,
        }));

      let homeroomEntries: PeriodEntry[] = [];
      if (homeroomClassId) {
        const { data: homeroomClassRow } = await supabase.from('classes').select('grade_level').eq('id', homeroomClassId).maybeSingle();
        const dept = departmentForGrade(homeroomClassRow?.grade_level ?? '');
        const count = await getEffectivePeriodCount(weekday, dept, homeroomClassId);

        let homeroomScheduleQuery = supabase
          .from('class_schedule')
          .select('period_no, subject, teacher_id')
          .eq('class_id', homeroomClassId)
          .eq('weekday', weekday);
        if (currentTerm) homeroomScheduleQuery = homeroomScheduleQuery.eq('academic_year', currentTerm.academic_year).eq('term', currentTerm.term);
        const { data: homeroomScheduleRows } = await homeroomScheduleQuery;

        const teacherIds = Array.from(new Set((homeroomScheduleRows ?? []).map((r: any) => r.teacher_id)));
        const teacherNameById = new Map<string, string>();
        if (teacherIds.length > 0) {
          const { data: teacherNameRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          (teacherNameRows ?? []).forEach((t: any) => teacherNameById.set(t.id, t.name));
        }

        homeroomEntries = Array.from({ length: count }, (_, i) => i + 1)
          // 跟「自己任課節次」重複的（同一節、同一個班本來就是自己導師班）不重複顯示，
          // 那筆已經在 teachEntries 裡了。
          .filter((periodNo) => !teachEntries.some((e) => e.period_no === periodNo && e.classId === homeroomClassId))
          .map((periodNo) => {
            const match = (homeroomScheduleRows ?? []).find((r: any) => r.period_no === periodNo);
            return {
              key: `home-${periodNo}`,
              period_no: periodNo,
              subject: match ? match.subject : '（未排課）',
              teacherName: match ? teacherNameById.get(match.teacher_id) ?? '' : '',
              classId: homeroomClassId as string,
              classLabel: homeroomClassLabel,
              source: 'homeroom' as const,
            };
          });
      }

      const merged = [...teachEntries, ...homeroomEntries];
      setPeriods(merged);
      setSelectedKey((prev) => (prev && merged.some((p) => p.key === prev) ? prev : merged[0]?.key ?? null));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, teacherRowId, homeroomClassId, homeroomClassLabel, date]);

  // 管理員：依 period_config 決定當天可選的節次清單
  useEffect(() => {
    if (!isAdmin || !adminClassId) return;
    (async () => {
      const opt = classOptions.find((c) => c.id === adminClassId);
      let gradeLevel = opt?.grade_level;
      if (!gradeLevel) {
        const { data: clsRow } = await supabase.from('classes').select('grade_level').eq('id', adminClassId).maybeSingle();
        gradeLevel = clsRow?.grade_level;
      }
      const dept = departmentForGrade(gradeLevel ?? '');
      const weekday = new Date(date).getDay() || 7;
      const count = await getEffectivePeriodCount(weekday, dept, adminClassId);
      const list: PeriodEntry[] = Array.from({ length: count }).map((_, i) => ({
        key: `admin-${i + 1}`,
        period_no: i + 1,
        subject: '管理員登錄',
        teacherName: me?.name ?? '',
        classId: adminClassId,
        source: 'admin' as const,
      }));
      setPeriods(list);
      setSelectedKey((prev) => (prev && list.some((p) => p.key === prev) ? prev : list[0]?.key ?? null));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, adminClassId, date, classOptions]);

  // 載入該班學生名單 + 該節次已有的出缺勤紀錄 + 鎖定狀態
  useEffect(() => {
    if (!selectedEntry) return;
    const targetClassId = selectedEntry.classId;
    const periodNo = selectedEntry.period_no;
    (async () => {
      // 注意：這裡刻意不用 students(...) 這種自動關聯embed查詢——在這個資料庫上這類查詢會不穩定、
      // 整批失敗又不一定會回報明確錯誤，導致學生名單完全出不來。改成分開查、用 Map 手動兜資料。
      //
      // 【2026-08 修正】原本沒有加 is_current 篩選：學生轉班/升級後，舊的 enrollments
      // 那筆紀錄（is_current=false）仍然掛在原本的 class_id 底下，會讓已經離開這個班的
      // 學生繼續出現在每日出缺勤名單裡。改成只抓 is_current=true，跟其他頁面
      // （任課班級出席查詢、班級帳號設定…）用同一套「目前現行班級」判斷方式一致。
      const { data: enrollRows } = await supabase
        .from('enrollments')
        .select('seat_no, student_no')
        .eq('class_id', targetClassId)
        .eq('is_current', true)
        .order('seat_no');

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

      const { data: existing } = await supabase
        .from('attendance')
        .select('student_no, status')
        .eq('record_date', date)
        .eq('period_no', periodNo)
        .in('student_no', rows.map((r) => r.student_no));

      const map: Record<string, string> = {};
      rows.forEach((r) => (map[r.student_no] = '出席'));
      (existing ?? []).forEach((e: any) => (map[e.student_no] = e.status));
      setStatusMap(map);

      // 是否已鎖定：改成呼叫 submission_window_locked()，跟其他頁面一致
      // （班級 > 部別 > 全校 三層 fallback，且「手動鎖定」或「開放結束時間已過」任一成立即算鎖定）。
      const currentTermInfo = await resolveCurrentTerm();
      const ownsThisAsHomeroom = isHomeroom && targetClassId === homeroomClassId;
      if (currentTermInfo) {
        const { data: isLocked } = await supabase.rpc('submission_window_locked', {
          p_class_id: targetClassId,
          p_academic_year: currentTermInfo.academic_year,
          p_term: currentTermInfo.term,
          p_data_type: '出缺勤',
        });
        setLocked(!!isLocked && !ownsThisAsHomeroom && !isAdmin);
      } else {
        setLocked(false);
      }
    })();
  }, [selectedEntry?.classId, selectedEntry?.period_no, date, isHomeroom, homeroomClassId, isAdmin]);

  function daysAgo(dateStr: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr);
    return Math.round((today.getTime() - d.getTime()) / 86400000);
  }

  // 導師補登超過1週的日期：改請到「一週出缺勤」頁對個別紀錄送出修正申請，這裡先擋下直接儲存。
  // 只有在編輯「自己導師班的節次」時才適用導師的放寬規則；編輯自己任課、但不是自己導師班的
  // 節次時，仍然照一般任課教師的規則走。
  const pastGraceWindow = isEditingOwnHomeroom && !isAdmin && daysAgo(date) > backdateGraceDays;

  function setStatus(studentNo: string, status: string) {
    setStatusMap((prev) => ({ ...prev, [studentNo]: status }));
  }

  useEffect(() => {
    (async () => {
      // 【2026-08-26 修正】一併讀 backfill_overdue_days，理由同「一週出缺勤」頁。
      const { data } = await supabase
        .from('attendance_alert_settings')
        .select('threshold_periods, backfill_overdue_days')
        .eq('id', 1)
        .maybeSingle();
      if (data) {
        setAlertThreshold(data.threshold_periods);
        if (typeof data.backfill_overdue_days === 'number') setBackdateGraceDays(data.backfill_overdue_days);
      }
    })();
  }, []);

  async function checkAndPromptNotify(studentNo: string) {
    if (isAdmin || !isHomeroom || alertThreshold === null) return;
    const { data } = await supabase.from('student_absence_counts').select('absence_periods').eq('student_no', studentNo).maybeSingle();
    const count = data?.absence_periods ?? 0;
    if (count >= alertThreshold) {
      const student = students.find((s) => s.student_no === studentNo);
      setNotifyQueue((prev) =>
        prev.some((p) => p.student_no === studentNo) ? prev : [...prev, { student_no: studentNo, name: student?.name ?? studentNo, count }]
      );
    }
  }

  async function handleDecideNotify(decision: '已寄送' | '不寄送') {
    if (!notifyPrompt || alertThreshold === null) return;
    setNotifyBusy(true);
    const { error } = await supabase.from('attendance_notifications').insert({
      student_no: notifyPrompt.student_no,
      absence_count: notifyPrompt.count,
      threshold_snapshot: alertThreshold,
      decision,
      decided_by: homeroomTeacherId,
    });
    setNotifyBusy(false);
    if (error) {
      alert('記錄失敗：' + error.message);
      return;
    }
    setNotifyQueue((prev) => prev.slice(1));
  }

  async function handleSave() {
    if (!selectedEntry) return;
    const rows = Object.entries(statusMap).map(([student_no, status]) => ({
      student_no,
      record_date: date,
      period_no: selectedEntry.period_no,
      status,
    }));
    const { error } = await supabase.from('attendance').upsert(rows, {
      onConflict: 'student_no,record_date,period_no',
    });
    if (error) {
      alert('儲存失敗：' + error.message);
    } else {
      alert('已儲存');
      rows.forEach((r) => checkAndPromptNotify(r.student_no));
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>出缺勤登錄</h1>

      <div style={{ marginBottom: 12 }}>
        <input
          type="date"
          value={date}
          max={todayStr()}
          onChange={(e) => setDate(e.target.value)}
          style={{ padding: 8, borderRadius: 8, border: '1px solid #ccc', width: '100%' }}
        />
        {date !== todayStr() && (
          <p style={{ fontSize: 12, color: '#A36A2D', marginTop: 4 }}>
            正在補登 {date} 的紀錄{isHomeroom && !isAdmin ? `（導師可直接補登導師班 ${backdateGraceDays} 天內的紀錄）` : ''}
          </p>
        )}
      </div>

      {isAdmin && classOptions.length > 0 && (
        <select
          value={adminClassId ?? ''}
          onChange={(e) => setAdminClassId(e.target.value)}
          style={{ padding: 8, marginBottom: 12, width: '100%' }}
        >
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}

      {!isAdmin && isHomeroom && periods.some((p) => p.source === 'homeroom') && (
        // 「自己任課節次／導師班節次」顏色圖例：常用資訊但不是每次都需要看，收合起來，
        // 手機版面留給下面實際要點的節次按鈕跟學生名單。
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>{siteContent['page_hint.attendance_mobile_legend'] ?? '顏色圖例'}</summary>
          <p style={{ fontSize: 12, color: '#666', marginTop: 6, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: SOURCE_COLOR.teach.bg, display: 'inline-block' }} />
              自己任課節次
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: SOURCE_COLOR.homeroom.bg, display: 'inline-block' }} />
              導師班（{homeroomClassLabel}）全部節次
            </span>
          </p>
        </details>
      )}

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 8 }}>
        {periods.map((p) => {
          const active = selectedKey === p.key;
          const color = SOURCE_COLOR[p.source];
          return (
            <button
              key={p.key}
              onClick={() => setSelectedKey(p.key)}
              style={{
                padding: '8px 14px',
                borderRadius: 999,
                border: active ? `1px solid ${color.bg}` : '1px solid #ccc',
                background: active ? color.bg : '#fff',
                color: active ? color.text : '#2C2C2A',
                fontSize: 14,
                whiteSpace: 'nowrap',
              }}
            >
              第{p.period_no}節{p.classLabel && p.source !== 'admin' ? `・${p.classLabel}` : ''}
            </button>
          );
        })}
        {periods.length === 0 && <span style={{ fontSize: 13, color: '#999' }}>今天沒有排課</span>}
      </div>

      {selectedEntry && (
        <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
          {selectedEntry.subject}
          {selectedEntry.teacherName ? `　授課教師：${selectedEntry.teacherName}` : ''}
        </p>
      )}

      {locked && (
        <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 8 }}>
          此節次已鎖定，如需修正請送出申請（任課教師適用；導師可直接修正自己導師班）。
        </p>
      )}

      {pastGraceWindow && (
        <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 8 }}>
          此日期已超過可直接補登的 {backdateGraceDays} 天範圍，請改到「一週出缺勤」頁對個別紀錄送出修正申請，或聯絡管理員直接登錄。
        </p>
      )}

      {students.map((s) => (
        <div
          key={s.student_no}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 0',
            borderBottom: '1px solid #eee',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>
            <span style={{ color: '#999', marginRight: 6 }}>{s.seat_no}</span>
            {s.name}
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt}
                disabled={locked || pastGraceWindow}
                onClick={() => setStatus(s.student_no, opt)}
                style={{
                  fontSize: 13,
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid #ccc',
                  background: statusMap[s.student_no] === opt ? '#EAF3DE' : '#fff',
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        onClick={handleSave}
        disabled={locked || pastGraceWindow || !selectedEntry}
        style={{
          width: '100%',
          marginTop: 16,
          padding: 12,
          borderRadius: 8,
          background: '#2C2C2A',
          color: '#fff',
          border: 'none',
        }}
      >
        儲存
      </button>

      {notifyPrompt && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: '90%', maxWidth: 340 }}>
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>出缺席示警</h2>
            <p style={{ fontSize: 13, marginBottom: 16 }}>
              <b>{notifyPrompt.name}</b> 事假＋病假＋曠課累計已達 <b>{notifyPrompt.count}</b> 節（門檻 {alertThreshold} 節），是否寄送通知信給家長？
              {notifyQueue.length > 1 && <span style={{ color: '#999' }}>（還有 {notifyQueue.length - 1} 位待處理）</span>}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleDecideNotify('已寄送')}
                disabled={notifyBusy}
                style={{ flex: 1, padding: 10, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}
              >
                寄送通知信
              </button>
              <button
                onClick={() => handleDecideNotify('不寄送')}
                disabled={notifyBusy}
                style={{ flex: 1, padding: 10, background: '#eee', border: 'none', borderRadius: 6 }}
              >
                暫不寄送
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
