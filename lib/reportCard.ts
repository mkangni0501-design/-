import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardData, TermBlock } from '@/lib/ReportCardDocument';

const SCHOOL_NAME = '泰國清萊雲南會館附屬華雲學校'; // 依實際校名調整

// 誰可以產出/預覽一個班的成績單：管理員S/A/B、教務處成員、該班導師本人。
// app/api/reports/report-card/[enrollmentId]/route.tsx 跟 batch/route.tsx 都會呼叫
// 這支函式做權限檢查（用登入者的 auth.uid()，不是用 current_role_name() 那些讀
// session 的資料庫函式——這裡是從 API route 用 supabaseAdmin 直接查表，同樣不受
// 「service_role 呼叫時 auth.uid() 是 null」影響，因為呼叫者身份是從已經驗證過的
// access token 解出來的 callerAuth.user.id，用參數傳進來，不是靠資料庫 session）。
export async function canAccessClass(userId: string, classId: string): Promise<boolean> {
  const { data: appUser } = await supabaseAdmin.from('app_users').select('role').eq('id', userId).maybeSingle();
  if (appUser && ['admin_a', 'admin_b', 'system_admin_s'].includes(appUser.role)) return true;

  const { data: teacher } = await supabaseAdmin.from('teachers').select('id').eq('app_user_id', userId).maybeSingle();
  if (!teacher) return false;

  const { data: dept } = await supabaseAdmin
    .from('app_user_departments')
    .select('department')
    .eq('app_user_id', userId)
    .eq('department', 'academic')
    .maybeSingle();
  if (dept) return true;

  const { data: cls } = await supabaseAdmin.from('classes').select('homeroom_teacher_id').eq('id', classId).maybeSingle();
  return !!cls && cls.homeroom_teacher_id === teacher.id;
}

export type ReportCardResult =
  | { ready: true; data: ReportCardData; studentNo: string; studentName: string }
  | { ready: false; studentNo: string; studentName: string; reason: string };

const TERMS = ['上學期', '下學期'] as const;
const ATTENDANCE_ITEMS = ['曠課', '遲到', '病假', '事假', '公假'] as const;
const DISCIPLINE_ITEMS = ['嘉獎', '小功', '大功', '警告', '小過', '大過'] as const;

// 單一學生、單一學期：組出「成績通知書」裡一個學期需要的所有資料（科目成績、
// 該學期的出席/懲獎、班排名/班人數）。學年成績通知書會呼叫這支函式各一次，
// 分別拿上學期/下學期的資料，兩份合併成一張表。
async function buildTermBlock(enrollmentId: string): Promise<TermBlock | null> {
  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, term, class_id, classes(academic_year, grade_level)')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (!enrollment) return null;
  const cls = (enrollment as any).classes;

  const { data: ready } = await supabaseAdmin.rpc('report_card_ready', { p_enrollment_id: enrollmentId });

  const { data: subjectRows } = await supabaseAdmin
    .from('subject_weighted_scores')
    .select('subject, midterm, final, daily, subject_weighted_score')
    .eq('enrollment_id', enrollmentId);

  // 比重=0（已停開/停用）的科目，成績單不應該出現——subject_weighted_scores 本身沒有
  // 排除，這裡另外查一次 curriculum 過濾掉，並依比重高到低排序（跟成績登錄頁、
  // 班級成績總表的排序規則一致）。
  const { data: curriculumRows } = await supabaseAdmin
    .from('curriculum')
    .select('subject, weight')
    .eq('academic_year', cls.academic_year)
    .eq('term', enrollment.term)
    .eq('grade_level', cls.grade_level);
  const weightBySubject = new Map((curriculumRows ?? []).map((r: any) => [r.subject, Number(r.weight)]));
  const visibleSubjects = (subjectRows ?? [])
    .filter((s: any) => (weightBySubject.get(s.subject) ?? 0) > 0)
    .sort((a: any, b: any) => (weightBySubject.get(b.subject) ?? 0) - (weightBySubject.get(a.subject) ?? 0));

  // 學業平均：期中/期末/平時各自的「依科目比重加權平均」＝ student_examtype_totals
  // 算好的 {type}_total（sql/41score_entry_fixes.sql），總分那一欄則是 student_total_scores
  // 的 total_score——兩者都已經是「乘上比重」的結果，不用在這裡重新加總一次。
  const { data: examtypeTotals } = await supabaseAdmin
    .from('student_examtype_totals')
    .select('midterm_total, final_total, daily_total')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle();
  const { data: totalRow } = await supabaseAdmin
    .from('student_total_scores')
    .select('total_score')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle();

  // 出席記錄／懲獎記錄：一定要用這個學期的日期範圍篩選（academic_terms 起訖日），
  // 原本的寫法完全沒有篩日期／學期，會把這個學生一輩子的紀錄全部算進來。
  const { data: termRow } = await supabaseAdmin
    .from('academic_terms')
    .select('term_start_date, term_end_date')
    .eq('academic_year', cls.academic_year)
    .eq('term', enrollment.term)
    .maybeSingle();

  const { data: studentRow } = await supabaseAdmin
    .from('enrollments')
    .select('student_no')
    .eq('id', enrollmentId)
    .single();
  const studentNo = (studentRow as any)?.student_no;

  const attendanceCounts: Record<(typeof ATTENDANCE_ITEMS)[number], number> = {
    曠課: 0,
    遲到: 0,
    病假: 0,
    事假: 0,
    公假: 0,
  };
  if (termRow?.term_start_date && termRow?.term_end_date && studentNo) {
    const { data: attRows } = await supabaseAdmin
      .from('attendance')
      .select('status')
      .eq('student_no', studentNo)
      .gte('record_date', termRow.term_start_date)
      .lte('record_date', termRow.term_end_date)
      .neq('status', '出席');
    (attRows ?? []).forEach((r: any) => {
      if (r.status in attendanceCounts) attendanceCounts[r.status as (typeof ATTENDANCE_ITEMS)[number]] += 1;
    });
  }
  const isPerfectAttendance = ATTENDANCE_ITEMS.every((k) => attendanceCounts[k] === 0);

  const disciplineCounts: Record<(typeof DISCIPLINE_ITEMS)[number], number> = {
    嘉獎: 0,
    小功: 0,
    大功: 0,
    警告: 0,
    小過: 0,
    大過: 0,
  };
  if (termRow?.term_start_date && termRow?.term_end_date && studentNo) {
    const { data: eventRows } = await supabaseAdmin
      .from('conduct_events')
      .select('event_type')
      .eq('student_no', studentNo)
      .gte('event_date', termRow.term_start_date)
      .lte('event_date', termRow.term_end_date);
    (eventRows ?? []).forEach((r: any) => {
      if (r.event_type in disciplineCounts) disciplineCounts[r.event_type as (typeof DISCIPLINE_ITEMS)[number]] += 1;
    });
  }

  const { count: classSize } = await supabaseAdmin
    .from('enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('class_id', enrollment.class_id)
    .eq('term', enrollment.term);

  const { data: classRankValue } = await supabaseAdmin.rpc('report_card_class_rank', { p_enrollment_id: enrollmentId });

  // 操行成績「禮貌／衣著／服務／紀律」：見 sql/44fix_report_card_and_ranking_performance.sql
  // 新增的 conduct_scores 表（你確認要另外開發評分介面後新增，components/admin-tabs/ConductScoresTab.tsx
  // 是導師/管理員輸入的地方）。「操行成績」本身＝這四個分項的平均，四個都沒填就是
  // null（不是0）——用樣本驗證過這個平均公式：禮貌80/衣著70/服務60/紀律50 平均剛好
  // 是樣本上顯示的65。
  const { data: conductRow } = await supabaseAdmin
    .from('conduct_scores')
    .select('politeness, dress, service, discipline')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle();
  const conductValues = [conductRow?.politeness, conductRow?.dress, conductRow?.service, conductRow?.discipline].filter(
    (v): v is number => v !== null && v !== undefined
  );
  const conduct = {
    politeness: conductRow?.politeness ?? null,
    dress: conductRow?.dress ?? null,
    service: conductRow?.service ?? null,
    discipline: conductRow?.discipline ?? null,
    overall: conductValues.length > 0 ? conductValues.reduce((a, b) => a + b, 0) / conductValues.length : null,
  };

  return {
    ready: !!ready,
    subjects: visibleSubjects.map((s: any) => ({
      subject: s.subject,
      weight: weightBySubject.get(s.subject) ?? 0,
      midterm: s.midterm,
      final: s.final,
      daily: s.daily,
      total: s.subject_weighted_score,
    })),
    academicAverage: ready
      ? {
          // 學業平均＝依各科比重加權平均，見 sql/45swap_total_and_average_formulas.sql——
          // 原本讀 _total 欄位（sql/41 當初把 total/average 兩個公式寫反了，這裡對調
          // 過來後改讀 _average 欄位，數字結果不變，仍然對得起你原本 AI.xlsx 樣本的
          // 77.25／80 那組數字）。
          midterm: examtypeTotals?.midterm_average ?? null,
          final: examtypeTotals?.final_average ?? null,
          daily: examtypeTotals?.daily_average ?? null,
          total: totalRow?.total_score ?? null,
        }
      : { midterm: null, final: null, daily: null, total: null },
    attendance: attendanceCounts,
    isPerfectAttendance,
    discipline: disciplineCounts,
    conduct,
    classSize: classSize ?? null,
    classRank: ready ? classRankValue ?? null : null,
  };
}

// 一個學生：組出「學年成績通知書」需要的完整資料——上學期／下學期各自一個 TermBlock
// （哪個學期還沒有資料，那個學期就整個是 null，畫面上對應欄位維持空白，不會是 0 或
// 錯誤訊息；下學期的資料還沒建立前，本來就應該是空白，等下學期開始才會有）。
// ready 的判斷維持跟過去一樣：只有「本次要印的這個學期」三項都鎖定，才視為可以正式
// 產出（另一個學期不論有沒有鎖定，都只是「還沒有資料/還沒鎖定」單純空白顯示，不會擋住
// 這學期先印）。
export async function getReportCardResult(enrollmentId: string): Promise<ReportCardResult> {
  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, seat_no, term, student_no, class_id, students(student_no, name), classes(id, class_name, grade_level, academic_year, homeroom_teacher_id)')
    .eq('id', enrollmentId)
    .single();

  if (!enrollment) {
    return { ready: false, studentNo: '', studentName: '', reason: '查無此學生的學籍資料' };
  }

  const student = (enrollment as any).students;
  const cls = (enrollment as any).classes;
  const studentNo = student?.student_no ?? '';
  const studentName = student?.name ?? '';

  const { data: ready } = await supabaseAdmin.rpc('report_card_ready', { p_enrollment_id: enrollmentId });
  if (!ready) {
    return { ready: false, studentNo, studentName, reason: '期中/期末/平時分尚未三項都鎖定' };
  }

  // 找同一個學生、同一個學年度的另一個學期學籍（可能還不存在——下學期還沒開始就是這樣）。
  const { data: siblingEnrollments } = await supabaseAdmin
    .from('enrollments')
    .select('id, term, classes!inner(academic_year)')
    .eq('student_no', studentNo)
    .eq('classes.academic_year', cls.academic_year);

  const enrollmentIdByTerm: Record<string, string> = {};
  (siblingEnrollments ?? []).forEach((r: any) => {
    enrollmentIdByTerm[r.term] = r.id;
  });

  const [springBlock, fallBlock] = await Promise.all(
    TERMS.map((t) => (enrollmentIdByTerm[t] ? buildTermBlock(enrollmentIdByTerm[t]) : Promise.resolve(null)))
  );
  const termBlocks: Record<(typeof TERMS)[number], TermBlock | null> = {
    上學期: springBlock,
    下學期: fallBlock,
  };

  const { data: remarkRow } = await supabaseAdmin.from('student_remarks').select('comment').eq('enrollment_id', enrollmentId).maybeSingle();

  return {
    ready: true,
    studentNo,
    studentName,
    data: {
      school: SCHOOL_NAME,
      academicYear: cls.academic_year,
      currentTerm: enrollment.term,
      gradeLevel: cls.grade_level,
      className: cls.class_name,
      studentNo,
      studentName,
      seatNo: enrollment.seat_no,
      terms: termBlocks,
      remark: remarkRow?.comment ?? '',
      printedAt: new Date().toISOString(),
    },
  };
}
