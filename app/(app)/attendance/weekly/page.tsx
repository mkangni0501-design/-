'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView, getCurrentTeacherId } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { departmentForGrade } from '@/lib/gradeMapping';
import { getEffectivePeriodCount, WEEKDAY_LABELS } from '@/lib/periodConfig';
import { resolveCurrentTerm } from '@/lib/academicTerm';
import {
  readWorkbook,
  readAllClassSheets,
  parseSheetHeader,
  parseStudentRows,
  findAttendanceDateColumns,
  ATTENDANCE_CODE_TO_STATUS,
} from '@/lib/scoreAttendanceSheetParser';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import {
  downloadScoreAttendanceTemplate,
  downloadScoreAttendanceTemplateForClass,
  downloadScoreAttendanceTemplateForClasses,
} from '@/lib/excelTemplates';
import ErrorBanner from '@/components/ErrorBanner';

const STATUS_OPTIONS = ['出席', '曠課', '遲到', '病假', '事假', '公假'] as const;
// 【2026-08-26 依回饋修正】這裡原本是寫死的常數 BACKDATE_GRACE_DAYS = 7，跟「出缺席示警
// 門檻設定」頁裡訓導處可以調整的「出缺席補登逾期天數」（attendance_alert_settings.
// backfill_overdue_days）完全是兩回事——訓導處在後台改了那個數字，存進資料庫，但這裡
// 從來沒有讀取過那個欄位，教師端看到的補登期限永遠是寫死的 7 天，跟後台設定值沒套用
// 這個問題的根源。改成預設值（DEFAULT_BACKDATE_GRACE_DAYS，行為當作「讀不到設定時的
// 備援值」），實際判斷改用下面從資料庫讀回來、可隨後台設定變動的 backdateGraceDays state。
const DEFAULT_BACKDATE_GRACE_DAYS = 7;

type StudentRow = { student_no: string; seat_no: number; name: string };
type ClassOption = { id: string; label: string; grade_level: string };

// 注意：這裡刻意不用 d.toISOString().slice(0,10)——toISOString 會先轉成 UTC 時間再輸出，
// 在台灣（UTC+8）午夜到早上8點之間，UTC 日期會是前一天，導致「星期一」卻顯示成上週日的日期。
// 改用本地時間的年/月/日組字串，才會跟畫面上的「星期幾」對得起來。
function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getMonday(d: Date) {
  const date = new Date(d);
  const day = date.getDay() || 7; // 0(週日)->7
  if (day !== 1) date.setDate(date.getDate() - (day - 1));
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d: Date, n: number) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}
// 把 <input type="date"> 的 "YYYY-MM-DD" 字串轉成本地時間的 Date，
// 不能直接 new Date(str)——那會被當成 UTC 午夜解析，一樣會有日期跑掉一天的問題。
function parseLocalDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function WeeklyAttendancePage() {
  const isMobile = useIsMobile();
  const [me, setMe] = useState<{ id: string; name: string; role: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isHomeroom, setIsHomeroom] = useState(false);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [className, setClassName] = useState('');
  const [department, setDepartment] = useState('');
  const [students, setStudents] = useState<StudentRow[]>([]);
  // pivotDate：目前檢視週次所在的任一天，預設今天。可用「上一週／下一週」平移，
  // 也可以直接用日期選擇器跳到任何一天所在的那一週。
  const [pivotDate, setPivotDate] = useState<Date>(() => new Date());
  const [periodCounts, setPeriodCounts] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [attMap, setAttMap] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [requestCell, setRequestCell] = useState<{ student_no: string; name: string; dateStr: string; period: number } | null>(null);
  const [requestReason, setRequestReason] = useState('');

  // 申請開放（整週/整班鎖定時使用，跟上面單一格「補登超過範圍」的修正申請不同）
  const [showOpenRequest, setShowOpenRequest] = useState(false);
  const [openRequestReason, setOpenRequestReason] = useState('');

  // 批次登錄：勾選學生、勾選日期後，選擇出席狀況一起修改
  const [selectedStudents, setSelectedStudents] = useState<Set<string>>(new Set());
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [batchStatus, setBatchStatus] = useState<(typeof STATUS_OPTIONS)[number]>('出席');
  const [batchBusy, setBatchBusy] = useState(false);

  // 出缺席示警：導師輸入後，若學生「事假+病假+曠課」累計節數達到管理員設定的門檻，
  // 會跳出提示讓導師自行選擇是否寄送通知信（同時留下紀錄給管理者查看）。
  const [teacherId, setTeacherId] = useState<string | null>(null);
  // 反映事項「導師修正班級學生出缺席功能，請修正只能把非任教科目中【曠課】學生改為
  // 【事假】、【病假】、【公假】」：導師對「自己有任課」的節次（跟 class_schedule
  // 比對 teacher_id 是不是自己）維持原本完整的登錄/修改權限；對「自己沒有任課」的
  // 節次，只能把目前狀態是「曠課」的學生改成事假/病假/公假這三種請假狀態，其他
  // 狀態一律不能碰（不能改成出席/遲到，也不能把非曠課的狀態改掉）——管理員
  // （isAdmin）不受這個限制，維持原本可以修改任一節次任一狀態的權限。
  // key 格式："{weekday 1~6}-{period_no}"，只要「值」是 true 就代表這個weekday+節次
  // 是自己的任課節次（跟日期無關，class_schedule 本身就是照weekday排的固定課表）。
  const [ownTaughtPeriods, setOwnTaughtPeriods] = useState<Record<string, boolean>>({});
  const [alertThreshold, setAlertThreshold] = useState<number | null>(null);
  // 【2026-08-26 新增】出缺席補登逾期天數，改成從 attendance_alert_settings 讀取
  // （見下面 useEffect），不再用寫死的常數。讀不到資料時退回 DEFAULT_BACKDATE_GRACE_DAYS。
  const [backdateGraceDays, setBackdateGraceDays] = useState<number>(DEFAULT_BACKDATE_GRACE_DAYS);
  const [notifyQueue, setNotifyQueue] = useState<{ student_no: string; name: string; count: number }[]>([]);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const notifyPrompt = notifyQueue[0] ?? null;

  function toggleSelectedStudent(studentNo: string) {
    setSelectedStudents((prev) => {
      const next = new Set(prev);
      if (next.has(studentNo)) next.delete(studentNo);
      else next.add(studentNo);
      return next;
    });
  }
  function toggleSelectedDate(dateStr: string) {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  }

  const weekStart = useMemo(() => getMonday(pivotDate), [pivotDate]);

  // 【2026-08-26 新增】依回饋修正：整班/整週被鎖定時，申請開放的表單原本要導師先點一次
  // 「申請開放」按鈕才會出現（showOpenRequest 預設 false），等於「打開頁面看到鎖定訊息」
  // 跟「看到可以填寫的申請表單」中間多了一次不必要的點擊。改成偵測到鎖定狀態時就自動展開
  // 表單，不用再多點一次。（isAdmin 不受鎖定影響，不需要這個表單，所以只在非管理員時展開。）
  useEffect(() => {
    if (locked && !isAdmin) setShowOpenRequest(true);
  }, [locked, isAdmin]);

  useEffect(() => {
    (async () => {
      // 【2026-08-26 修正】一併讀 backfill_overdue_days，讓補登期限跟著訓導處在
      // 「出缺席示警門檻設定」頁調整的值走，而不是永遠用寫死的 7 天。
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

  const weekDates = useMemo(
    () => WEEKDAY_LABELS.map((_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    }),
    [weekStart]
  );

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      setMe(appUser);
      // 改用 isAdminInCurrentView()，讓「切換身分」在這頁也生效（見 attendance/mobile 同樣的修正）
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        const { data: allClasses, error } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        if (error) setLoadError('讀取班級清單失敗：' + error.message);
        const options: ClassOption[] = (allClasses ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
          grade_level: c.grade_level,
        }));
        setClassOptions(options);
        if (options.length > 0) setClassId(options[0].id);
        else setLoading(false);
        return;
      }

      const { data: teacherRow } = await supabase.from('teachers').select('id').eq('app_user_id', appUser.id).single();
      if (!teacherRow) {
        setLoading(false);
        return;
      }
      setTeacherId(teacherRow.id);
      // 【2026-08 修正】根因跟 attendance/mobile 頁一樣：原本查「自己導的班級」沒有
      // 依學年度篩選，累積超過一學年資料後同一位老師可能在不同學年都當過導師，
      // `.maybeSingle()` 一次查到兩筆（去年+今年）就會直接出錯，`cls` 變成 null，
      // 整頁就變成「完全看不到自己的導師班」。改成先取得目前生效學年度，限定在
      // 這個學年度之內查詢。
      const currentTerm = await resolveCurrentTerm();
      const currentYear = currentTerm?.academic_year;
      let cls: { id: string; class_name: string; grade_level: string } | null = null;
      let clsQuery = supabase.from('classes').select('id, class_name, grade_level').eq('homeroom_teacher_id', teacherRow.id);
      if (currentYear != null) clsQuery = clsQuery.eq('academic_year', currentYear);
      const { data: clsById } = await clsQuery.maybeSingle();
      cls = clsById ?? null;

      // 保險機制：用 teacher_id 找不到自己導的班級時，改用姓名比對一次
      // （避免同一位老師被系統記成兩筆不同的 teachers 資料，導致完全找不到自己導的班）。
      if (!cls) {
        let allHomeroomQuery = supabase
          .from('classes')
          .select('id, class_name, grade_level, homeroom_teacher_id')
          .not('homeroom_teacher_id', 'is', null);
        if (currentYear != null) allHomeroomQuery = allHomeroomQuery.eq('academic_year', currentYear);
        const { data: allHomeroomClasses } = await allHomeroomQuery;
        const teacherIds = Array.from(new Set((allHomeroomClasses ?? []).map((c: any) => c.homeroom_teacher_id)));
        if (teacherIds.length > 0) {
          const { data: teacherNameRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          const nameById = new Map((teacherNameRows ?? []).map((t: any) => [t.id, t.name]));
          const match = (allHomeroomClasses ?? []).find((c: any) => nameById.get(c.homeroom_teacher_id) === appUser.name);
          if (match) cls = match;
        }
      }
      if (!cls) {
        setLoading(false);
        return;
      }
      setIsHomeroom(true);
      setClassId(cls.id);
      setClassName(`${cls.grade_level}${cls.class_name}`);
      setDepartment(departmentForGrade(cls.grade_level));
    })();
  }, []);

  useEffect(() => {
    if (!classId) return;
    (async () => {
      setLoading(true);
      setLoadError(null);

      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) {
          setClassName(opt.label);
          setDepartment(departmentForGrade(opt.grade_level));
        }
      }

      // 注意：這裡刻意不用 students(...) 這種自動關聯embed查詢——在這個資料庫上這類查詢會不穩定、
      // 整批失敗又不一定會回報明確錯誤，導致學生名單完全出不來。改成分開查、用 Map 手動兜資料。
      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('seat_no, student_no')
        .eq('class_id', classId)
        .eq('is_current', true) // 只抓目前仍在班的學生，避免轉班/升級後的舊紀錄殘留在名單裡
        .order('seat_no');
      if (enrollErr) setLoadError('讀取學生名單失敗：' + enrollErr.message);

      const studentNos0 = (enrollRows ?? []).map((r: any) => r.student_no);
      const { data: studentRows0, error: studentErr0 } = await supabase
        .from('students')
        .select('student_no, name')
        .in('student_no', studentNos0.length > 0 ? studentNos0 : ['__none__']);
      if (studentErr0) setLoadError('讀取學生姓名失敗：' + studentErr0.message);
      const nameByStudentNo0 = new Map((studentRows0 ?? []).map((s: any) => [s.student_no, s.name]));

      const rows: StudentRow[] = (enrollRows ?? []).map((r: any) => ({
        student_no: r.student_no,
        seat_no: r.seat_no,
        name: nameByStudentNo0.get(r.student_no) ?? '（找不到姓名）',
      }));
      setStudents(rows);

      const dept = isAdmin ? departmentForGrade(classOptions.find((c) => c.id === classId)?.grade_level ?? '') : department;
      const counts = await Promise.all(weekDates.map((d) => getEffectivePeriodCount((d.getDay() || 7), dept, classId)));
      setPeriodCounts(counts);

      const startStr = toDateStr(weekDates[0]);
      const endStr = toDateStr(weekDates[5]);
      const studentNos = rows.map((r) => r.student_no);
      if (studentNos.length > 0) {
        const { data: attRows, error: attErr } = await supabase
          .from('attendance')
          .select('student_no, record_date, period_no, status')
          .in('student_no', studentNos)
          .gte('record_date', startStr)
          .lte('record_date', endStr);
        if (attErr) setLoadError('讀取出缺勤紀錄失敗：' + attErr.message);
        const map: Record<string, string> = {};
        (attRows ?? []).forEach((r: any) => {
          map[`${r.student_no}|${r.record_date}|${r.period_no}`] = r.status;
        });
        setAttMap(map);
      } else {
        setAttMap({});
      }

      // 是否已鎖定：改成呼叫 submission_window_locked()，跟排名頁面/成績登錄頁一致
      // （班級 > 部別 > 全校 三層 fallback，且「手動鎖定」或「開放結束時間已過」任一成立即算鎖定）。
      // 原本這裡只查「這個班自己有沒有設班級層級的 is_locked」，沒有 fallback、也不看時間。
      const currentTermInfo = await resolveCurrentTerm();
      if (currentTermInfo) {
        const { data: isLocked } = await supabase.rpc('submission_window_locked', {
          p_class_id: classId,
          p_academic_year: currentTermInfo.academic_year,
          p_term: currentTermInfo.term,
          p_data_type: '出缺勤',
        });
        setLocked(!!isLocked);

        // 導師「非任教科目」限制用：抓這個班這學期的課表（class_schedule），
        // 比對每個 weekday+節次的 teacher_id 是不是自己，只有導師（非管理員）需要，
        // 但這裡不特別排除管理員，反正管理員身分本來就不會去讀這個 state。
        if (teacherId) {
          const { data: scheduleRows } = await supabase
            .from('class_schedule')
            .select('weekday, period_no, teacher_id')
            .eq('class_id', classId)
            .eq('academic_year', currentTermInfo.academic_year)
            .eq('term', currentTermInfo.term);
          const own: Record<string, boolean> = {};
          (scheduleRows ?? []).forEach((r: any) => {
            own[`${r.weekday}-${r.period_no}`] = r.teacher_id === teacherId;
          });
          setOwnTaughtPeriods(own);
        }
      } else {
        setLocked(false);
      }

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, weekStart, reloadTick]);

  function daysAgo(dateStr: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr);
    return Math.round((today.getTime() - d.getTime()) / 86400000);
  }

  function isEditable(dateStr: string) {
    if (isAdmin) return true;
    if (!isHomeroom) return false;
    if (locked) return false; // 已鎖定：需送出「申請開放」，由管理員審核後才能再登錄
    return daysAgo(dateStr) <= backdateGraceDays;
  }

  // weekday：跟 getEffectivePeriodCount() 那裡的算法一致（Date.getDay() 星期日是0，
  // 這裡的 weekday 欄位是 1=一...6=六，星期日沒有課，不會被查詢用到）。
  function weekdayOf(dateStr: string) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDay() || 7;
  }

  // 這個weekday+節次是不是導師自己的任課節次；管理員不受這個限制影響（呼叫端會先
  // 判斷 isAdmin，這裡單純回答「課表上是不是我」這件事本身）。
  function isOwnTaughtPeriod(dateStr: string, period: number) {
    return !!ownTaughtPeriods[`${weekdayOf(dateStr)}-${period}`];
  }

  const LEAVE_STATUSES = ['事假', '病假', '公假'] as const;
  // 非任教科目時，這個狀態改動允不允許：只能從「曠課」改成事假/病假/公假三種之一
  // （沿用同一個狀態也視為允許，等於「不改」）。
  function isAllowedNonTeachingChange(currentStatus: string, nextStatus: string) {
    if (nextStatus === currentStatus) return true;
    return currentStatus === '曠課' && (LEAVE_STATUSES as readonly string[]).includes(nextStatus);
  }

  async function checkAndPromptNotify(student_no: string) {
    // 只有導師（非管理員、非任課教師）需要在達門檻時被詢問是否寄送通知信
    if (isAdmin || !isHomeroom || alertThreshold === null) return;
    const { data } = await supabase.from('student_absence_counts').select('absence_periods').eq('student_no', student_no).maybeSingle();
    const count = data?.absence_periods ?? 0;
    if (count >= alertThreshold) {
      const student = students.find((s) => s.student_no === student_no);
      setNotifyQueue((prev) => (prev.some((p) => p.student_no === student_no) ? prev : [...prev, { student_no, name: student?.name ?? student_no, count }]));
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
      decided_by: teacherId,
    });
    setNotifyBusy(false);
    if (error) {
      alert('記錄失敗：' + error.message);
      return;
    }
    setNotifyQueue((prev) => prev.slice(1));
  }

  async function handleSetStatus(student_no: string, dateStr: string, period: number, status: string) {
    // 【本輪新增】非任教科目時，只能把「曠課」改成事假/病假/公假——這裡是最後一道
    // 防線（下拉選單本身也已經限制選項，但這裡再擋一次，避免有其他呼叫路徑繞過
    // UI 限制），管理員不受影響。
    if (!isAdmin && !isOwnTaughtPeriod(dateStr, period)) {
      const currentStatus = attMap[`${student_no}|${dateStr}|${period}`] ?? '出席';
      if (!isAllowedNonTeachingChange(currentStatus, status)) {
        alert('這一節不是您任教的科目，只能把「曠課」改成事假／病假／公假。');
        return;
      }
    }
    const { error } = await supabase.from('attendance').upsert(
      { student_no, record_date: dateStr, period_no: period, status },
      { onConflict: 'student_no,record_date,period_no' }
    );
    if (error) {
      alert('儲存失敗：' + error.message);
      return;
    }
    setAttMap((prev) => ({ ...prev, [`${student_no}|${dateStr}|${period}`]: status }));
    checkAndPromptNotify(student_no);
  }

  async function handleSubmitCorrectionRequest() {
    if (!requestCell) return;
    const { student_no, dateStr, period } = requestCell;
    // 【2026-08-26 修正】原本沒有檢查這個查詢本身的 error，只看 attRow 是否為空——
    // 如果查詢本身失敗（例如網路問題、權限問題），data 一樣會是 null，會被誤判成
    // 「這個時段還沒有出缺勤紀錄」這個不相關、誤導的訊息，導師看到錯誤但完全猜不出
    // 真正原因。改成先檢查 error，查詢真的失敗時顯示真正的錯誤訊息。
    const { data: attRow, error: findErr } = await supabase
      .from('attendance')
      .select('id')
      .eq('student_no', student_no)
      .eq('record_date', dateStr)
      .eq('period_no', period)
      .maybeSingle();
    if (findErr) {
      alert('查詢出缺勤紀錄失敗：' + findErr.message);
      return;
    }
    if (!attRow) {
      alert('這個時段目前還沒有出缺勤紀錄，這種情況無法送出修正申請，請聯絡管理員直接補登。');
      return;
    }
    const requesterTeacherId = await getCurrentTeacherId();
    if (!requesterTeacherId) {
      alert('找不到您的教師資料，無法送出申請');
      return;
    }
    // 【2026-08-26 新增】補上 academic_year/term——欄位本來就存在（sql/9），
    // 之前送出申請時完全沒有帶這兩個值，一律是 null。
    const currentTerm = await resolveCurrentTerm();
    const { error } = await supabase.from('correction_requests').insert({
      requested_by: requesterTeacherId,
      data_type: '出缺勤',
      record_id: attRow.id,
      reason: requestReason || null,
      academic_year: currentTerm?.academic_year ?? null,
      term: currentTerm?.term ?? null,
    });
    if (error) {
      alert('送出申請失敗：' + error.message);
      return;
    }
    alert('已送出修正申請，待管理員審核');
    setRequestCell(null);
    setRequestReason('');
  }

  // 整班/整週已鎖定時：導師送出「申請開放」，跟上面單筆補登超過範圍的修正申請不同，
  // 這裡不指定 record_id，改用 scope/scope_ref 標示要開放的範圍，由管理員審核後解鎖。
  async function handleSubmitOpenRequest() {
    if (!classId) return;
    const requesterTeacherId = await getCurrentTeacherId();
    if (!requesterTeacherId) {
      alert('找不到您的教師資料，無法送出申請');
      return;
    }
    const currentTerm = await resolveCurrentTerm();
    const { error } = await supabase.from('correction_requests').insert({
      requested_by: requesterTeacherId,
      data_type: '出缺勤',
      scope: '班級',
      scope_ref: classId,
      reason: openRequestReason || null,
      academic_year: currentTerm?.academic_year ?? null,
      term: currentTerm?.term ?? null,
    });
    if (error) {
      alert('送出申請失敗：' + error.message);
      return;
    }
    alert('已送出開放申請，待管理員審核');
    setShowOpenRequest(false);
    setOpenRequestReason('');
  }


  // 批次登錄：勾選的每一位學生 × 每一個勾選的日期，把該天所有節次都改成同一個出席狀況。
  async function handleApplyBatchStatus() {
    if (selectedStudents.size === 0 || selectedDates.size === 0) {
      alert('請至少勾選一位學生與一個日期');
      return;
    }
    setBatchBusy(true);
    const payload: { student_no: string; record_date: string; period_no: number; status: string }[] = [];
    const skippedDates = new Set<string>();
    let skippedNonTeachingCount = 0;
    Array.from(selectedDates).forEach((dateStr) => {
      if (!isEditable(dateStr)) {
        skippedDates.add(dateStr);
        return;
      }
      const dIdx = weekDates.findIndex((d) => toDateStr(d) === dateStr);
      const count = dIdx >= 0 ? Math.max(periodCounts[dIdx], 1) : 1;
      Array.from(selectedStudents).forEach((studentNo) => {
        for (let period = 1; period <= count; period++) {
          // 【本輪新增】批次套用一次涵蓋一整天所有節次，容易連導師自己沒任課的節次
          // 也一起被覆蓋掉——非管理員時，每一節都個別檢查：不是自己任課的節次，
          // 只有「目前是曠課、且要改成事假/病假/公假」才會真的套用，其他情況直接
          // 跳過那一節（不覆蓋），不是整批擋下來。
          if (!isAdmin && !isOwnTaughtPeriod(dateStr, period)) {
            const currentStatus = attMap[`${studentNo}|${dateStr}|${period}`] ?? '出席';
            if (!isAllowedNonTeachingChange(currentStatus, batchStatus)) {
              skippedNonTeachingCount++;
              continue;
            }
          }
          payload.push({ student_no: studentNo, record_date: dateStr, period_no: period, status: batchStatus });
        }
      });
    });
    if (payload.length === 0) {
      setBatchBusy(false);
      alert(
        skippedNonTeachingCount > 0
          ? '勾選範圍內都不是您任教的科目、或狀態不是「曠課」，非任教科目只能把曠課改成事假/病假/公假。'
          : '勾選的日期都無法直接登錄（已鎖定或超過補登範圍），請改用「申請開放」或單筆修正申請。'
      );
      return;
    }
    const { error } = await supabase.from('attendance').upsert(payload, { onConflict: 'student_no,record_date,period_no' });
    setBatchBusy(false);
    if (error) {
      alert('批次登錄失敗：' + error.message);
      return;
    }
    setAttMap((prev) => {
      const next = { ...prev };
      payload.forEach((p) => {
        next[`${p.student_no}|${p.record_date}|${p.period_no}`] = p.status;
      });
      return next;
    });
    const notes: string[] = [];
    if (skippedDates.size > 0) notes.push(`${skippedDates.size} 個日期因已鎖定/超過補登範圍而略過`);
    if (skippedNonTeachingCount > 0) notes.push(`${skippedNonTeachingCount} 節因非任教科目且不符合「曠課→請假」規則而略過`);
    if (notes.length > 0) {
      alert(`已套用，但有${notes.join('；')}。`);
    }
    Array.from(selectedStudents).forEach((studentNo) => checkAndPromptNotify(studentNo));
  }

  // 【本輪新增】反映事項「如有班級學生資料，請直接用班級名冊下載以順利填寫相關出缺
  // 資料，無才用範本」——這個班已經有名冊（students.length>0）的話，直接帶出真實
  // 座號/學號/姓名（downloadScoreAttendanceTemplateForClass，這支函式本來就有，
  // 只是這裡之前一直沒用到），不用再讓老師自己key學號；完全沒有名冊時才退回原本
  // 的空白範本（downloadScoreAttendanceTemplate），版面才不會一片空白看起來像壞掉。
  async function handleDownloadTemplate() {
    if (students.length === 0 || !classId) {
      downloadScoreAttendanceTemplate();
      return;
    }
    const [{ data: cls }, currentTerm] = await Promise.all([
      supabase.from('classes').select('academic_year, grade_level, class_name').eq('id', classId).maybeSingle(),
      resolveCurrentTerm(),
    ]);
    if (!cls) {
      downloadScoreAttendanceTemplate();
      return;
    }
    downloadScoreAttendanceTemplateForClass({
      academicYear: cls.academic_year,
      term: currentTerm?.term ?? '上學期',
      gradeLevel: cls.grade_level,
      className: cls.class_name,
      subjects: [],
      students,
    });
  }

  // 【本輪新增】反映事項「系統管理員能一次上傳全校整學期出缺狀態（目前一次只能用
  // 一個班）」——這裡是對應的「一次下載全校」，管理員專用：抓目前生效學年度/學期
  // 全校所有班級的真實名冊，組成一個活頁簿、一班一個分頁，管理員填完直接整批
  // 上傳回去（見下面 handleUploadFile 的多分頁處理）。
  async function handleDownloadAllClassesTemplate() {
    const currentTerm = await resolveCurrentTerm();
    if (!currentTerm) {
      alert('讀不到目前生效的學年度／學期，請先在「學年學期設定」確認。');
      return;
    }
    const { data: allClasses, error: clsErr } = await supabase
      .from('classes')
      .select('id, grade_level, class_name')
      .eq('academic_year', currentTerm.academic_year)
      .order('grade_level')
      .order('class_name');
    if (clsErr || !allClasses || allClasses.length === 0) {
      alert('讀取全校班級清單失敗：' + (clsErr?.message ?? '目前學年度沒有任何班級'));
      return;
    }
    const classesData = await Promise.all(
      allClasses.map(async (c: any) => {
        const { data: enrollRows } = await supabase
          .from('enrollments')
          .select('seat_no, student_no')
          .eq('class_id', c.id)
          .eq('is_current', true)
          .order('seat_no');
        const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
        const { data: studentRows } =
          studentNos.length === 0
            ? { data: [] as any[] }
            : await supabase.from('students').select('student_no, name').in('student_no', studentNos);
        const nameByStudentNo = new Map((studentRows ?? []).map((s: any) => [s.student_no, s.name]));
        return {
          academicYear: currentTerm.academic_year,
          term: currentTerm.term,
          gradeLevel: c.grade_level,
          className: c.class_name,
          subjects: [],
          students: (enrollRows ?? []).map((r: any) => ({
            seatNo: r.seat_no,
            studentNo: r.student_no,
            name: nameByStudentNo.get(r.student_no) ?? '（找不到姓名）',
          })),
        };
      })
    );
    downloadScoreAttendanceTemplateForClasses(classesData);
  }

  async function handleUploadFile(file: File) {
    // 【本輪新增】管理員：一次處理整個活頁簿裡的「所有」分頁（一班一分頁），
    // 對應反映事項「系統管理員能一次上傳全校整學期出缺狀態（目前一次只能用一個
    // 班）」；非管理員（導師／任課教師）維持原本「只讀第一張成績/出缺輸入表分頁」
    // 的單班行為不變，避免一般教師誤用整批工具動到其他班級。
    if (isAdmin) {
      const sheets = await readAllClassSheets(file);
      if (sheets.length === 0) {
        return { successCount: 0, errors: ['這個活頁簿裡沒有可用的分頁'] };
      }
      let totalSuccess = 0;
      const allErrors: string[] = [];
      for (const { sheetName, rowsRaw } of sheets) {
        const header = parseSheetHeader(rowsRaw);
        if (!header.academicYear || !header.gradeLevel || !header.className) {
          allErrors.push(`分頁「${sheetName}」讀不到年度/年級/班級，已略過這個分頁`);
          continue;
        }
        const { data: classRow } = await supabase
          .from('classes')
          .select('id')
          .eq('academic_year', header.academicYear)
          .eq('department', departmentForGrade(header.gradeLevel))
          .eq('grade_level', header.gradeLevel)
          .eq('class_name', header.className)
          .maybeSingle();
        if (!classRow) {
          allErrors.push(`分頁「${sheetName}」找不到對應班級：${header.academicYear} ${header.gradeLevel}${header.className}，已略過這個分頁`);
          continue;
        }
        const studentsFromFile = parseStudentRows(rowsRaw);
        const dateColumns = await findAttendanceDateColumns(rowsRaw, header.academicYear);
        if (dateColumns.length === 0) {
          allErrors.push(`分頁「${sheetName}」讀不到任何日期欄位，已略過這個分頁`);
          continue;
        }
        if (studentsFromFile.length === 0) {
          allErrors.push(`分頁「${sheetName}」讀不到任何學生資料，已略過這個分頁`);
          continue;
        }
        for (const s of studentsFromFile) {
          const row = rowsRaw[s.rowIndex];
          for (const dc of dateColumns) {
            for (let period = 1; period <= 5; period++) {
              const colIdx = dc.colIndex + (period - 1);
              const code = row[colIdx];
              // 【本輪新增】系統管理員的檔案可以直接覆蓋原有出缺席資料：空白儲存格
              // 不是「跳過、維持原狀」，是明確視為「出席」寫進去——這樣管理員上傳
              // 的整份檔案才會變成該班這段期間出缺勤唯一的真實來源，不會有舊資料
              // 殘留在檔案沒填到的格子裡。（一般導師/任課教師走下面 else 分支的
              // 單班上傳，維持「空白跳過、只更新有填的格子」這個比較安全的預設。）
              const status = code == null || code === '' ? '出席' : ATTENDANCE_CODE_TO_STATUS[Number(code)];
              if (!status) continue;
              const dateStr = toDateStr(dc.date);
              const { error } = await supabase
                .from('attendance')
                .upsert({ student_no: s.studentNo, record_date: dateStr, period_no: period, status }, { onConflict: 'student_no,record_date,period_no' });
              if (error) allErrors.push(`${sheetName} ${s.name} ${dateStr} 第${period}節：${error.message}`);
              else totalSuccess++;
            }
          }
        }
      }
      setReloadTick((t) => t + 1);
      return { successCount: totalSuccess, errors: allErrors };
    }

    const rowsRaw = await readWorkbook(file);
    const header = parseSheetHeader(rowsRaw);
    if (!header.academicYear || !header.gradeLevel || !header.className) {
      return { successCount: 0, errors: ['讀不到年度/年級/班級，請確認檔案格式'] };
    }

    const { data: classRow } = await supabase
      .from('classes')
      .select('id')
      .eq('academic_year', header.academicYear)
      .eq('department', departmentForGrade(header.gradeLevel))
      .eq('grade_level', header.gradeLevel)
      .eq('class_name', header.className)
      .maybeSingle();
    if (!classRow) {
      return { successCount: 0, errors: [`找不到對應班級：${header.academicYear} ${header.gradeLevel}${header.className}，請先在「班級與導師設定」建立`] };
    }

    const studentsFromFile = parseStudentRows(rowsRaw);
    const dateColumns = await findAttendanceDateColumns(rowsRaw, header.academicYear);

    let successCount = 0;
    const errors: string[] = [];

    // 明確的錯誤訊息，避免像過去那樣「讀不到日期欄位」卻只顯示「成功匯入 0 筆、無錯誤」，
    // 讓使用者誤以為是系統壞掉、其實是檔案格式對不上。
    if (dateColumns.length === 0) {
      return {
        successCount: 0,
        errors: ['讀不到任何日期欄位（第5列），請確認日期格式是「5月10日」這種文字、或是Excel日期格式，且從第4欄開始每個日期固定間隔5欄'],
      };
    }
    if (studentsFromFile.length === 0) {
      return { successCount: 0, errors: ['讀不到任何學生資料（從第8列起，學號欄空白視為結束）'] };
    }

    for (const s of studentsFromFile) {
      const row = rowsRaw[s.rowIndex];
      for (const dc of dateColumns) {
        for (let period = 1; period <= 5; period++) {
          const colIdx = dc.colIndex + (period - 1);
          const code = row[colIdx];
          if (code == null || code === '') continue;
          const status = ATTENDANCE_CODE_TO_STATUS[Number(code)];
          if (!status) continue;
          const dateStr = toDateStr(dc.date);
          const { error } = await supabase
            .from('attendance')
            .upsert(
              { student_no: s.studentNo, record_date: dateStr, period_no: period, status },
              { onConflict: 'student_no,record_date,period_no' }
            );
          if (error) errors.push(`${s.name} ${dateStr} 第${period}節：${error.message}`);
          else successCount++;
        }
      }
    }
    if (classId === classRow.id) {
      setReloadTick((t) => t + 1);
    }
    return { successCount, errors };
  }

  if (!loading && !classId) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>學生出缺席登錄（一週）</h1>
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（本頁僅提供導師與管理員使用）。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : 24, overflowX: 'auto' }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>{className || '班級'} 一週出缺勤（每節分開顯示）</h1>
      <ErrorBanner message={loadError} />

      {isMobile && (
        // 這頁是「一週整表」的檢視/補登，橫向表格在手機上本來就會需要左右滑動；
        // 平常每天登錄出缺勤，手機用「出缺勤登錄」那頁會更順手，這裡先給個提示連過去，
        // 這頁本身仍保留給補登整週紀錄／查看整週狀況用。
        <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          手機上如果只是要登錄「今天」的出缺勤，建議改用{' '}
          <Link href="/attendance/mobile" style={{ color: '#2C2C2A', textDecoration: 'underline' }}>
            出缺勤登錄
          </Link>{' '}
          頁比較好操作；這頁適合查看／補登整週紀錄，表格較寬需要左右滑動。
        </p>
      )}

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setPivotDate((d) => addDays(d, -7))} style={{ padding: '4px 10px' }}>
          ← 上一週
        </button>
        <span style={{ fontSize: 13, color: '#666' }}>
          {toDateStr(weekDates[0])} ～ {toDateStr(weekDates[5])}
        </span>
        <button onClick={() => setPivotDate((d) => addDays(d, 7))} style={{ padding: '4px 10px' }}>
          下一週 →
        </button>
        {toDateStr(weekStart) !== toDateStr(getMonday(new Date())) && (
          <button onClick={() => setPivotDate(new Date())} style={{ padding: '4px 10px', fontSize: 12 }}>
            回到本週
          </button>
        )}
        <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
          直接選擇日期：
          <input
            type="date"
            value={toDateStr(pivotDate)}
            onChange={(e) => {
              if (e.target.value) setPivotDate(parseLocalDateStr(e.target.value));
            }}
            style={{ padding: 4 }}
          />
        </label>
        {classId && (
          <Link
            href={`/attendance/report?classId=${classId}`}
            style={{ padding: '4px 10px', fontSize: 12, border: '1px solid #2C2C2A', borderRadius: 6, color: '#2C2C2A' }}
          >
            查看學生出席紀錄（月報／學期）
          </Link>
        )}
      </div>

      {locked && !isAdmin && (
        <div style={{ padding: 10, background: '#FBEFE9', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#A36A2D' }}>
          <p style={{ marginBottom: 6 }}>此班級的出缺勤目前已被管理員鎖定，無法直接登錄／修改，需送出「申請開放」，經審核通過後才能再次登錄。</p>
          {!showOpenRequest ? (
            <button onClick={() => setShowOpenRequest(true)} style={{ padding: '4px 12px', background: '#A36A2D', color: '#fff', border: 'none', borderRadius: 6 }}>
              申請開放
            </button>
          ) : (
            <div>
              <textarea
                placeholder="申請原因（選填）"
                value={openRequestReason}
                onChange={(e) => setOpenRequestReason(e.target.value)}
                style={{ width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' }}
                rows={2}
              />
              <button onClick={handleSubmitOpenRequest} style={{ padding: '4px 12px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, marginRight: 8 }}>
                送出申請
              </button>
              <button onClick={() => setShowOpenRequest(false)} style={{ padding: '4px 12px' }}>
                取消
              </button>
            </div>
          )}
        </div>
      )}

      {(isAdmin || (isHomeroom && !locked)) && students.length > 0 && (
        <div style={{ padding: 10, background: '#F5F5F3', borderRadius: 6, marginBottom: 12 }}>
          {isMobile ? (
            <details style={{ marginBottom: 6 }}>
              <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>批次登錄說明</summary>
              <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                勾選學生、勾選日期，再選擇出席狀況一起套用（會套用到該天所有節次）。
                {!isAdmin && '非任教科目的節次，只有目前是「曠課」且改成事假/病假/公假時才會套用，其他節次會自動略過。'}
              </p>
            </details>
          ) : (
            <p style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
              批次登錄：勾選學生、勾選日期，再選擇出席狀況一起套用（會套用到該天所有節次）。
              {!isAdmin && '非任教科目的節次，只有目前是「曠課」且改成事假/病假/公假時才會套用，其他節次會自動略過。'}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {weekDates.map((d, i) => {
              const dateStr = toDateStr(d);
              return (
                <label key={dateStr} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={selectedDates.has(dateStr)} onChange={() => toggleSelectedDate(dateStr)} />
                  星期{WEEKDAY_LABELS[i]}　{dateStr.slice(5)}
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {students.map((s) => (
              <label key={s.student_no} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={selectedStudents.has(s.student_no)} onChange={() => toggleSelectedStudent(s.student_no)} />
                {s.seat_no} {s.name}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={batchStatus} onChange={(e) => setBatchStatus(e.target.value as any)} style={{ padding: 4, fontSize: 12 }}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <button
              onClick={handleApplyBatchStatus}
              disabled={batchBusy || selectedStudents.size === 0 || selectedDates.size === 0}
              style={{ padding: '4px 12px', fontSize: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}
            >
              {batchBusy ? '套用中…' : '套用'}
            </button>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>批次上傳（格式同「成績、出缺輸入表」工作表）</h2>
      <TemplateDownloadButton label="下載出缺席輸入範本" onClick={handleDownloadTemplate} />
      {isAdmin && (
        <TemplateDownloadButton label="下載全校出缺席輸入表（一班一分頁）" onClick={handleDownloadAllClassesTemplate} />
      )}
      <ExcelUploadButton onFile={handleUploadFile} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        {isAdmin
          ? '管理員可直接登錄／修改任一班級任一天的出缺勤紀錄，不受鎖定與週次限制；上傳整批檔案時，會處理檔案裡「所有」分頁（一分頁一班），且空白儲存格會直接覆蓋成「出席」，整份檔案即為該班這段期間出缺勤唯一的真實來源。'
          : `導師可直接補登最近 ${backdateGraceDays} 天內的紀錄；超過 ${backdateGraceDays} 天的既有紀錄需點選後送出修正申請，交由管理員審核。`}
      </p>

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th rowSpan={2} style={{ textAlign: 'left', padding: 6, position: 'sticky', left: 0, background: '#fff' }}>
                學生
              </th>
              {weekDates.map((d, i) => (
                <th key={i} colSpan={Math.max(periodCounts[i], 1)} style={{ padding: 6, borderLeft: '1px solid #eee' }}>
                  星期{WEEKDAY_LABELS[i]}　{toDateStr(d).slice(5)}
                </th>
              ))}
            </tr>
            <tr>
              {weekDates.map((d, i) =>
                periodCounts[i] > 0 ? (
                  Array.from({ length: periodCounts[i] }).map((_, p) => (
                    <th key={`${i}-${p}`} style={{ padding: '2px 4px', fontSize: 11, color: '#999', borderLeft: p === 0 ? '1px solid #eee' : undefined }}>
                      {p + 1}
                    </th>
                  ))
                ) : (
                  <th key={`${i}-none`} style={{ padding: '2px 4px', fontSize: 11, color: '#999' }}>
                    —
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.student_no} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6, position: 'sticky', left: 0, background: '#fff', whiteSpace: 'nowrap' }}>
                  {s.seat_no} {s.name}
                </td>
                {weekDates.map((d, i) => {
                  const dateStr = toDateStr(d);
                  const count = Math.max(periodCounts[i], 1);
                  return Array.from({ length: count }).map((_, p) => {
                    if (periodCounts[i] === 0) {
                      return <td key={`${i}-${p}`} style={{ padding: 4, textAlign: 'center', color: '#ccc' }}>-</td>;
                    }
                    const period = p + 1;
                    const key = `${s.student_no}|${dateStr}|${period}`;
                    const status = attMap[key] ?? '出席';
                    const editable = isEditable(dateStr);
                    // 【本輪新增】非管理員時，判斷這一節是不是自己任教的節次——不是的話，
                    // 只能把「曠課」改成事假/病假/公假，其他狀態一律唯讀（不給下拉選單）。
                    const ownTaught = isAdmin || isOwnTaughtPeriod(dateStr, period);
                    const nonTeachingLockedStatus = !ownTaught && status !== '曠課';
                    if (editable && nonTeachingLockedStatus) {
                      return (
                        <td
                          key={key}
                          title="非任教科目：只有「曠課」的學生能改成事假／病假／公假，其他狀態請洽該科任課教師"
                          style={{ padding: 4, textAlign: 'center', color: '#999', borderLeft: p === 0 ? '1px solid #f2f2f2' : undefined }}
                        >
                          {status}
                        </td>
                      );
                    }
                    if (editable) {
                      const options = ownTaught ? STATUS_OPTIONS : (['曠課', ...LEAVE_STATUSES] as const);
                      return (
                        <td key={key} style={{ padding: 2, textAlign: 'center', borderLeft: p === 0 ? '1px solid #f2f2f2' : undefined }}>
                          <select
                            value={status}
                            onChange={(e) => handleSetStatus(s.student_no, dateStr, period, e.target.value)}
                            title={ownTaught ? undefined : '非任教科目：只能把「曠課」改成事假／病假／公假'}
                            style={{
                              fontSize: 11,
                              padding: '2px 2px',
                              border: '1px solid #639922',
                              borderRadius: 4,
                              color: status === '出席' ? '#3B6D11' : '#A36A2D',
                              background: '#fff',
                            }}
                          >
                            {options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    }
                    if (locked && !isAdmin) {
                      return (
                        <td
                          key={key}
                          title="此班級出缺勤已鎖定，請使用上方「申請開放」"
                          style={{ padding: 4, textAlign: 'center', color: '#ccc', borderLeft: p === 0 ? '1px solid #f2f2f2' : undefined }}
                        >
                          {status}
                        </td>
                      );
                    }
                    return (
                      <td
                        key={key}
                        onClick={() => setRequestCell({ student_no: s.student_no, name: s.name, dateStr, period })}
                        title="已超過可直接補登範圍，點選送出修正申請"
                        style={{
                          padding: 4,
                          textAlign: 'center',
                          cursor: 'pointer',
                          color: '#999',
                          borderLeft: p === 0 ? '1px solid #f2f2f2' : undefined,
                        }}
                      >
                        {status}
                      </td>
                    );
                  });
                })}
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={99} style={{ padding: 16, textAlign: 'left', color: '#A36A2D' }}>
                  <p style={{ marginBottom: 6, fontWeight: 600 }}>{className ? `「${className}」` : '這個班'}目前查不到任何在學學生。</p>
                  <p style={{ margin: 0, fontWeight: 400 }}>
                    如果課表節次都看得到、只有學生名單是空的，最常見的原因是「同一個班在系統裡被記成兩筆不同的班級資料」
                    （例如排課系統匯入一次、學籍資料手動建立又建了一次，課表掛在其中一筆、學生名單卻掛在另一筆），
                    不是這個班真的沒有學生。請聯絡系統管理員到【班級資料檢查／合併】頁確認這個班是否重複、需要合併；
                    如果確認不是重複班級，也麻煩請管理員檢查一下這個班學生的「在學狀態」是否正確。
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {requestCell && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #eee', fontSize: 13, maxWidth: 420 }}>
          <p style={{ marginBottom: 8 }}>
            送出修正申請：{requestCell.name}　{requestCell.dateStr}　第{requestCell.period}節
          </p>
          <textarea
            placeholder="修正原因（選填）"
            value={requestReason}
            onChange={(e) => setRequestReason(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
            rows={2}
          />
          <button onClick={handleSubmitCorrectionRequest} style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, marginRight: 8 }}>
            送出申請
          </button>
          <button onClick={() => setRequestCell(null)} style={{ padding: '6px 14px' }}>
            取消
          </button>
        </div>
      )}
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
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 360 }}>
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
