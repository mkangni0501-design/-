'use client';

import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type LinkedStudent = { id: string; student_no: string; relation: string; name: string };
type TermRecord = {
  enrollment_id: string;
  class_id: string;
  academic_year: number;
  term: string;
  class_name: string;
  grade_level: string;
  total_score: number | null;
  class_rank: number | null;
  grade_rank: number | null;
  midterm_total: number | null;
  midterm_class_rank: number | null;
  midterm_grade_rank: number | null;
  final_total: number | null;
  final_class_rank: number | null;
  final_grade_rank: number | null;
  daily_total: number | null;
  daily_class_rank: number | null;
  daily_grade_rank: number | null;
};
type EditRequest = { id: string; field_name: string; target_table: string; new_value: string; status: string; requested_at: string };
type Guardian = { id: string; relation: string; name: string | null; phone: string | null };
// 歷年成績「總分」展開後的各科成績（見 sql/3calculations.sql 的 subject_weighted_scores
// 視圖，security_invoker=true，家長/學生本人是靠 sql/6portal.sql 的 parent_read_own_scores
// 政策讀到自己小孩的 scores，這個視圖會照樣套用同一條政策，不用另外開新的 API）。
type SubjectScoreRow = { subject: string; midterm: number | null; final: number | null; daily: number | null; subject_weighted_score: number | null };
type ScheduleRow = { weekday: number; period_no: number; subject: string; teacher_name: string };
type BulletinPost = { id: string; title: string; content: string; published_at: string | null };

// 可修改的欄位：本人（students 表）的地址/電話，以及每位監護人（guardians 表）的姓名/電話。
// guardian_id 為 null 代表改的是 students 表本身的欄位。
type EditableOption = { key: string; label: string; targetTable: 'students' | 'guardians'; guardianId: string | null; fieldName: string; currentValue: string };

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六'];

export default function ParentPortalPage() {
  const [activeTab, setActiveTab] = useState<'成績' | '課表' | '通知'>('成績');
  const [linkedStudents, setLinkedStudents] = useState<LinkedStudent[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LinkedStudent | null>(null);
  const [records, setRecords] = useState<TermRecord[]>([]);
  const [attendanceCounts, setAttendanceCounts] = useState<Record<string, number>>({});
  const [attendanceDates, setAttendanceDates] = useState<Record<string, string[]>>({});
  const [expandedAttendanceStatus, setExpandedAttendanceStatus] = useState<string | null>(null);
  const [absencePeriods, setAbsencePeriods] = useState(0);
  const [alertThreshold, setAlertThreshold] = useState<number | null>(null);
  const [profile, setProfile] = useState<Record<string, string>>({});
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequest[]>([]);
  const [editKey, setEditKey] = useState('');
  const [editValue, setEditValue] = useState('');
  // 歷年成績點選總分展開各科成績：用 enrollment_id 當 key 存已經抓過的科目成績，
  // 展開過一次之後再收合/展開不用重查；expandedId 記目前是哪一列被展開。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [subjectScores, setSubjectScores] = useState<Record<string, SubjectScoreRow[]>>({});
  const [subjectScoresLoading, setSubjectScoresLoading] = useState<string | null>(null);
  // 教師/班級課表
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  // 通知：公佈欄最新公告
  const [bulletinPosts, setBulletinPosts] = useState<BulletinPost[]>([]);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        router.push('/portal/login');
        return;
      }
      // 【2026-08-19】原本這裡完全沒有「還在載入」跟「載入完成但沒有綁定任何學生」
      // 這兩種狀態的畫面——不管是哪種情況，畫面上都只會看到標題「家長／學生查詢
      // 入口」，下面整片空白，這正是這次反映「登入以後什麼也看不見」的直接原因。
      // 這裡補上明確的載入中／查無資料訊息，不管背後真正卡在哪一步，至少畫面上
      // 會告訴使用者「現在是什麼狀態」，不會像一片空白一樣看起來像當機。
      const { data: accounts, error: accErr } = await supabase
        .from('portal_accounts')
        .select('id, student_no, relation, students(name)')
        .eq('auth_user_id', sessionData.session.user.id);

      if (accErr) {
        setLoadError('讀取綁定的學生資料時發生錯誤：' + accErr.message);
        setLoadingAccounts(false);
        return;
      }

      const list: LinkedStudent[] = (accounts ?? []).map((a: any) => ({
        id: a.id,
        student_no: a.student_no,
        relation: a.relation,
        name: a.students?.name ?? a.student_no,
      }));
      setLinkedStudents(list);
      if (list.length > 0) setSelected(list[0]);
      setLoadingAccounts(false);

      const { data: settingRow } = await supabase.from('attendance_alert_settings').select('threshold_periods').eq('id', 1).maybeSingle();
      if (settingRow) setAlertThreshold(settingRow.threshold_periods);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadEditRequests(studentNo: string) {
    const { data: reqRows } = await supabase
      .from('profile_edit_requests')
      .select('id, field_name, target_table, new_value, status, requested_at')
      .eq('student_no', studentNo)
      .order('requested_at', { ascending: false });
    setEditRequests((reqRows ?? []) as EditRequest[]);
  }

  // 歷年成績表點選「總分」：展開/收合該學期的各科成績。第一次展開才查詢
  // subject_weighted_scores（見上面型別定義旁的說明），查過的學期存進
  // subjectScores 快取，收合再展開不用重查。
  async function handleToggleTermScores(enrollmentId: string) {
    if (expandedId === enrollmentId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(enrollmentId);
    if (subjectScores[enrollmentId]) return;
    setSubjectScoresLoading(enrollmentId);
    const { data } = await supabase
      .from('subject_weighted_scores')
      .select('subject, midterm, final, daily, subject_weighted_score')
      .eq('enrollment_id', enrollmentId);
    setSubjectScores((prev) => ({ ...prev, [enrollmentId]: (data ?? []) as SubjectScoreRow[] }));
    setSubjectScoresLoading(null);
  }

  // 教師/班級課表：抓目前選到的學期（歷年成績裡最新一筆，也就是本學期）所屬
  // 班級的課表，跟 schedule-lookup 頁面查班級課表用的邏輯一致（class_schedule
  // 開放所有登入者讀取，見 sql/30class_schedule_write_policy.sql）。
  async function loadSchedule(classId: string) {
    setScheduleLoading(true);
    setScheduleError(null);
    const { data, error } = await supabase
      .from('class_schedule')
      .select('weekday, period_no, subject, teachers(name)')
      .eq('class_id', classId)
      .order('weekday')
      .order('period_no');
    if (error) {
      setScheduleError('讀取課表時發生錯誤：' + error.message);
      setScheduleRows([]);
    } else {
      setScheduleRows(
        (data ?? []).map((r: any) => ({
          weekday: r.weekday,
          period_no: r.period_no,
          subject: r.subject,
          teacher_name: r.teachers?.name ?? '',
        }))
      );
    }
    setScheduleLoading(false);
  }

  useEffect(() => {
    if (!selected) return;
    setExpandedId(null);
    (async () => {
      // 【2026-08-24 效能修正】原本這裡是「查 enrollments 拿學期清單」＋
      // Promise.all 另外 3 個查詢（總分／班排名／年級排名，各自對 class_rankings／
      // grade_rankings 這兩個「全校通用」view 下 `.in('enrollment_id', [...])`）。
      // 查詢次數雖然已經被前一輪從「學期數 × 3」壓到固定 3 次，但問題其實出在
      // class_rankings／grade_rankings 這兩個 view 本身：它們內部的 rank() over(...)
      // 是先把「全校」所有班級/學生的排名整個算完，才在最外層用 enrollment_id
      // in (...) 篩選——篩選是「算完之後」才發生，不管一個小孩實際只讀過幾個
      // 學期，資料庫每次都得先處理全校規模的資料，這才是「顯示小孩成績速度
      // 非常緩慢」的真正根因，不是查詢次數的問題。
      // 改成呼叫 sql/56portal_scoped_academic_history.sql 新增的
      // portal_student_academic_history()：從一開始就只在「這個學生讀過的
      // 班級/年級」範圍內計算排名（一個班或一個年級，通常只有幾十~一兩百人，
      // 不是全校1300多人），一次 RPC 呼叫就把總分/班排名/年級排名全部算好
      // 回傳，不用前端再自己發 3 個查詢、用 Map 兜資料。
      const { data: historyRows, error: historyError } = await supabase.rpc('portal_student_academic_history', {
        p_student_no: selected.student_no,
      });
      if (historyError) {
        setRecords([]);
      } else {
        const results: TermRecord[] = ((historyRows ?? []) as any[]).map((r) => ({
          enrollment_id: r.enrollment_id,
          class_id: r.class_id,
          academic_year: r.academic_year,
          term: r.term,
          class_name: r.class_name,
          grade_level: r.grade_level,
          total_score: r.total_score ?? null,
          class_rank: r.class_rank ?? null,
          grade_rank: r.grade_rank ?? null,
          midterm_total: r.midterm_total ?? null,
          midterm_class_rank: r.midterm_class_rank ?? null,
          midterm_grade_rank: r.midterm_grade_rank ?? null,
          final_total: r.final_total ?? null,
          final_class_rank: r.final_class_rank ?? null,
          final_grade_rank: r.final_grade_rank ?? null,
          daily_total: r.daily_total ?? null,
          daily_class_rank: r.daily_class_rank ?? null,
          daily_grade_rank: r.daily_grade_rank ?? null,
        }));
        results.sort((a, b) => a.academic_year - b.academic_year || a.term.localeCompare(b.term));
        setRecords(results);
      }

      // 出缺勤彙總／基本資料／監護人資料／修改申請紀錄彼此互不相依，原本依序一個一個等，
      // 改成同時發送，一樣能減少總等待時間。
      // 【本輪修正】反映事項「出席次數跟時間不用顯示，只要顯示曠課、遲到、事假、病假、
      // 公假」——查詢加上 .neq('status','出席')，「出席」（正常到校，不是缺席/遲到）
      // 這個狀態不算彙總、也不用整批抓過來，只留曠課/遲到/病假/事假/公假這5種。
      const [{ data: attendanceRows }, { data: studentRow }, { data: guardianRows }] = await Promise.all([
        supabase.from('attendance').select('status, record_date').eq('student_no', selected.student_no).neq('status', '出席'),
        supabase.from('students').select('address, phone').eq('student_no', selected.student_no).single(),
        supabase.from('guardians').select('id, relation, name, phone').eq('student_no', selected.student_no),
        loadEditRequests(selected.student_no),
      ]);

      const counts: Record<string, number> = {};
      const dateSets: Record<string, Set<string>> = {};
      (attendanceRows ?? []).forEach((r: any) => {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        if (r.record_date) {
          if (!dateSets[r.status]) dateSets[r.status] = new Set();
          dateSets[r.status].add(r.record_date);
        }
      });
      const dates: Record<string, string[]> = {};
      Object.entries(dateSets).forEach(([status, set]) => {
        dates[status] = Array.from(set).sort();
      });
      setAttendanceCounts(counts);
      setAttendanceDates(dates);
      setExpandedAttendanceStatus(null);
      setAbsencePeriods((counts['事假'] ?? 0) + (counts['病假'] ?? 0) + (counts['曠課'] ?? 0));

      setProfile((studentRow as any) ?? {});
      setGuardians((guardianRows ?? []) as Guardian[]);
    })();
  }, [selected]);

  // 可修改欄位依身分不同：學生本人只能改自己的電話/地址；家長可以改本人（學生）跟
  // 監護人的所有可修改欄位。之前不管登入的是學生還是家長，看到的清單完全一樣，
  // 學生本人也能送出「監護人姓名/電話」的修改申請，這裡依 selected.relation 過濾。
  const editableOptions: EditableOption[] = selected
    ? selected.relation === '學生本人'
      ? [
          { key: 'student:address', label: '本人現居地址', targetTable: 'students', guardianId: null, fieldName: 'address', currentValue: profile.address ?? '' },
          { key: 'student:phone', label: '本人聯絡電話', targetTable: 'students', guardianId: null, fieldName: 'phone', currentValue: profile.phone ?? '' },
        ]
      : [
          { key: 'student:address', label: '本人現居地址', targetTable: 'students', guardianId: null, fieldName: 'address', currentValue: profile.address ?? '' },
          { key: 'student:phone', label: '本人聯絡電話', targetTable: 'students', guardianId: null, fieldName: 'phone', currentValue: profile.phone ?? '' },
          ...guardians.flatMap((g) => [
            { key: `guardian:${g.id}:name`, label: `${g.relation}姓名`, targetTable: 'guardians' as const, guardianId: g.id, fieldName: 'name', currentValue: g.name ?? '' },
            { key: `guardian:${g.id}:phone`, label: `${g.relation}電話`, targetTable: 'guardians' as const, guardianId: g.id, fieldName: 'phone', currentValue: g.phone ?? '' },
          ]),
        ]
    : [];

  useEffect(() => {
    if (editableOptions.length > 0 && !editableOptions.some((o) => o.key === editKey)) {
      setEditKey(editableOptions[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians, selected]);

  async function handleSubmitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const option = editableOptions.find((o) => o.key === editKey);
    if (!option) return;
    const account = linkedStudents.find((s) => s.student_no === selected.student_no);
    const { error } = await supabase.from('profile_edit_requests').insert({
      student_no: selected.student_no,
      field_name: option.fieldName,
      target_table: option.targetTable,
      guardian_id: option.guardianId,
      old_value: option.currentValue,
      new_value: editValue,
      requested_by: account?.id,
    });
    if (error) {
      alert('送出失敗：' + error.message);
      return;
    }
    alert('已送出，導師已收到通知，待核准後才會正式更新');
    setEditValue('');
    await loadEditRequests(selected.student_no);
  }

  const currentTerm = records[records.length - 1];
  const halfThreshold = alertThreshold !== null ? Math.ceil(alertThreshold / 2) : null;
  const showAlert = halfThreshold !== null && absencePeriods >= halfThreshold;

  // 通知分頁「有新內容」提醒：原本直接用 `showAlert || editRequests.length > 0` 這種
  // 「現在有沒有資料」來判斷，資料是不是「新的」完全沒被考慮——只要曾經送出過一筆
  // 修改資料申請，不管核准/駁回多久了，editRequests.length 永遠 > 0，這個提醒就永遠
  // 亮著，切進「通知」分頁看過也不會消失（因為判斷式本身完全沒有用到「看過了沒」
  // 這件事，每次重新算都是同一個結果）。這裡改成把「目前有哪些通知內容」濃縮成一組
  // 特徵字串（notificationSignal），跟「上次看過通知分頁時記錄下來的特徵字串」比較，
  // 兩者不同才代表「有看過之後才新增/變化的內容」；使用者切進通知分頁時，把目前的
  // 特徵字串存起來（存在瀏覽器 localStorage，用學號當 key，換人登入或換瀏覽器不會
  // 互相干擾），之後只要內容沒有再變化，提醒就不會再出現，符合「看過就消除，除非有
  // 新內容才又出現」的預期。
  const notificationSignal = JSON.stringify({
    alert: showAlert,
    requests: editRequests.map((r) => `${r.id}:${r.status}`),
    posts: bulletinPosts.map((p) => p.id),
  });
  const seenStorageKey = selected ? `portal_notifications_seen:${selected.student_no}` : null;
  const [seenSignal, setSeenSignal] = useState<string | null>(null);

  useEffect(() => {
    if (!seenStorageKey) {
      setSeenSignal(null);
      return;
    }
    try {
      setSeenSignal(window.localStorage.getItem(seenStorageKey));
    } catch {
      setSeenSignal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenStorageKey]);

  useEffect(() => {
    if (activeTab !== '通知' || !seenStorageKey) return;
    try {
      window.localStorage.setItem(seenStorageKey, notificationSignal);
    } catch {
      // localStorage 不可用（例如無痕模式部分瀏覽器）時，提醒功能退化成「每次都提醒」，
      // 不影響其他功能，這裡就不特別處理錯誤。
    }
    setSeenSignal(notificationSignal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, seenStorageKey, notificationSignal]);

  const hasUnseenNotification = (showAlert || editRequests.length > 0) && notificationSignal !== seenSignal;

  // 切到「教師/班級課表」分頁、或換了選到的小孩、或本學期班級變了，才查課表——
  // 不用每次切分頁都重查，同一個班級課表查過一次就夠。
  useEffect(() => {
    if (activeTab !== '課表' || !currentTerm?.class_id) return;
    loadSchedule(currentTerm.class_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, currentTerm?.class_id]);

  // 通知分頁的公佈欄最新公告，跟選了哪個小孩無關，登入後查一次就好。
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('bulletin_posts')
        .select('id, title, content, published_at')
        .eq('is_published', true)
        .order('published_at', { ascending: false })
        .limit(5);
      setBulletinPosts((data ?? []) as BulletinPost[]);
    })();
  }, []);

  function editRequestLabel(r: EditRequest) {
    const option = editableOptions.find((o) => o.fieldName === r.field_name && o.targetTable === r.target_table);
    return option?.label ?? `${r.target_table === 'guardians' ? '監護人' : '本人'} ${r.field_name}`;
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>家長／學生查詢入口</h1>

      {/* 【2026-08-26 新增】社團／才藝課選社（/portal/clubs）這個頁面本來就有，
          資料庫、選社邏輯都做好了，但這個入口頁完全沒有任何連結指向它——
          學生登入後不管怎麼點都找不到「社團設定」在哪裡，等於功能做了卻沒有
          入口，這正是「社團設定資料尚未看到」這個回饋的根因。這裡補上一個
          明顯的連結，不放進上面「成績／課表／通知」的分頁切換裡，是因為選社
          只有學生本人能操作（家長不行，見 /portal/clubs 頁面本身的說明），
          獨立成一個連結，點了才進去，跟其他分頁的「查詢」性質分開。 */}
      {!loadingAccounts && !loadError && linkedStudents.length > 0 && (
        <button
          type="button"
          onClick={() => router.push('/portal/clubs')}
          style={{
            display: 'inline-block',
            marginBottom: 16,
            padding: '8px 16px',
            background: '#2C2C2A',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          社團／才藝課選社 →
        </button>
      )}

      {linkedStudents.length > 1 && (
        <select
          value={selected?.id}
          onChange={(e) => setSelected(linkedStudents.find((s) => s.id === e.target.value) ?? null)}
          style={{ padding: 8, marginBottom: 16 }}
        >
          {linkedStudents.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.relation}）
            </option>
          ))}
        </select>
      )}

      {loadingAccounts && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}

      {loadError && (
        <p style={{ fontSize: 13, color: '#B3261E', background: '#FDECEA', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px' }}>
          ⚠️ {loadError}
        </p>
      )}

      {!loadingAccounts && !loadError && linkedStudents.length === 0 && (
        <p style={{ fontSize: 13, color: '#666', background: '#f5f5f4', border: '1px solid #e5e5e0', borderRadius: 8, padding: '12px 16px' }}>
          目前這個帳號還沒有綁定任何學生資料，請聯絡導師或學校確認登入代碼與信箱是否正確、
          或是否已經完成帳號綁定。
        </p>
      )}

      {selected && (
        <>
          {/* 頁面上方三個切換按鈕：成績／教師班級課表／通知 */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e5e0' }}>
            {(['成績', '課表', '通知'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 18px',
                  border: 'none',
                  borderBottom: activeTab === tab ? '2px solid #2C2C2A' : '2px solid transparent',
                  background: 'none',
                  fontSize: 14,
                  fontWeight: activeTab === tab ? 700 : 400,
                  color: activeTab === tab ? '#2C2C2A' : '#999',
                  cursor: 'pointer',
                }}
              >
                {tab === '課表' ? '教師/班級課表' : tab}
              </button>
            ))}
            {hasUnseenNotification && activeTab !== '通知' && (
              <span style={{ alignSelf: 'center', fontSize: 11, color: '#A36A2D' }}>● 通知有新內容</span>
            )}
          </div>

          {activeTab === '成績' && (
            <>
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>本學期各期成績和排名</h2>
                {currentTerm ? (
                  <>
                    <p style={{ fontSize: 13, marginBottom: 8, color: '#666' }}>
                      {currentTerm.academic_year}學年度 {currentTerm.term}　{currentTerm.grade_level}
                      {currentTerm.class_name}
                    </p>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: 6 }}></th>
                          <th style={{ textAlign: 'right', padding: 6 }}>總分</th>
                          <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
                          <th style={{ textAlign: 'right', padding: 6 }}>年級排名</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 6 }}>期中</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_total ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_class_rank ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.midterm_grade_rank ?? '尚未公布'}</td>
                        </tr>
                        <tr style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 6 }}>期末</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_total ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_class_rank ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.final_grade_rank ?? '尚未公布'}</td>
                        </tr>
                        <tr style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 6 }}>平時</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_total ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_class_rank ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.daily_grade_rank ?? '尚未公布'}</td>
                        </tr>
                        <tr style={{ borderTop: '1px solid #eee', fontWeight: 700 }}>
                          <td style={{ padding: 6 }}>總表</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.total_score ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.class_rank ?? '尚未公布'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{currentTerm.grade_rank ?? '尚未公布'}</td>
                        </tr>
                      </tbody>
                    </table>
                    <p style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                      總分／排名要導師送出並鎖定平時分後才會公布；期中/期末/平時各自的總分排名也遵循同一個時間點一起公布。
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: '#666' }}>目前沒有學期資料</p>
                )}
              </section>

              <section style={{ marginBottom: 24 }}>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>歷年成績</h2>
                <p style={{ fontSize: 11, color: '#999', marginBottom: 6 }}>點選「總分」可以展開看該學期各科成績。</p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 6 }}>學年度</th>
                      <th style={{ textAlign: 'left', padding: 6 }}>學期</th>
                      <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>期中</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>期末</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>平時</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>總表</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>班排名</th>
                      <th style={{ textAlign: 'right', padding: 6 }}>年級排名</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => {
                      // 【本輪新增】反映事項「歷年成績要出現期中、期末、平時、總表的各項分數，
                      // 點擊分數的時候要可以看到各科成績」——期中/期末/平時/總表這4個分數都做成
                      // 可點擊按鈕，點任一個都展開同一份「這個學期各科成績」明細（handleToggleTermScores
                      // 抓的是整個學期的 subject_weighted_scores，本來就含期中/期末/平時三欄，見下面
                      // 展開後的明細表），不用為每個項目分別做4套不同的展開邏輯。
                      const scoreButton = (label: string, value: number | null) =>
                        value !== null ? (
                          <button
                            type="button"
                            onClick={() => handleToggleTermScores(r.enrollment_id)}
                            style={{
                              border: 'none',
                              background: 'none',
                              padding: 0,
                              font: 'inherit',
                              color: '#2C2C2A',
                              fontWeight: label === '總表' ? 700 : 400,
                              textDecoration: 'underline',
                              cursor: 'pointer',
                            }}
                          >
                            {value} {label === '總表' ? (expandedId === r.enrollment_id ? '▲' : '▼') : ''}
                          </button>
                        ) : (
                          '—'
                        );
                      return (
                        <Fragment key={r.enrollment_id}>
                          <tr style={{ borderTop: '1px solid #eee' }}>
                            <td style={{ padding: 6 }}>{r.academic_year}</td>
                            <td style={{ padding: 6 }}>{r.term}</td>
                            <td style={{ padding: 6 }}>{r.grade_level}{r.class_name}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{scoreButton('期中', r.midterm_total)}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{scoreButton('期末', r.final_total)}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{scoreButton('平時', r.daily_total)}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{scoreButton('總表', r.total_score)}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{r.class_rank ?? '—'}</td>
                            <td style={{ padding: 6, textAlign: 'right' }}>{r.grade_rank ?? '—'}</td>
                          </tr>
                          {expandedId === r.enrollment_id && (
                            <tr key={`${r.enrollment_id}-detail`}>
                              <td colSpan={9} style={{ padding: '4px 6px 12px 24px', background: '#FAFAF8' }}>
                                {subjectScoresLoading === r.enrollment_id ? (
                                  <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>
                                ) : (subjectScores[r.enrollment_id]?.length ?? 0) > 0 ? (
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ textAlign: 'left', padding: 4 }}>科目</th>
                                        <th style={{ textAlign: 'right', padding: 4 }}>期中</th>
                                        <th style={{ textAlign: 'right', padding: 4 }}>期末</th>
                                        <th style={{ textAlign: 'right', padding: 4 }}>平時</th>
                                        <th style={{ textAlign: 'right', padding: 4 }}>科目成績</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {subjectScores[r.enrollment_id].map((s) => (
                                        <tr key={s.subject} style={{ borderTop: '1px solid #eee' }}>
                                          <td style={{ padding: 4 }}>{s.subject}</td>
                                          <td style={{ padding: 4, textAlign: 'right' }}>{s.midterm ?? '—'}</td>
                                          <td style={{ padding: 4, textAlign: 'right' }}>{s.final ?? '—'}</td>
                                          <td style={{ padding: 4, textAlign: 'right' }}>{s.daily ?? '—'}</td>
                                          <td style={{ padding: 4, textAlign: 'right' }}>
                                            {s.subject_weighted_score !== null ? s.subject_weighted_score.toFixed(2) : '—'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                ) : (
                                  <p style={{ fontSize: 12, color: '#999' }}>這個學期還沒有各科成績資料。</p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>歷年出缺勤彙總</h2>
                <p style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>點選次數可以看到相對應登記的日期。</p>
                {Object.entries(attendanceCounts).length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {Object.entries(attendanceCounts).map(([status, count]) => (
                      <div key={status}>
                        <button
                          type="button"
                          onClick={() => setExpandedAttendanceStatus(expandedAttendanceStatus === status ? null : status)}
                          style={{
                            fontSize: 13,
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #ddd',
                            background: expandedAttendanceStatus === status ? '#2C2C2A' : '#f5f5f4',
                            color: expandedAttendanceStatus === status ? '#fff' : '#333',
                            cursor: 'pointer',
                          }}
                        >
                          {status} {count}次
                        </button>
                        {expandedAttendanceStatus === status && (
                          <div style={{ marginTop: 4, padding: '6px 10px', border: '1px solid #eee', borderRadius: 6, background: '#fff' }}>
                            {(attendanceDates[status] ?? []).length > 0 ? (
                              <ul style={{ fontSize: 12, color: '#666', paddingLeft: 16, margin: 0 }}>
                                {(attendanceDates[status] ?? []).map((d) => (
                                  <li key={d}>{d}</li>
                                ))}
                              </ul>
                            ) : (
                              <p style={{ fontSize: 12, color: '#999', margin: 0 }}>沒有登記的日期。</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: 13 }}>全勤或尚無紀錄</p>
                )}
              </section>
            </>
          )}

          {activeTab === '課表' && (
            <section>
              <h2 style={{ fontSize: 14, marginBottom: 8 }}>教師/班級課表</h2>
              {currentTerm ? (
                <p style={{ fontSize: 13, marginBottom: 8, color: '#666' }}>
                  {currentTerm.academic_year}學年度 {currentTerm.term}　{currentTerm.grade_level}
                  {currentTerm.class_name}
                </p>
              ) : (
                <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>目前沒有在學的班級資料。</p>
              )}
              {scheduleLoading && <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>}
              {scheduleError && <p style={{ fontSize: 13, color: '#B3261E' }}>⚠️ {scheduleError}</p>}
              {!scheduleLoading && !scheduleError && currentTerm && (
                scheduleRows.length > 0 ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 480 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: 6, borderBottom: '1px solid #e5e5e0' }}>節次</th>
                          {WEEKDAY_LABELS.map((d) => (
                            <th key={d} style={{ textAlign: 'center', padding: 6, borderBottom: '1px solid #e5e5e0' }}>
                              星期{d}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(new Set(scheduleRows.map((r) => r.period_no)))
                          .sort((a, b) => a - b)
                          .map((period) => (
                            <tr key={period} style={{ borderTop: '1px solid #eee' }}>
                              <td style={{ padding: 6, fontWeight: 700 }}>第{period}節</td>
                              {WEEKDAY_LABELS.map((_, i) => {
                                const cell = scheduleRows.find((r) => r.weekday === i + 1 && r.period_no === period);
                                return (
                                  <td key={i} style={{ padding: 6, textAlign: 'center' }}>
                                    {cell ? (
                                      <>
                                        {cell.subject}
                                        <br />
                                        <span style={{ fontSize: 10, color: '#999' }}>{cell.teacher_name}</span>
                                      </>
                                    ) : (
                                      ''
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: '#666' }}>目前還沒有排課資料。</p>
                )
              )}
            </section>
          )}

          {activeTab === '通知' && (
            <>
              {showAlert && (
                <section
                  style={{
                    marginBottom: 24,
                    padding: 16,
                    background: '#FBEFE9',
                    border: '2px solid #A36A2D',
                    borderRadius: 8,
                  }}
                >
                  <p style={{ fontSize: 20, fontWeight: 700, color: '#A36A2D', marginBottom: 4 }}>
                    ⚠ 出缺席提醒：事假＋病假＋曠課累計 {absencePeriods} 節
                  </p>
                  <p style={{ fontSize: 13, color: '#A36A2D' }}>已達學校示警門檻的一半，請多留意孩子的出缺席狀況。</p>
                </section>
              )}

              <section style={{ marginBottom: 24 }}>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>修改資料申請進度</h2>
                {editRequests.length > 0 ? (
                  <ul style={{ fontSize: 13, color: '#666', paddingLeft: 18 }}>
                    {editRequests.map((r) => (
                      <li key={r.id} style={{ marginBottom: 4 }}>
                        {editRequestLabel(r)} → {r.new_value}（{r.status}）
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ fontSize: 13, color: '#999' }}>目前沒有申請中的修改資料紀錄。</p>
                )}
              </section>

              <section>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>學校公告</h2>
                {bulletinPosts.length > 0 ? (
                  <ul style={{ fontSize: 13, color: '#333', paddingLeft: 0, listStyle: 'none' }}>
                    {bulletinPosts.map((p) => (
                      <li key={p.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
                        <p style={{ fontWeight: 700, marginBottom: 2 }}>{p.title}</p>
                        {p.published_at && (
                          <p style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>
                            {new Date(p.published_at).toLocaleDateString('zh-TW')}
                          </p>
                        )}
                        <p style={{ fontSize: 12, color: '#666' }}>{p.content}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ fontSize: 13, color: '#999' }}>目前沒有公告。</p>
                )}
              </section>
            </>
          )}

          <section style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #e5e5e0' }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>監護人資料</h2>
            {guardians.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>關係</th>
                    <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                    <th style={{ textAlign: 'left', padding: 6 }}>電話</th>
                  </tr>
                </thead>
                <tbody>
                  {guardians.map((g) => (
                    <tr key={g.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 6 }}>{g.relation}</td>
                      <td style={{ padding: 6 }}>{g.name ?? '—'}</td>
                      <td style={{ padding: 6 }}>{g.phone ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 13, color: '#999' }}>尚無監護人資料，如需新增請聯絡導師。</p>
            )}
          </section>

          <section style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 14, marginBottom: 8 }}>修改基本資料</h2>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              送出後導師會立即收到通知，需經導師核准才會正式更新，核准前畫面上顯示的仍是原本的資料，申請進度可以到上面的「通知」分頁查看。
            </p>
            <form onSubmit={handleSubmitEdit} style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <select value={editKey} onChange={(e) => setEditKey(e.target.value)} style={{ padding: 8 }}>
                {editableOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                placeholder={`新的${editableOptions.find((o) => o.key === editKey)?.label ?? ''}`}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={{ padding: 8, flex: 1, minWidth: 160 }}
                required
              />
              <button type="submit" style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
                送出申請
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
