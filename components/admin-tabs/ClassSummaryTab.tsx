'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { getHiddenStudentNos } from '@/lib/hiddenStudents';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { isDepartmentLead } from '@/lib/departments';
import { downloadClassScoreExcel } from '@/lib/excelTemplates';
import { estimateTermStart } from '@/lib/academicTerm';
import { showPdfInWindow } from '@/lib/pdfPreview';

type SubjectRow = { enrollment_id: string; subject: string; midterm: number | null; final: number | null; daily: number | null };
type RankRow = {
  enrollment_id: string;
  total_score: number;
  class_rank?: number;
  midterm_total?: number | null;
  midterm_class_rank?: number | null;
  midterm_average?: number | null;
  final_total?: number | null;
  final_class_rank?: number | null;
  final_average?: number | null;
  daily_total?: number | null;
  daily_class_rank?: number | null;
  daily_average?: number | null;
};
type GradeRankRow = {
  grade_rank?: number;
  midterm_grade_rank?: number | null;
  final_grade_rank?: number | null;
  daily_grade_rank?: number | null;
};
type EnrollRow = { id: string; seat_no: number; name: string; student_no: string };
// 跟「獎懲登記」頁一致的六種類別，顯示順序固定（大功最重→警告最輕）
const CONDUCT_TYPE_ORDER = ['大功', '小功', '嘉獎', '警告', '小過', '大過'];
type ClassOption = { id: string; label: string; grade_level: string };

const SUBJECT_DIVIDER = '2px solid #2C2C2A'; // 每一科分數中間：粗體間隔線
const EXAMTYPE_DIVIDER = '1px dotted #ccc'; // 科目項下的期中/期末/平時：細線間隔
// 第一列標題列的高度估計值，第二列標題用這個當 top 位移，固定在第一列正下方。
const CS_HEADER_ROW1_DEFAULT_HEIGHT = 33;
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
// 該次考試「有登錄成績的科目」原始分數平均（跟乘上比重後的總分分開顯示，見 sql/41score_entry_fixes.sql）
const EXAM_TYPE_AVERAGE_FIELD: Record<'期中考' | '期末考' | '平時分', 'midterm_average' | 'final_average' | 'daily_average'> = {
  期中考: 'midterm_average',
  期末考: 'final_average',
  平時分: 'daily_average',
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
  const [gradeLevel, setGradeLevel] = useState<string | null>(null);
  const [isHomeroom, setIsHomeroom] = useState(false);
  // 期中考／期末考／平時分：各自獨立查詢是否已鎖定（用 submission_window_locked() 這個
  // 有考慮「班級 > 部別 > 全校」層層 fallback、也有考慮 closes_at 時間到自動鎖定的函式，
  // 不能只查「這個班自己有沒有設定」——不然管理員在部別/全校層級鎖定、或設定的開放時間
  // 已經過了，這裡會誤判成「還沒鎖定」，繼續讓導師以為需要自己再按一次鎖定。）
  const [lockedByType, setLockedByType] = useState<Record<'期中考' | '期末考' | '平時分', boolean>>({
    期中考: false,
    期末考: false,
    平時分: false,
  });
  // 鎖定狀態查詢完成前，先不要把「還沒查到 = false」直接當成「沒鎖定 = 顯示可以點的按鈕」，
  // 不然重新整理頁面時會先閃一下三個都「可以點」的按鈕，等查詢回來後才一起跳成正確狀態，
  // 看起來像三個按鈕綁在一起同步跳動。查詢完成前這裡改顯示「讀取中」，不顯示按鈕本身。
  const [locksLoaded, setLocksLoaded] = useState(false);
  const [locking, setLocking] = useState<'' | '期中考' | '期末考' | '平時分'>('');
  const [enrollments, setEnrollments] = useState<EnrollRow[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subjectData, setSubjectData] = useState<Record<string, Record<string, SubjectRow>>>({}); // enrollment_id -> subject -> row
  const [classRank, setClassRank] = useState<Record<string, RankRow>>({});
  const [gradeRank, setGradeRank] = useState<Record<string, GradeRankRow>>({});
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [subjectWeights, setSubjectWeights] = useState<Record<string, number>>({}); // 科目 -> 比重(0~1)，顯示在科目欄位上方的科目%用
  // enrollment_id -> 依真實出缺勤紀錄自動算出的「出缺席」分數（100 加上倒扣，最低0）。
  // 「全勤」／「出缺席」這個科目欄位改用這裡的值顯示，不用 subjectData 裡老師手動輸入
  // 的原始分數（那筆分數不會被排名/總分採用，見 sql/46wire_attendance_and_discipline_adjustments.sql）。
  const [attendanceAdjustments, setAttendanceAdjustments] = useState<Record<string, number>>({});
  // student_no -> 這學期獎懲類別次數＋加總點數，見下面載入 conduct_events 那段的說明
  const [conductByStudent, setConductByStudent] = useState<Record<string, { counts: Record<string, number>; adjustment: number }>>({});
  const [rankLoadError, setRankLoadError] = useState<string | null>(null);
  // 開發人員區「出缺席成績不含蓋在期中、期末、平時個別三部分分數」開關現況——
  // 只用來顯示提示文字，實際排除邏輯已經在資料庫端 scoped_student_totals() 做好
  // （見 sql/68scoped_totals_restore_total_always_includes_attendance.sql）：只
  // 排除期中/期末/平時三部分，這個班級的總分/排名不受影響，這裡的提示文字要
  // 講清楚這個分別，避免老師以為總分也被排除了。
  const [attendanceExcludedFromPartials, setAttendanceExcludedFromPartials] = useState(false);
  const ATTENDANCE_SUBJECT_NAMES = ['全勤', '出缺席'];
  const [canSeeRemarks, setCanSeeRemarks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'all' | '期中考' | '期末考' | '平時分'>('all');

  const perms = useDepartmentPermissions();
  const isAcademicLead = isDepartmentLead(perms.myDepartments, 'academic');
  // 誰看得到鎖定按鈕：導師本人（自己班）、管理員S/A/B、教務處主管——
  // 跟 sql/42fix_submission_windows_admin_permission.sql 的 RLS 規則一致，
  // 一般只教一科的任課教師不顯示（按了也會被資料庫擋下）。
  const canLock = isHomeroom || isAdmin || isAcademicLead;

  const visibleExamTypes: Array<'期中考' | '期末考' | '平時分'> =
    viewMode === 'all' ? ['期中考', '期末考', '平時分'] : [viewMode];

  // 讀取「出缺席成績不含蓋在期中、期末、平時個別三部分分數」開關現況（單純顯示提示文字用）
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('attendance_score_display_settings')
        .select('exclude_attendance_from_partial_scores')
        .eq('id', true)
        .maybeSingle();
      setAttendanceExcludedFromPartials(!!data?.exclude_attendance_from_partial_scores);
    })();
  }, []);

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
          grade_level: c.grade_level,
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
          setGradeLevel(cls.grade_level);
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
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLocksLoaded(false);
      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }

      // 【效能改寫】原本這裡是十幾個查詢「一個等一個」串行執行（每個都要一趟網路往返）。
      // 現在改成：第一批「班級資料＋學籍名單」並行；拿到學期後，把互不依賴的查詢
      // （排名、年級排名、出缺席、鎖定、科目比重、學期日期）一起送出，只有真的需要
      // 學籍名單的（成績、評語、獎懲）等隱藏名單過濾完才送。結果與原本完全相同。
      const [clsRes, enrollRes] = await Promise.all([
        supabase.from('classes').select('academic_year, grade_level').eq('id', classId).maybeSingle(),
        supabase
          .from('enrollments')
          .select('id, seat_no, term, student_no, students(name)')
          .eq('class_id', classId)
          .eq('is_current', true)
          .order('seat_no'),
      ]);
      const clsRow = clsRes.data;
      const enrollRowsRaw = enrollRes.data;
      // 學年度／年級：用本地變數，不等 setState 生效（理由同原本說明）
      const yearForQuery = clsRow?.academic_year ?? academicYear;
      const gradeLevelForQuery = clsRow?.grade_level ?? gradeLevel;
      const currentTerm: string | null = enrollRowsRaw && enrollRowsRaw.length > 0 ? (enrollRowsRaw[0] as any).term : null;

      // ---- 不依賴學生名單的查詢：立刻一起送出 ----
      // 總分/班排名／年級排名：class_rankings_for_class() / grade_rankings_for_class()
      // （見 sql/44、88、102）；有錯誤要顯示出來，不能吞掉（2026-08-19 的教訓）。
      const rankP = supabase.rpc('class_rankings_for_class', { p_class_id: classId, p_term: currentTerm });
      const gradeP = supabase.rpc('grade_rankings_for_class', { p_class_id: classId, p_term: currentTerm });
      // 出缺席（全勤）自動分數：class_attendance_adjustment_batch() 一次查完全班
      const attP = currentTerm
        ? supabase.rpc('class_attendance_adjustment_batch', { p_class_id: classId, p_term: currentTerm })
        : Promise.resolve({ data: null as any[] | null });
      // 期中/期末/平時三個有效鎖定狀態（含部別/全校 fallback 與 closes_at 自動鎖定）
      const lockP =
        yearForQuery && currentTerm
          ? supabase
              .rpc('class_lock_status', { p_class_id: classId, p_academic_year: yearForQuery, p_term: currentTerm })
              .maybeSingle()
          : Promise.resolve({ data: null as any });
      // 各科目佔比
      const curriculumP =
        yearForQuery && currentTerm && gradeLevelForQuery
          ? supabase
              .from('curriculum')
              .select('subject, weight')
              .eq('academic_year', yearForQuery)
              .eq('term', currentTerm)
              .eq('grade_level', gradeLevelForQuery)
          : Promise.resolve({ data: null as any[] | null });
      // 學期起訖日（獎懲統計用）
      const termRowP =
        yearForQuery && currentTerm
          ? supabase
              .from('academic_terms')
              .select('term_start_date, term_end_date')
              .eq('academic_year', yearForQuery)
              .eq('term', currentTerm)
              .maybeSingle()
          : Promise.resolve({ data: null as any });

      // 【本輪新增】反映事項「休學/轉學/退學的學生，只能在管理者視角下看到」——
      // 非管理員視角再對照一次隱藏名單（詳見 lib/hiddenStudents.ts）。
      const hiddenNos = isAdmin ? new Set<string>() : await getHiddenStudentNos((enrollRowsRaw ?? []).map((r: any) => r.student_no));
      const enrollRows = (enrollRowsRaw ?? []).filter((r: any) => !hiddenNos.has(r.student_no));
      const enrolls: EnrollRow[] = enrollRows.map((r: any) => ({
        id: r.id,
        seat_no: r.seat_no,
        name: r.students.name,
        student_no: r.student_no,
      }));
      const enrollIds = enrolls.map((e) => e.id);
      const idsForQuery = enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000'];

      // ---- 需要學生名單的查詢：一起送出 ----
      // 各科明細：任課教師只會看到自己教的科目那幾列（RLS 在資料庫層級過濾）
      const subjectP = supabase
        .from('subject_weighted_scores')
        .select('enrollment_id, subject, midterm, final, daily')
        .in('enrollment_id', idsForQuery);
      const remarkP =
        canSeeRemarks || isAdmin
          ? supabase.from('student_remarks').select('enrollment_id, comment').in('enrollment_id', idsForQuery)
          : Promise.resolve({ data: null as any[] | null });
      // 獎懲：這學期 conduct_events 依類別分組次數＋加總點數（同 sql/46 discipline_adjustment 邏輯）
      const conductP = (async () => {
        const map: Record<string, { counts: Record<string, number>; adjustment: number }> = {};
        if (!(yearForQuery && currentTerm)) return null;
        const { data: termRow } = await termRowP;
        const start = termRow?.term_start_date ?? estimateTermStart(yearForQuery, currentTerm);
        const end = termRow?.term_end_date ?? undefined;
        const studentNos = enrolls.map((e) => e.student_no);
        if (studentNos.length === 0) return map;
        let ceQuery = supabase
          .from('conduct_events')
          .select('student_no, event_type, count, points')
          .in('student_no', studentNos)
          .gte('event_date', start);
        if (end) ceQuery = ceQuery.lte('event_date', end);
        const { data: ceRows } = await ceQuery;
        (ceRows ?? []).forEach((r: any) => {
          const rec = (map[r.student_no] = map[r.student_no] ?? { counts: {}, adjustment: 0 });
          rec.counts[r.event_type] = (rec.counts[r.event_type] ?? 0) + (r.count ?? 1);
          rec.adjustment += Number(r.points) || 0;
        });
        return map;
      })();

      const [subjectRes, curriculumRes, rankRes, gradeRes, attRes, remarkRes, lockRes, conductMap] = await Promise.all([
        subjectP, curriculumP, rankP, gradeP, attP, remarkP, lockP, conductP,
      ]);
      if (cancelled) return; // 已經切換到別的班級，丟掉這份過期結果

      // ---- 整理結果（跟原本邏輯相同）----
      if (clsRow?.academic_year) setAcademicYear(clsRow.academic_year);
      if (clsRow?.grade_level) setGradeLevel(clsRow.grade_level);
      setEnrollments(enrolls);
      if (currentTerm) setTerm(currentTerm);
      if (conductMap) setConductByStudent(conductMap);
      else if (yearForQuery && currentTerm) setConductByStudent({});

      const subjSet = new Set<string>();
      const subjMap: Record<string, Record<string, SubjectRow>> = {};
      ((subjectRes.data ?? []) as any[]).forEach((r: any) => {
        subjSet.add(r.subject);
        subjMap[r.enrollment_id] = subjMap[r.enrollment_id] ?? {};
        subjMap[r.enrollment_id][r.subject] = r;
      });
      setSubjectData(subjMap);

      // 科目欄位＝curriculum（學校排定該年級該學期要上的科目）∪ 已有分數列的科目；
      // 依比重高到低排序，比重=0（停開）的不顯示。（2026 才藝課整欄消失問題的修法，見原說明）
      if (yearForQuery && currentTerm && gradeLevelForQuery) {
        const weightMap: Record<string, number> = {};
        ((curriculumRes.data ?? []) as any[]).forEach((r: any) => (weightMap[r.subject] = Number(r.weight)));
        setSubjectWeights(weightMap);
        const unionSubjects = new Set<string>([...Array.from(subjSet), ...Object.keys(weightMap)]);
        const sortedSubjects = Array.from(unionSubjects)
          .filter((s) => weightMap[s] !== 0)
          .sort((a, b) => {
            const wa = weightMap[a];
            const wb = weightMap[b];
            if (wa !== undefined && wb !== undefined) return wb - wa;
            if (wa !== undefined) return -1;
            if (wb !== undefined) return 1;
            return a.localeCompare(b);
          });
        setSubjects(sortedSubjects);
      } else {
        setSubjects(Array.from(subjSet));
      }

      const rankMap: Record<string, RankRow> = {};
      ((rankRes.data ?? []) as any[]).forEach((r: any) => (rankMap[r.enrollment_id] = r));
      setClassRank(rankMap);
      const gradeMap: Record<string, GradeRankRow> = {};
      ((gradeRes.data ?? []) as any[]).forEach(
        (r: any) =>
          (gradeMap[r.enrollment_id] = {
            grade_rank: r.grade_rank,
            midterm_grade_rank: r.midterm_grade_rank,
            final_grade_rank: r.final_grade_rank,
            daily_grade_rank: r.daily_grade_rank,
          })
      );
      setGradeRank(gradeMap);
      const rankErr = rankRes.error;
      const gradeErr = gradeRes.error;
      setRankLoadError(
        rankErr || gradeErr
          ? `讀取總分/排名時發生錯誤：${[rankErr?.message, gradeErr?.message].filter(Boolean).join('；')}`
          : null
      );

      const attAdjMap: Record<string, number> = {};
      ((attRes.data ?? []) as any[]).forEach((r: any) => (attAdjMap[r.enrollment_id] = Number(r.attendance_score)));
      setAttendanceAdjustments(attAdjMap);

      if (canSeeRemarks || isAdmin) {
        const remarkMap: Record<string, string> = {};
        ((remarkRes.data ?? []) as any[]).forEach((r: any) => (remarkMap[r.enrollment_id] = r.comment ?? ''));
        setRemarks(remarkMap);
      }

      if (yearForQuery && currentTerm) {
        const lockRow = lockRes.data as { mid_locked: boolean; fin_locked: boolean; day_locked: boolean } | null;
        setLockedByType({
          期中考: !!lockRow?.mid_locked,
          期末考: !!lockRow?.fin_locked,
          平時分: !!lockRow?.day_locked,
        });
      }
      setLocksLoaded(true);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  // 鎖定：跟「成績登錄」頁的鎖定按鈕共用同一套邏輯與資料表，任何一邊鎖定，另一邊都會
  // 立刻反映出來（都是讀寫同一筆 submission_windows）。鎖定後這個班這次考試的所有科目
  // 都會一起被鎖住，需經管理員審核修正申請才能再調整。
  async function handleLockExamType(et: '期中考' | '期末考' | '平時分') {
    if (!classId || !academicYear || !term) return;
    if (
      !confirm(
        `確定要鎖定本班「${et}」嗎？鎖定後，任何人（含你自己）都無法直接修改，需經管理員審核才能再調整。`
      )
    ) {
      return;
    }
    setLocking(et);
    const { error } = await supabase.from('submission_windows').upsert(
      {
        academic_year: academicYear,
        term,
        data_type: et,
        scope: '班級',
        scope_ref: classId,
        is_locked: true,
      },
      { onConflict: 'academic_year,term,data_type,scope,scope_ref' }
    );
    setLocking('');
    if (error) {
      alert('鎖定失敗：' + error.message);
    } else {
      setLockedByType((prev) => ({ ...prev, [et]: true }));
      alert(`已鎖定「${et}」。`);
    }
  }

  // 下載成績 EXCEL：對應這輪反映事項 1「提供下載成績功能EXCEL格式」。直接用畫面上
  // 已經查好、正在顯示的資料組成 Excel，不用另外再查一次資料庫（也保證下載出來的
  // 數字跟畫面上看到的一致）。
  function handleDownloadExcel() {
    if (!classId || enrollments.length === 0) return;
    downloadClassScoreExcel({
      className: className || '班級',
      academicYear: academicYear ?? '',
      term: term ?? '',
      viewMode,
      subjects,
      examTypes: visibleExamTypes,
      students: enrollments.map((e) => ({ enrollment_id: e.id, seat_no: e.seat_no, name: e.name })),
      subjectScores: subjectData,
      attendanceAdjustments,
      classRank,
      gradeRank,
      attendanceExcludedFromPartials,
    });
  }

  async function handlePrintReportCard(enrollmentId: string, format: 'pdf' | 'docx' | 'xlsx' = 'pdf') {
    // 【2026-08-19】同一個「window.open 被瀏覽器靜靜擋掉」的問題（見上面
    // handleBatchPrintClass 的說明），這裡也一併修正：點擊當下先同步開好空白分頁。
    // Word 合併列印（.docx）／Excel 範本（.xlsx）瀏覽器不會直接開啟預覽，開的
    // 空白分頁只是用來放「正在產生」的提示，實際檔案是直接觸發下載，跟 PDF
    // 那條路徑用同一組函式、只差在最後怎麼處理拿到的 blob。
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('瀏覽器擋下了新分頁（彈出視窗封鎖），請到瀏覽器網址列允許本網站開啟彈出視窗後再試一次。');
      return;
    }
    const formatLabel = format === 'docx' ? '（Word 合併列印）' : format === 'xlsx' ? '（Excel 範本）' : ' PDF';
    printWindow.document.write(`<p style="font-family:sans-serif;padding:24px">正在產生成績單${formatLabel}，請稍候…</p>`);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        printWindow.close();
        alert('請重新登入');
        return;
      }
      const res = await fetch(`/api/reports/report-card/${enrollmentId}${format !== 'pdf' ? `?format=${format}` : ''}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        printWindow.close();
        // 原本只顯示「產生成績單失敗」，讓人以為整個功能壞了；其實最常見的原因是
        // 期中考／期末考／平時分還沒有任一項鎖定（見 lib/reportCard.ts），這裡把 API
        // 回傳的 reason 直接顯示出來，比較清楚要先完成哪一步。
        let reason = '';
        try {
          const body = await res.json();
          reason = body?.error ? `\n${body.error}` : body?.reason ? `\n原因：${body.reason}` : '';
        } catch {
          // 回應不是 JSON，忽略，用預設訊息即可
        }
        alert(`目前還無法產出正式成績單。狀態碼 ${res.status}` + (reason || '\n請確認期中考／期末考／平時分是否已鎖定。'));
        return;
      }
      const blob = await res.blob();
      if (format === 'docx' || format === 'xlsx') {
        printWindow.close();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `report-card-${enrollmentId}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      showPdfInWindow(printWindow, blob, '成績單');
    } catch (err: any) {
      printWindow.close();
      alert('列印成績單發生錯誤：' + (err?.message ?? String(err)));
    }
  }

  // 批次列印「目前這個班」全班成績單（導師印自己班、管理員印目前選到的班都能用）。
  // 教務部門要一次印多班／全校，請到「成績相關設定及查詢」→「批次列印成績單（多班／全校）」分頁。
  async function handleBatchPrintClass(skipIncomplete = false, format: 'pdf' | 'docx' | 'xlsx' = 'pdf') {
    if (!classId) return;
    // 【2026-08-19 修正】「按了沒反應」的根因：window.open() 原本寫在 fetch 之後
    // （await 過網路請求才呼叫），瀏覽器的彈出視窗封鎖機制只認「使用者點擊當下、
    // 還沒有任何 await 的那個瞬間」算是「使用者主動開新分頁」，一旦中間經過
    // await（不管多快），瀏覽器就會把之後的 window.open() 當成「網頁自己偷開視窗」
    // 直接靜靜擋掉——不會跳出任何錯誤訊息或提示，畫面上就是「按了沒反應」，
    // 這正好對應這次反映的狀況。改成「點擊當下先同步開一個空白分頁（此時瀏覽器
        // 還認得是使用者剛點的），等 PDF 真的產生好了，再把那個已經開好的分頁導向
    // 到 PDF 內容」，就不會被封鎖。另外原本完全沒有 try/catch，fetch 本身如果
    // 失敗（網路問題）也會是「靜靜地什麼都不顯示」，這裡一併補上。
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('瀏覽器擋下了新分頁（彈出視窗封鎖），請到瀏覽器網址列允許本網站開啟彈出視窗後再試一次。');
      return;
    }
    const formatLabel = format === 'docx' ? '（Word 合併列印）' : format === 'xlsx' ? '（Excel 範本）' : ' PDF';
    printWindow.document.write(`<p style="font-family:sans-serif;padding:24px">正在產生成績單${formatLabel}，請稍候…</p>`);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        printWindow.close();
        alert('請重新登入');
        return;
      }
      const params = new URLSearchParams();
      if (skipIncomplete) params.set('skipIncomplete', 'true');
      if (format !== 'pdf') params.set('format', format);
      const url = `/api/reports/report-card/batch${params.toString() ? '?' + params.toString() : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ classIds: [classId] }),
      });

      if (res.status === 409) {
        printWindow.close();
        const body = await res.json();
        const names = (body.notReady ?? []).map((s: any) => `${s.studentName}(${s.reason})`).join('、');
        const confirmSkip = confirm(`以下學生尚未能產出成績單：\n${names}\n\n要跳過這些人、先列印其餘已完成的嗎？`);
        if (confirmSkip) return handleBatchPrintClass(true, format);
        return;
      }

      if (!res.ok) {
        printWindow.close();
        let detail = '';
        try {
          const body = await res.json();
          detail = body?.error ? `（${body.error}）` : '';
        } catch {
          /* 回應不是 JSON 就不附細節，仍然顯示狀態碼 */
        }
        alert(`批次列印失敗，請稍後再試。狀態碼 ${res.status}${detail}`);
        return;
      }

      const skipped = res.headers.get('X-Skipped-Students');
      if (skipped) {
        const list = JSON.parse(decodeURIComponent(skipped));
        alert(`已跳過 ${list.length} 位尚未鎖定的學生：${list.map((s: any) => s.studentName).join('、')}`);
      }

      const blob = await res.blob();
      if (format === 'docx' || format === 'xlsx') {
        printWindow.close();
        const a = document.createElement('a');
        const dUrl = URL.createObjectURL(blob);
        a.href = dUrl;
        // Excel 範本的批次列印是打包成 .zip（每位學生一個獨立檔案，見
        // app/api/reports/report-card/batch/route.tsx 的說明），不是單一 .xlsx。
        a.download = format === 'xlsx' ? `report-cards-batch-${classId}.zip` : `report-cards-batch-${classId}.docx`;
        a.click();
        URL.revokeObjectURL(dUrl);
        return;
      }
      showPdfInWindow(printWindow, blob, '成績單');
    } catch (err: any) {
      printWindow.close();
      alert('批次列印發生錯誤：' + (err?.message ?? String(err)));
    }
  }

  // 【本輪修正，根因已確認】「科目與 % 那兩列沒有固定」有兩個原因：
  // 1. 最外層 div 還留著 overflowX:'auto'（上一輪只拿掉了表格外面那層）——只要
  //    祖先元素的 overflow 不是 visible，position:sticky 的捲動參考就變成那個 div，
  //    而它並沒有自己的垂直捲軸，sticky 等於完全失效，往下捲標題就跟著走了。已移除。
  // 2. 第二列標題的 top 位移原本寫死 33px，但第一列的科目欄有「科目名＋百分比」兩行
  //    （約 46px 以上），第二列固定在 33px 就會被第一列蓋住一截、或兩列中間露出
  //    縫隙，學生資料捲上來時會從縫隙穿出來。改成實際量測第一列高度，字型、
  //    科目名稱換行、手機縮放都會自動跟著對。
  const headRow1Ref = useRef<HTMLTableRowElement | null>(null);
  const [headRow1Height, setHeadRow1Height] = useState(CS_HEADER_ROW1_DEFAULT_HEIGHT);
  useEffect(() => {
    const el = headRow1Ref.current;
    if (!el) return;
    const measure = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setHeadRow1Height((prev) => (prev === h ? prev : h));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 成績總表</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        任課教師登入本頁時，只會看到自己授課科目的欄位；總分、排名、評語僅導師與管理員可見。
        {subjects.some((s) => ATTENDANCE_SUBJECT_NAMES.includes(s)) && (
          <>「全勤」／「出缺席」欄位是依真實出缺勤紀錄自動計算（全勤100分，曠課/遲到/事假/病假依「整體佔比與加扣分規則」倒扣），不需要老師手動輸入，滑鼠移到格子上可以看到說明。</>
        )}
      </p>

      {/* 【本輪新增】反映事項「檢視/列印範圍的列印本頁功能，請把超出的左右寬濃縮為
          一張紙」——這張表欄位很多（尤其「全部」範圍：每科 3 個考試類別 × 4 欄，
          加上獎懲／綜合表現），原本列印用的是直向 A4、字體大小沒有特別為列印調整，
          欄位一多整頁寬度塞不下，右邊會被印到下一張紙去。這裡改成：(1) 用
          @page 把列印方向強制改成橫向（landscape），並把邊界縮小，先爭取到最大
          可用寬度；(2) 印表格的這個 class（print-compact）在列印時把字體、
          padding 都縮小，並用 table-layout:fixed 搭配較小的最小字體，讓瀏覽器
          的自動縮放（大多數瀏覽器列印對話框預設會勾選「縮放至頁面大小」）更容易
          把整張表收進同一頁寬度，不會再被攔腰印到第二張紙。 */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: landscape; margin: 8mm; }
          .print-compact table { font-size: 9px !important; table-layout: auto; }
          .print-compact th, .print-compact td { padding: 2px 3px !important; white-space: nowrap; }
        }
      `}</style>

      {enrollments.length > 0 && (
        <button onClick={handleDownloadExcel} className="no-print" style={{ fontSize: 12, padding: '4px 12px', marginBottom: 12 }}>
          📊 下載成績 Excel（{viewMode === 'all' ? '全部' : EXAM_TYPE_LABEL[viewMode]}）
        </button>
      )}

      {rankLoadError && (
        <p style={{ fontSize: 12, color: '#B3261E', background: '#FDECEA', border: '1px solid #f5c2c7', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          ⚠️ {rankLoadError}（總分/排名欄位這次會顯示空白，麻煩把這則錯誤訊息回報）
        </p>
      )}

      {attendanceExcludedFromPartials && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          ℹ️ 開發人員區已開啟「出缺席成績不含蓋在期中、期末、平時個別三部分分數」：下面期中／期末／平時三欄的分數與排名不含出缺席
          （不管期中考／期末考／平時分三大表有沒有送出、鎖定都一樣）。這個班級的「總分」／排名不受這個開關影響，仍會繼續把出缺席算進去。
        </p>
      )}

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
          <button
            onClick={() => handleBatchPrintClass(false, 'docx')}
            className="no-print"
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, background: '#2C6E9E', color: '#fff', border: 'none' }}
          >
            批次列印全班成績單（Word 合併列印）
          </button>
          <button
            onClick={() => handleBatchPrintClass(false, 'xlsx')}
            className="no-print"
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, background: '#1E7B45', color: '#fff', border: 'none' }}
          >
            批次列印全班成績單（Excel 範本）
          </button>
        </div>
      )}

      {!classId && !loading && (
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有可查看的班級（若您是任課教師，請改用「學生成績登錄」頁登錄成績）。</p>
      )}

      {canLock && (
        <div className="no-print" style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!locksLoaded ? (
            <p style={{ fontSize: 13, color: '#999', margin: 0 }}>鎖定狀態讀取中…</p>
          ) : (
            (['期中考', '期末考', '平時分'] as const).map((et) =>
              lockedByType[et] ? (
                <p key={et} style={{ fontSize: 13, color: '#3B6D11', margin: 0 }}>
                  ✓ {et}已鎖定，班排名與年級排名對應的欄位已開放顯示。
                </p>
              ) : (
                <button
                  key={et}
                  onClick={() => handleLockExamType(et)}
                  disabled={locking === et}
                  style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, alignSelf: 'flex-start' }}
                >
                  {locking === et ? '鎖定中…' : `確認送出並鎖定${et}（提前結束輸入）`}
                </button>
              )
            )
          )}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : (
        classId && (
          // 【本輪修正】反映事項「科目往下滑動看不見」「名字蓋到第一科期中考分數」
          // 「左右移動的移動軸不是在最外面的視窗，像內嵌了一個表格」——
          // 上一輪在這裡包了一層 overflowX:'auto' 的 div，這是真正的根因：CSS
          // 規定只要一個元素的 overflow-x 不是 visible，overflow-y 就算沒特別設，
          // 瀏覽器也會自動把它當成 auto——等於這個 div 變成「自己的捲動容器」，
          // 裡面所有 position:sticky 的元素，捲動的參考基準就變成「這個 div 的
          // 捲動範圍」而不是整個頁面，但這個 div 本身沒有限制高度、不會真的在
          // 垂直方向產生自己的捲軸，結果就是：上面「科目」那兩列標題的 sticky
          // 完全失效（往下滑就看不到了）；橫向捲軸則變成只存在於這個 div 自己
          // 窄窄的範圍裡，使用者得先往下滑到表格那裡才摸得到，才會覺得「移動軸
          // 不在最外面的視窗、像內嵌了一個表格」。
          // 修法：整個拿掉這層 overflowX，讓表格內容直接在頁面裡自然往右超出、
          // 由瀏覽器最外層視窗本身的橫向捲軸處理（跟 attendance/weekly 頁同一種
          // 做法）——這樣 position:sticky 的參考基準就是整個頁面，上方標題列、
          // 最左邊座號/姓名欄，橫向、縱向捲動都會正確固定住，捲軸也只有瀏覽器
          // 最外層那一條，不會有「表格裡又有一層」的感覺。
          //
          // 「姓名蓋到第一科分數」的根因則是：座號／姓名這兩個 sticky 欄位原本
          // 用猜的 left 值（0、40），沒有同時明確鎖定欄寬，學生姓名字數不同、
          // 瀏覽器實際算出來的欄寬跟猜的不一樣，才會蓋到旁邊。這裡把兩欄的寬度
          // 明確鎖死（座號48px、姓名92px），sticky 的 left 位移直接對齊這個鎖死
          // 的寬度，兩者一定對得起來，不會再因為姓名字數不同而跑位、互相蓋到。
          <div className="print-compact">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr ref={headRow1Ref}>
                <th style={{ textAlign: 'left', padding: 6, position: 'sticky', left: 0, top: 0, background: '#fff', zIndex: 4, width: 48, minWidth: 48, maxWidth: 48 }}>
                  座號
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: 6,
                    position: 'sticky',
                    left: 48,
                    top: 0,
                    background: '#fff',
                    zIndex: 4,
                    width: 92,
                    minWidth: 92,
                    maxWidth: 92,
                  }}
                >
                  姓名
                </th>
                {subjects.map((s) => (
                  <th key={s} colSpan={visibleExamTypes.length} style={{ padding: 6, borderLeft: SUBJECT_DIVIDER, position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>
                    {s}
                    {subjectWeights[s] !== undefined && (
                      <span style={{ display: 'block', fontSize: 11, fontWeight: 'normal', color: '#999' }}>
                        {(subjectWeights[s] * 100).toFixed(0)}%
                      </span>
                    )}
                  </th>
                ))}
                {/* 【本輪新增】反映事項「檢視/列印範圍【全部】的全勤紀錄右邊增加一欄『獎懲』」 */}
                {viewMode === 'all' && (
                  <th rowSpan={2} style={{ padding: 6, borderLeft: '1px solid #eee', position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>
                    獎懲
                    <span style={{ display: 'block', fontSize: 10, fontWeight: 'normal', color: '#999' }}>（本學期）</span>
                  </th>
                )}
                {visibleExamTypes.map((et) => (
                  <th key={'grp-' + et} colSpan={4} style={{ padding: 6, borderLeft: SUBJECT_DIVIDER, position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>
                    {EXAM_TYPE_LABEL[et]}總分／排名
                    {/* 反映事項：勾選排除出缺席時，期中/期末/平時三個總分／排名的標題要補上
                        「(未含出缺席加扣分)」，讓老師一眼看出這三欄現在不含出缺席，跟
                        右邊「總表」（一律含出缺席）分開標示，不用另外靠提示文字才看得出來。 */}
                    {attendanceExcludedFromPartials && (
                      <span style={{ display: 'block', fontSize: 10, fontWeight: 'normal', color: '#A36A00' }}>
                        (未含出缺席加扣分)
                      </span>
                    )}
                  </th>
                ))}
                {viewMode === 'all' && (
                  <th colSpan={3} style={{ padding: 6, borderLeft: '1px solid #eee', position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>
                    總表（期中*比例＋期末*比例＋平時*比例）
                    {/* 反映事項「總表的分數與排名只有計算期中、期末、平時，不包括敘獎分數」——
                        資料庫這裡本來就只有 subject_weighted_scores（各科加權分數）＋
                        attendance_adjustment（出缺席自動加扣分），沒有把 conduct_events／
                        敘獎點數算進來（見 sql/3calculations.sql student_total_scores、
                        sql/46 的 student_adjustments），這裡額外標註清楚，不用再另外猜。 */}
                    <span style={{ display: 'block', fontSize: 10, fontWeight: 'normal', color: '#999' }}>
                      (不含敘獎分數)
                    </span>
                  </th>
                )}
                {/* 【本輪修正】反映事項「綜合表現放在導師評語左側獨立一行，計算方式為
                    敘獎分數+學業分數，並提示『此分數為升級依據，不參與排名』」——原本
                    放在「平時」那組底下當第5欄，這裡移出來，變成總表（學業分數）跟
                    導師評語中間自己獨立的一欄。 */}
                {viewMode === 'all' && (
                  <th
                    style={{ padding: 6, borderLeft: '1px solid #eee', position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}
                    title="此分數為升級依據，不參與排名"
                  >
                    綜合表現
                    <span style={{ display: 'block', fontSize: 10, fontWeight: 'normal', color: '#999' }}>
                      （敘獎分數+學業分數，此分數為升級依據，不參與排名）
                    </span>
                  </th>
                )}
                {canSeeRemarks && (
                  <th style={{ textAlign: 'left', padding: 6, position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>導師評語</th>
                )}
                {canSeeRemarks && <th style={{ padding: 6, position: 'sticky', top: 0, background: '#fff', zIndex: 3 }}>成績單</th>}
              </tr>
              <tr style={{ fontSize: 11, color: '#999' }}>
                <th style={{ position: 'sticky', left: 0, top: headRow1Height, background: '#fff', zIndex: 4, width: 48, minWidth: 48, maxWidth: 48 }}></th>
                <th style={{ position: 'sticky', left: 48, top: headRow1Height, background: '#fff', zIndex: 4, width: 92, minWidth: 92, maxWidth: 92 }}></th>
                {subjects.map((s) =>
                  visibleExamTypes.map((et, eti) => (
                    <th
                      key={s + et}
                      style={{
                        borderLeft: eti === 0 ? SUBJECT_DIVIDER : EXAMTYPE_DIVIDER,
                        position: 'sticky',
                        top: headRow1Height,
                        background: '#fff',
                        zIndex: 2,
                      }}
                    >
                      {EXAM_TYPE_LABEL[et]}
                    </th>
                  ))
                )}
                {visibleExamTypes.map((et) => (
                  <Fragment key={et}>
                    {/* 反映事項「期中、期末、平時項下的『總分』改為『原始分數總分』」——
                        跟右邊「總表」、「綜合表現」區分清楚：這裡是單一考試類別、單純
                        科目加權後的分數，不含出缺席／敘獎這些額外加扣分。 */}
                    <th key={et + '-total'} style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>
                      原始分數總分
                    </th>
                    <th key={et + '-avg'} style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>
                      平均(*比重)
                    </th>
                    <th key={et + '-crank'} style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>
                      班排名
                    </th>
                    <th key={et + '-grank'} style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>
                      年級排名
                    </th>
                  </Fragment>
                ))}
                {viewMode === 'all' && (
                  <>
                    <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>總分</th>
                    <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>班排名</th>
                    <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}>年級排名</th>
                  </>
                )}
                {viewMode === 'all' && <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}></th>}
                {canSeeRemarks && <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}></th>}
                {canSeeRemarks && <th style={{ position: 'sticky', top: headRow1Height, background: '#fff', zIndex: 2 }}></th>}
              </tr>
            </thead>
            <tbody>
              {enrollments.map((en) => (
                <tr key={en.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 6, position: 'sticky', left: 0, background: '#fff', zIndex: 1, width: 48, minWidth: 48, maxWidth: 48 }}>{en.seat_no}</td>
                  <td
                    style={{
                      padding: 6,
                      position: 'sticky',
                      left: 48,
                      background: '#fff',
                      zIndex: 1,
                      whiteSpace: 'nowrap',
                      width: 92,
                      minWidth: 92,
                      maxWidth: 92,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={en.name}
                  >
                    {en.name}
                  </td>
                  {subjects.map((s) => {
                    const row = subjectData[en.id]?.[s];
                    const isAttendanceSubject = ATTENDANCE_SUBJECT_NAMES.includes(s);
                    // 【本輪更正】反映事項：「全部頁面中的全勤表格，無論是否勾選排除出缺席，
                    // 都必須全勤顯示分數」——上一輪把這一欄隱藏是誤解，改回一律顯示真實分數；
                    // 開關是否排除出缺席只影響期中/期末/平時「總分／排名」標題那邊補的
                    // 「(未含出缺席加扣分)」提示文字，不影響這一欄本身的顯示。
                    return visibleExamTypes.map((et, eti) => (
                      <td
                        key={s + et}
                        style={{ padding: 6, textAlign: 'center', borderLeft: eti === 0 ? SUBJECT_DIVIDER : EXAMTYPE_DIVIDER }}
                        title={
                          isAttendanceSubject
                            ? '依真實出缺勤紀錄自動計算，不是老師手動輸入的分數（老師若有在此欄輸入分數，該分數不會被採用）'
                            : undefined
                        }
                      >
                        {isAttendanceSubject ? attendanceAdjustments[en.id] ?? '—' : row?.[EXAM_TYPE_FIELD[et]] ?? '—'}
                      </td>
                    ));
                  })}
                  {/* 【本輪新增】獎懲欄內容：只列出有登記、次數>0 的類別，次數=0的類別不顯示，
                      例如「嘉獎2支、小功1支」；這學期完全沒有紀錄就顯示—。 */}
                  {viewMode === 'all' && (
                    <td style={{ padding: 6, textAlign: 'center', borderLeft: '1px solid #eee', fontSize: 12 }}>
                      {(() => {
                        const counts = conductByStudent[en.student_no]?.counts ?? {};
                        const parts = CONDUCT_TYPE_ORDER.filter((t) => counts[t] > 0).map((t) => `${t}${counts[t]}支`);
                        return parts.length > 0 ? parts.join('、') : '—';
                      })()}
                    </td>
                  )}
                  {visibleExamTypes.map((et) => (
                    <Fragment key={en.id + et}>
                      <td key={en.id + et + '-total'} style={{ padding: 6, textAlign: 'center', borderLeft: SUBJECT_DIVIDER }}>
                        {classRank[en.id]?.[EXAM_TYPE_TOTAL_FIELD[et]] ?? '—'}
                      </td>
                      <td key={en.id + et + '-avg'} style={{ padding: 6, textAlign: 'center', color: '#666' }}>
                        {classRank[en.id]?.[EXAM_TYPE_AVERAGE_FIELD[et]] ?? '—'}
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
                  {/* 【本輪修正】綜合表現＝敘獎分數（conductByStudent 前端算好的本學期
                      conduct_events 加總，跟 sql/46 discipline_adjustment() 同一套算法）
                      ＋學業分數（這裡用總表的 total_score，也就是期中/期末/平時依比例
                      加權後的總分，不含敘獎）。學業分數還沒算出來（例如還沒三個類別都
                      鎖定）就先顯示—，不要顯示只有敘獎分數、沒有學業分數的半套數字。 */}
                  {viewMode === 'all' && (
                    <td style={{ padding: 6, textAlign: 'center', borderLeft: '1px solid #eee' }} title="此分數為升級依據，不參與排名">
                      {(() => {
                        const academic = classRank[en.id]?.total_score;
                        if (academic === undefined || academic === null) return '—';
                        const conduct = conductByStudent[en.student_no]?.adjustment ?? 0;
                        return (Number(academic) + conduct).toFixed(2);
                      })()}
                    </td>
                  )}
                  {canSeeRemarks && <td style={{ padding: 6 }}>{remarks[en.id] ?? ''}</td>}
                  {canSeeRemarks && (
                    <td style={{ padding: 6, textAlign: 'center' }}>
                      {viewMode === 'all' ? (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <button onClick={() => handlePrintReportCard(en.id)} className="no-print" style={{ fontSize: 12, padding: '2px 8px' }}>
                            列印
                          </button>
                          <button
                            onClick={() => handlePrintReportCard(en.id, 'docx')}
                            className="no-print"
                            title="Word 合併列印"
                            style={{ fontSize: 12, padding: '2px 8px', color: '#2C6E9E', border: '1px solid #2C6E9E', borderRadius: 4, background: '#fff' }}
                          >
                            Word
                          </button>
                          <button
                            onClick={() => handlePrintReportCard(en.id, 'xlsx')}
                            className="no-print"
                            title="Excel 範本"
                            style={{ fontSize: 12, padding: '2px 8px', color: '#1E7B45', border: '1px solid #1E7B45', borderRadius: 4, background: '#fff' }}
                          >
                            Excel
                          </button>
                        </span>
                      ) : (
                        // 期中/期末/平時單一階段畫面不提供「個人成績單」列印——正式成績單同時
                        // 呈現上下學期/全學年學業平均與排名，在只看單一階段時印出來意義不大、
                        // 也容易讓人誤會是正式名次；這幾個階段的個人資料改用上方「下載成績
                        // Excel」取得。要印正式成績單請切換到「全部」分頁。
                        <span style={{ fontSize: 12, color: '#ccc' }}>—</span>
                      )}
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
          </div>
        )
      )}
    </div>
  );
}
