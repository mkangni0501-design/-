import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardData, ReportCardStyleConfig, TermBlock, DEFAULT_REPORT_CARD_STYLE } from '@/lib/ReportCardDocument';
import path from 'path';

const SCHOOL_NAME = '泰國清萊雲南會館附屬華雲學校'; // 依實際校名調整

// 校徽／校園照片的內建預設值（真實圖檔，來自你提供的「外頁修正.xlsx」內嵌圖片，
// 見 public/images/school-logo.png／campus-photo.jpg）。這裡組路徑用 'path' 這個
// Node.js 專用模組沒問題——這個檔案（lib/reportCard.ts）本來就只給伺服器端的
// API Route 用（因為要用 supabaseAdmin 的服務金鑰，本來就不能被瀏覽器端引用），
// 不會被打包進瀏覽器的程式碼。管理員如果之後在【成績單樣式設定】頁自己上傳了
// 圖片，會優先使用管理員上傳的，這裡的內建預設值只在管理員還沒上傳時當底。
function defaultImagePaths() {
  const dir = path.join(process.cwd(), 'public', 'images');
  return { logoUrl: path.join(dir, 'school-logo.png'), campusPhotoUrl: path.join(dir, 'campus-photo.jpg') };
}

// 目前生效中的成績單樣式設定（顏色/字級/邊框/文字標籤，不含資料綁定，見
// components/admin-tabs/ReportCardStyleTab.tsx／sql/46wire_attendance_and_discipline_adjustments.sql
// 新增的 report_card_style 表）。管理員還沒上傳過自訂樣式時，回傳內建預設值。
export async function getActiveReportCardStyle(): Promise<ReportCardStyleConfig> {
  const defaults = defaultImagePaths();
  const { data } = await supabaseAdmin.from('report_card_style').select('config').eq('is_active', true).maybeSingle();
  if (!data?.config) {
    return { ...DEFAULT_REPORT_CARD_STYLE, layout: { ...DEFAULT_REPORT_CARD_STYLE.layout, ...defaults } };
  }
  // 用預設值當底，讓管理員上傳的設定檔即使漏了某些欄位也不會整份壞掉（只覆蓋有填的部分）。
  const layoutFromDb = (data.config as any).layout ?? {};
  return {
    colors: { ...DEFAULT_REPORT_CARD_STYLE.colors, ...(data.config as any).colors },
    sizes: { ...DEFAULT_REPORT_CARD_STYLE.sizes, ...(data.config as any).sizes },
    labels: { ...DEFAULT_REPORT_CARD_STYLE.labels, ...(data.config as any).labels },
    layout: {
      ...DEFAULT_REPORT_CARD_STYLE.layout,
      ...defaults,
      ...layoutFromDb,
      // layoutFromDb 裡如果 logoUrl/campusPhotoUrl 是空字串（管理員上傳過又移除），
      // 上面 ...layoutFromDb 展開後會蓋回空字串，這裡再補一次「空字串就用內建預設」，
      // 確保「移除自訂圖片」之後會自動退回真的校徽/照片，不會變成完全沒有圖。
      logoUrl: layoutFromDb.logoUrl || defaults.logoUrl,
      campusPhotoUrl: layoutFromDb.campusPhotoUrl || defaults.campusPhotoUrl,
    },
  };
}

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

  // 期中/期末/平時 各佔比重（%），成績單科目表格的「35% 35% 30% 100%」那一列
  // 用得到，直接抓 grading_rules，跟成績單「外頁」封面頁那組數字（buildPolicySummary）
  // 同一個資料來源，不會兩邊數字對不起來。
  const { data: gradingRow } = await supabaseAdmin
    .from('grading_rules')
    .select('midterm_weight, final_weight, daily_weight')
    .eq('academic_year', cls.academic_year)
    .eq('term', enrollment.term)
    .maybeSingle();
  const stageWeights = gradingRow
    ? {
        midterm: Number(gradingRow.midterm_weight) * 100,
        final: Number(gradingRow.final_weight) * 100,
        daily: Number(gradingRow.daily_weight) * 100,
      }
    : null;

  // 期中/期末/平時 個別鎖定狀態（sql/47ranking_average_discipline_access_partial_report_card.sql
  // 新增的 report_card_exam_type_locks()）。過去這裡只查「三項是否全部鎖定」的單一
  // 布林值（ready），任何一項還沒鎖，整份成績單（含已經鎖定的部分）都會是空白——
  // 這正是這次反映「期中/期末/平時沒有個人的列印，只有'全部'時能印」的根因。
  // 改成分開查三項，已鎖定的部分正常顯示數字，還沒鎖定的部分維持空白，兩者互不影響。
  const { data: locks } = await supabaseAdmin.rpc('report_card_exam_type_locks', { p_enrollment_id: enrollmentId });
  const lockRow = Array.isArray(locks) ? locks[0] : locks;
  const midLocked = !!lockRow?.mid_locked;
  const finLocked = !!lockRow?.fin_locked;
  const dayLocked = !!lockRow?.day_locked;
  // fullyReady：三項都鎖定，只有這個狀態下「學業平均-總分」「全班排名」這類需要
  // 三項合併才有意義的欄位才會顯示；ready（單一項有鎖定就算）則用來判斷這個學期
  // 「還有沒有任何東西可以先印出來」。
  const fullyReady = midLocked && finLocked && dayLocked;
  const ready = midLocked || finLocked || dayLocked;

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
  // 【2026-08-17 修正】sql/48fix_attendance_score_formula.sql 已經把「全勤」／「出缺席」
  // 改成跟其他科目一樣，正常走加權平均那條路徑（不再是額外加減的調整值，見該檔案
  // 說明），這裡原本沿用 sql/46 時代「這個科目不能出現在清單裡，不然會重複計算」的
  // 排除邏輯已經過時──sql/48 之後，這個科目本來就應該像其他科目一樣正常顯示在
  // 成績單的科目列表跟「比重」欄位上（顯示出缺席%），不排除了。
  const visibleSubjects = (subjectRows ?? [])
    .filter((s: any) => (weightBySubject.get(s.subject) ?? 0) > 0)
    .sort((a: any, b: any) => (weightBySubject.get(b.subject) ?? 0) - (weightBySubject.get(a.subject) ?? 0));

  // 學業平均：期中/期末/平時各自的「依科目比重加權平均」＝ student_examtype_totals
  // 的 {type}_average 欄位（sql/45swap_total_and_average_formulas.sql 對調公式之後，
  // _average 才是加權平均、_total 是直接加總）；總分那一欄則是 student_total_scores
  // 的 total_score——兩者都已經是「乘上比重」的結果，不用在這裡重新加總一次。
  // 【2026-08-17 修正】這裡原本只 select 了 _total 三個欄位，沒有把 _average 三個欄位
  // 一起查出來，導致底下 academicAverage.midterm/final/daily 永遠讀不到值、成績單上
  // 學業平均那一列一直是空白——這是「期中/期末/平時分數沒有顯示」反映事項的直接原因。
  const { data: examtypeTotals } = await supabaseAdmin
    .from('student_examtype_totals')
    .select('midterm_total, final_total, daily_total, midterm_average, final_average, daily_average')
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
  // 出缺席分數：改用 sql/48fix_attendance_score_formula.sql 新增的 attendance_score()，
  // 跟排名/總分實際採用的公式是同一支函式（該函式的結果會乘上科目比重3%後計入
  // 期中/期末/平時，見該檔案說明），成績單上顯示的數字才會跟實際拿去算總分/排名的
  // 數字一致。全勤（這學期完全沒有曠課/遲到/病假/事假/公假紀錄）才是100分；只要
  // 有任何一筆紀錄，直接顯示扣分點數加總後的原始值（可以是很大的負數，不會有
  // 「以100分為底再扣、最低0分」這種下限——那是先前版本的錯誤理解，100分只有
  // 真正全勤的人才有）。
  const { data: attendanceScoreRaw } = await supabaseAdmin.rpc('attendance_score', { p_enrollment_id: enrollmentId });
  const attendanceScore = attendanceScoreRaw === null || attendanceScoreRaw === undefined ? null : Number(attendanceScoreRaw);

  // 操行成績＝禮貌/衣著/服務/紀律的平均，再加減懲獎點數（3e）。
  const { data: disciplineAdj } = await supabaseAdmin.rpc('discipline_adjustment', { p_enrollment_id: enrollmentId });

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
    // 操行成績＝四個分項的平均，再加減懲獎點數（3e）；四個分項都沒填時維持 null
    // （沒有任何基準分數可以加減，不要顯示成 0 或負數）。
    overall: conductValues.length > 0 ? conductValues.reduce((a, b) => a + b, 0) / conductValues.length + Number(disciplineAdj ?? 0) : null,
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
    academicAverage: {
      // 學業平均＝依各科比重加權平均，見 sql/45swap_total_and_average_formulas.sql——
      // 期中/期末/平時三欄各自只看「這一項自己」有沒有鎖定，不再互相牽連；「總分」
      // 欄需要三項都有數字加總才有意義，所以維持只在 fullyReady（三項都鎖定）時顯示。
      midterm: midLocked ? examtypeTotals?.midterm_average ?? null : null,
      final: finLocked ? examtypeTotals?.final_average ?? null : null,
      daily: dayLocked ? examtypeTotals?.daily_average ?? null : null,
      total: fullyReady ? totalRow?.total_score ?? null : null,
    },
    // 出缺勤／懲獎／操行分數不是「考試成績」，跟期中/期末/平時有沒有鎖定無關（本來
    // 就是整個學期持續累計的紀錄），過去被一起綁在 ready 底下、要等三項都鎖定才
    // 顯示，是不必要的限制，這裡改成只要這個學期本身查得到資料就顯示。
    attendance: attendanceCounts,
    isPerfectAttendance,
    attendanceScore,
    discipline: disciplineCounts,
    conduct,
    classSize: classSize ?? null,
    // 全班排名：跟「學業平均-總分」一樣，需要三項都鎖定、總分才穩定，維持只在
    // fullyReady 時顯示，避免印出「還會再變動」的排名讓人誤會是正式名次。
    classRank: fullyReady ? classRankValue ?? null : null,
    stageWeights,
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

  // 改成「只要期中/期末/平時至少有一項鎖定」就先讓成績單可以產出（已鎖定的部分
  // 正常顯示，還沒鎖定的部分維持空白——見 buildTermBlock 的說明），對應這次反映
  // 「'期中'、'期末'、'平時'沒有個人的列印，只有在'全部'時能印成績單」。
  // 三項都還沒有任何一項鎖定時，才真的沒有東西可以印，這時才擋下來並說明原因。
  const { data: anyLocked } = await supabaseAdmin.rpc('report_card_any_locked', { p_enrollment_id: enrollmentId });
  if (!anyLocked) {
    return { ready: false, studentNo, studentName, reason: '期中考／期末考／平時分尚未有任一項鎖定，目前沒有已完成的成績可以列印' };
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

  // 成績單「外頁」（封面說明頁）：操行等第標準、獎懲加扣分、學業成績佔比、出缺席
  // 加扣分，這幾組數字全部從資料庫現有設定抓，不是寫死的文字——之後在【整體佔比與
  // 加扣分規則】【科目與比重設定】頁調整這些數字，成績單封面會自動跟著變，不用
  // 每次改了都要另外找人改成績單樣板。見 buildPolicySummary() 的說明。
  const policy = await buildPolicySummary(cls.academic_year, enrollment.term, cls.grade_level);

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
      policy,
    },
  };
}

// 成績單封面說明頁用的動態資料：獎懲點數（conduct_point_defaults）、學業成績佔比
// （grading_rules）、出缺席比重與扣分點數（curriculum 的「全勤／出缺席」科目 +
// conduct_point_defaults）。任何一組資料庫裡查不到時，對應欄位維持 null，封面頁
// 那一行就不印出來，不會印出「undefined」或錯誤的假數字。
async function buildPolicySummary(academicYear: number, term: string, gradeLevel: string) {
  const { data: conductRows } = await supabaseAdmin.from('conduct_point_defaults').select('item, points');
  const conductMap: Record<string, number> = {};
  (conductRows ?? []).forEach((r: any) => (conductMap[r.item] = Number(r.points)));

  const { data: gradingRow } = await supabaseAdmin
    .from('grading_rules')
    .select('midterm_weight, final_weight, daily_weight')
    .eq('academic_year', academicYear)
    .eq('term', term)
    .maybeSingle();

  const { data: attendanceCurriculum } = await supabaseAdmin
    .from('curriculum')
    .select('subject, weight')
    .eq('academic_year', academicYear)
    .eq('term', term)
    .eq('grade_level', gradeLevel)
    .in('subject', ['全勤', '出缺席'])
    .gt('weight', 0)
    .order('subject', { ascending: false }) // 「出缺席」優先於「全勤」，跟 sql/48 的防呆邏輯一致
    .limit(1)
    .maybeSingle();
  const attendanceWeight = attendanceCurriculum ? Number(attendanceCurriculum.weight) : null;

  // 每一項換算成「最終影響總分的百分比」＝原始分數 × 出缺席比重，跟成績單「學業
  // 平均」欄位實際採用的公式（sql/48fix_attendance_score_formula.sql）一致，這裡
  // 印出來的百分比數字，跟真正拿去算總分的邏輯保證是同一套。
  // 【2026-08-21 修正】attendanceWeight 本身已經是小數（例如3%存成0.03），
  // rawScore × attendanceWeight 這一步算出來就已經是「百分比點數」本身
  // （例如 100 × 0.03 = 3，意思是「+3個百分點」），不需要再乘一次100——上一輪
  // 這裡多乘了一次100，導致全勤印成「+300%」而不是「+3%」，曠課等其餘幾項因為
  // 數字本身很小（-0.1、-0.02...），多乘100後的視覺落差沒那麼誇張，比較不容易
  // 一眼看出來，這輪你比對「全勤」那一項才抓到。
  const attendanceItem = (name: string, rawScore: number | null) => ({
    name,
    rawScore,
    percentOfTotal: rawScore !== null && attendanceWeight !== null ? rawScore * attendanceWeight : null,
  });

  return {
    conduct: {
      merit1: conductMap['嘉獎'] ?? null,
      demerit1: conductMap['警告'] ?? null,
      merit3: conductMap['小功'] ?? null,
      demerit3: conductMap['小過'] ?? null,
      merit9: conductMap['大功'] ?? null,
      demerit9: conductMap['大過'] ?? null,
    },
    academicWeights: {
      midterm: gradingRow ? Number(gradingRow.midterm_weight) * 100 : null,
      final: gradingRow ? Number(gradingRow.final_weight) * 100 : null,
      daily: gradingRow ? Number(gradingRow.daily_weight) * 100 : null,
    },
    attendanceWeightPercent: attendanceWeight !== null ? attendanceWeight * 100 : null,
    attendance: [
      attendanceItem('全勤', 100),
      attendanceItem('曠課', conductMap['曠課'] ?? null),
      attendanceItem('遲到', conductMap['遲到'] ?? null),
      attendanceItem('事假', conductMap['事假'] ?? null),
      attendanceItem('病假', conductMap['病假'] ?? null),
      attendanceItem('公假', conductMap['公假'] ?? null),
    ],
  };
}
