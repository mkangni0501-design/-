'use client';

import { Fragment, useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { isDepartmentLead } from '@/lib/departments';
import { downloadClassScoreExcel } from '@/lib/excelTemplates';

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
type EnrollRow = { id: string; seat_no: number; name: string };
type ClassOption = { id: string; label: string; grade_level: string };

const SUBJECT_DIVIDER = '2px solid #2C2C2A'; // 每一科分數中間：粗體間隔線
const EXAMTYPE_DIVIDER = '1px dotted #ccc'; // 科目項下的期中/期末/平時：細線間隔
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
    (async () => {
      setLoading(true);
      setLocksLoaded(false);
      if (isAdmin) {
        const opt = classOptions.find((c) => c.id === classId);
        if (opt) setClassName(opt.label);
      }

      // 學年度／年級：不管管理員或導師，都直接查一次 classes 拿到最新值（本地變數立刻可用，
      // 不用等 setState 生效後的下一次 render，後面查「科目與比重」要馬上用到這兩個值）
      const { data: clsRow } = await supabase.from('classes').select('academic_year, grade_level').eq('id', classId).maybeSingle();
      const yearForQuery = clsRow?.academic_year ?? academicYear;
      const gradeLevelForQuery = clsRow?.grade_level ?? gradeLevel;
      if (clsRow?.academic_year) setAcademicYear(clsRow.academic_year);
      if (clsRow?.grade_level) setGradeLevel(clsRow.grade_level);

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
      setSubjectData(subjMap);

      // 各科目佔比（顯示在科目欄位上方）：curriculum.weight 存的就是 0~1 的小數（0.2＝20%）
      // 科目欄位順序：依比重高到低排列，且比重=0（已停開/停用）的科目不顯示——
      // 跟「成績登錄」頁（ScoresEntryTab）的排序、隱藏規則一致。
      if (yearForQuery && currentTerm && gradeLevelForQuery) {
        const { data: curriculumRows } = await supabase
          .from('curriculum')
          .select('subject, weight')
          .eq('academic_year', yearForQuery)
          .eq('term', currentTerm)
          .eq('grade_level', gradeLevelForQuery);
        const weightMap: Record<string, number> = {};
        (curriculumRows ?? []).forEach((r: any) => (weightMap[r.subject] = Number(r.weight)));
        setSubjectWeights(weightMap);
        const sortedSubjects = Array.from(subjSet)
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

      // 總分/班排名／年級排名：改呼叫 class_rankings_for_class() / grade_rankings_for_class()
      // （sql/44fix_report_card_and_ranking_performance.sql）——原本直接查 class_rankings/
      // grade_rankings 這兩個 view，要等全校排名都算完才篩選，這次用真實資料量測試
      // （9000多筆成績、1300多位學生）在【班級成績結果與排名】頁已經直接跳出
      // statement timeout；改成呼叫這兩支函式後，只會計算「這個班」／「這個班同年級
      // 同部別」的範圍，不會被全校資料量拖慢。可見範圍限制（只有導師/管理員查得到）
      // 維持不變，任課教師呼叫一樣會得到空結果。
      // 【2026-08-19】原本這裡只解構 data、完全沒檢查 error——如果這支函式呼叫本身
      // 出錯（不是「權限篩選後是空的」，是真的執行失敗，例如函式簽名對不上、SQL執行
      // 階段出錯），畫面上會沒有任何提示，只會看到總分/排名整欄空白，很難跟「單純看
      // 不到」的情況分開，管理員S反映的狀況已經連續好幾輪查不出原因，可能就是這種
      // 「其實有錯誤，但被吃掉了」的情形——這裡改成有錯誤就存起來顯示，下次再發生
      // 同樣的狀況，畫面上會直接看到實際的錯誤訊息，不用再用猜的排查。
      const { data: rankRows, error: rankErr } = await supabase.rpc('class_rankings_for_class', { p_class_id: classId, p_term: currentTerm });
      const rankMap: Record<string, RankRow> = {};
      (rankRows ?? []).forEach((r: any) => (rankMap[r.enrollment_id] = r));
      setClassRank(rankMap);

      const { data: gradeRows, error: gradeErr } = await supabase.rpc('grade_rankings_for_class', { p_class_id: classId, p_term: currentTerm });
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
      setRankLoadError(
        rankErr || gradeErr
          ? `讀取總分/排名時發生錯誤：${[rankErr?.message, gradeErr?.message].filter(Boolean).join('；')}`
          : null
      );

      // 出缺席（全勤）自動加扣分：sql/47ranking_average_discipline_access_partial_report_card.sql
      // 新增的 class_attendance_adjustment_batch()，一次查完全班，不用每個學生各自呼叫一次。
      // 用途：科目欄位裡「全勤」／「出缺席」那一欄，改成顯示這裡查到的真實計算結果，取代
      // 老師手動輸入、但實際上不會被排名/總分採用的原始分數（見下面 render 那段的說明；
      // 對應這次反映「高三忠1號的分數欄位都是100」──那其實是老師手動輸入的舊分數，
      // 不是系統沒有計算扣分，只是畫面上一直顯示著沒被採用的那個數字，容易讓人誤會）。
      if (currentTerm) {
        const { data: attAdjRows } = await supabase.rpc('class_attendance_adjustment_batch', { p_class_id: classId, p_term: currentTerm });
        const attAdjMap: Record<string, number> = {};
        (attAdjRows ?? []).forEach((r: any) => (attAdjMap[r.enrollment_id] = Number(r.attendance_score)));
        setAttendanceAdjustments(attAdjMap);
      } else {
        setAttendanceAdjustments({});
      }

      if (canSeeRemarks || isAdmin) {
        const { data: remarkRows } = await supabase
          .from('student_remarks')
          .select('enrollment_id, comment')
          .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000']);
        const remarkMap: Record<string, string> = {};
        (remarkRows ?? []).forEach((r: any) => (remarkMap[r.enrollment_id] = r.comment ?? ''));
        setRemarks(remarkMap);
      }

      // 期中考／期末考／平時分：一次查完三個「有效鎖定狀態」（含 部別/全校 fallback、
      // 含 closes_at 時間到自動鎖定），決定要不要顯示對應的鎖定按鈕。改呼叫
      // class_lock_status()（sql/44fix_report_card_and_ranking_performance.sql）一次
      // 拿三個結果，不再各自分開呼叫三次——減少網路往返次數，同時避免「三個按鈕的
      // 狀態各自獨立回來、看起來卻像是綁在一起同步跳動」的觀感。
      // 注意：這裡要用上面剛查好的 yearForQuery（本地變數，立刻可用），不能用
      // academicYear 這個 state——setAcademicYear() 是非同步的，在同一次 effect
      // 執行期間讀 state 變數還是舊值（第一次載入時甚至是 null），會讓這段判斷
      // 永遠跳過、鎖定狀態查不到，導致畫面一直顯示「可以點的鎖定按鈕」，
      // 即使實際上已經鎖定了。
      if (yearForQuery && currentTerm) {
        const { data: lockRow } = await supabase
          .rpc('class_lock_status', { p_class_id: classId, p_academic_year: yearForQuery, p_term: currentTerm })
          .maybeSingle();
        setLockedByType({
          期中考: !!lockRow?.mid_locked,
          期末考: !!lockRow?.fin_locked,
          平時分: !!lockRow?.day_locked,
        });
      }
      setLocksLoaded(true);
      setLoading(false);
    })();
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
    });
  }

  async function handlePrintReportCard(enrollmentId: string, format: 'pdf' | 'docx' = 'pdf') {
    // 【2026-08-19】同一個「window.open 被瀏覽器靜靜擋掉」的問題（見上面
    // handleBatchPrintClass 的說明），這裡也一併修正：點擊當下先同步開好空白分頁。
    // Word 合併列印（.docx）瀏覽器不會直接開啟預覽，開的空白分頁只是用來放
    // 「正在產生」的提示，實際檔案是直接觸發下載，跟 PDF 那條路徑用同一組函式、
    // 只差在最後怎麼處理拿到的 blob。
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('瀏覽器擋下了新分頁（彈出視窗封鎖），請到瀏覽器網址列允許本網站開啟彈出視窗後再試一次。');
      return;
    }
    printWindow.document.write(`<p style="font-family:sans-serif;padding:24px">正在產生成績單${format === 'docx' ? '（Word 合併列印）' : ' PDF'}，請稍候…</p>`);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        printWindow.close();
        alert('請重新登入');
        return;
      }
      const res = await fetch(`/api/reports/report-card/${enrollmentId}${format === 'docx' ? '?format=docx' : ''}`, {
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
      if (format === 'docx') {
        printWindow.close();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `report-card-${enrollmentId}.docx`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      printWindow.location.href = URL.createObjectURL(blob);
    } catch (err: any) {
      printWindow.close();
      alert('列印成績單發生錯誤：' + (err?.message ?? String(err)));
    }
  }

  // 批次列印「目前這個班」全班成績單（導師印自己班、管理員印目前選到的班都能用）。
  // 教務部門要一次印多班／全校，請到「成績相關設定及查詢」→「批次列印成績單（多班／全校）」分頁。
  async function handleBatchPrintClass(skipIncomplete = false, format: 'pdf' | 'docx' = 'pdf') {
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
    printWindow.document.write(`<p style="font-family:sans-serif;padding:24px">正在產生成績單${format === 'docx' ? '（Word 合併列印）' : ' PDF'}，請稍候…</p>`);
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
      if (format === 'docx') params.set('format', 'docx');
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
      if (format === 'docx') {
        printWindow.close();
        const a = document.createElement('a');
        const dUrl = URL.createObjectURL(blob);
        a.href = dUrl;
        a.download = `report-cards-batch-${classId}.docx`;
        a.click();
        URL.revokeObjectURL(dUrl);
        return;
      }
      printWindow.location.href = URL.createObjectURL(blob);
    } catch (err: any) {
      printWindow.close();
      alert('批次列印發生錯誤：' + (err?.message ?? String(err)));
    }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, overflowX: 'auto' }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{className || '班級'} 成績總表</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        任課教師登入本頁時，只會看到自己授課科目的欄位；總分、排名、評語僅導師與管理員可見。
        {subjects.some((s) => ATTENDANCE_SUBJECT_NAMES.includes(s)) && (
          <>「全勤」／「出缺席」欄位是依真實出缺勤紀錄自動計算（全勤100分，曠課/遲到/事假/病假依「整體佔比與加扣分規則」倒扣），不需要老師手動輸入，滑鼠移到格子上可以看到說明。</>
        )}
      </p>

      <style>{`@media print { .no-print { display: none !important; } }`}</style>

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
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>座號</th>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                {subjects.map((s) => (
                  <th key={s} colSpan={visibleExamTypes.length} style={{ padding: 6, borderLeft: SUBJECT_DIVIDER }}>
                    {s}
                    {subjectWeights[s] !== undefined && (
                      <span style={{ display: 'block', fontSize: 11, fontWeight: 'normal', color: '#999' }}>
                        {(subjectWeights[s] * 100).toFixed(0)}%
                      </span>
                    )}
                  </th>
                ))}
                {visibleExamTypes.map((et) => (
                  <th key={'grp-' + et} colSpan={4} style={{ padding: 6, borderLeft: SUBJECT_DIVIDER }}>
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
                  visibleExamTypes.map((et, eti) => (
                    <th key={s + et} style={{ borderLeft: eti === 0 ? SUBJECT_DIVIDER : EXAMTYPE_DIVIDER }}>
                      {EXAM_TYPE_LABEL[et]}
                    </th>
                  ))
                )}
                {visibleExamTypes.map((et) => (
                  <Fragment key={et}>
                    <th key={et + '-total'}>總分</th>
                    <th key={et + '-avg'}>平均(*比重)</th>
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
                    const isAttendanceSubject = ATTENDANCE_SUBJECT_NAMES.includes(s);
                    // 開發人員區開關開啟時，期中/期末/平時三欄已經不含出缺席
                    // （見 sql/68，但這個班級的「總分」仍然繼續把出缺席算進去），這裡連
                    // 「全勤／出缺席」這一欄本身顯示的分數也一併隱藏（顯示「—」），
                    // 避免老師看到這一欄有分數、卻懷疑期中/期末/平時為什麼沒把它
                    // 算進去，看起來像系統漏算。
                    const hideAttendanceScore = isAttendanceSubject && attendanceExcludedFromPartials;
                    return visibleExamTypes.map((et, eti) => (
                      <td
                        key={s + et}
                        style={{ padding: 6, textAlign: 'center', borderLeft: eti === 0 ? SUBJECT_DIVIDER : EXAMTYPE_DIVIDER }}
                        title={
                          hideAttendanceScore
                            ? '開發人員區已開啟「出缺席成績不含蓋在期中、期末、平時個別三部分分數」，這一欄暫時隱藏'
                            : isAttendanceSubject
                            ? '依真實出缺勤紀錄自動計算，不是老師手動輸入的分數（老師若有在此欄輸入分數，該分數不會被採用）'
                            : undefined
                        }
                      >
                        {hideAttendanceScore
                          ? '—'
                          : isAttendanceSubject
                          ? attendanceAdjustments[en.id] ?? '—'
                          : row?.[EXAM_TYPE_FIELD[et]] ?? '—'}
                      </td>
                    ));
                  })}
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
        )
      )}
    </div>
  );
}
