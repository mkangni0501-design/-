'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  downloadDeveloperAllTemplate,
  ACCOUNTS_SHEET_NAME,
  CLASSES_SHEET_NAME,
  CURRICULUM_SHEET_NAME,
  TEACHER_ASSIGNMENTS_SHEET_NAME,
  SCHOOL_TIMETABLE_SHEET_NAME,
  PERIOD_CONFIG_SHEET_NAME,
  GRADING_RULES_SHEET_NAME,
  STUDENTS_IMPORT_SHEET_NAME,
  DEVELOPER_SCHEDULER_OVERLAP_SHEETS,
} from '@/lib/excelTemplates';
import {
  fetchCurrentAccountsSheet,
  fetchCurrentClassesSheet,
  fetchCurrentCurriculumSheet,
  fetchCurrentTeacherAssignmentsSheet,
  fetchCurrentSchoolTimetableSheet,
  fetchCurrentPeriodConfigSheet,
  fetchCurrentGradingRulesSheet,
  fetchCurrentStudentsSheet,
} from '@/lib/currentDataSheets';
import {
  ATTENDANCE_ALERT_SETTINGS_SHEET_NAME,
  CONDUCT_POINT_DEFAULTS_SHEET_NAME,
  GENERAL_INVENTORY_ITEMS_SHEET_NAME,
  GENERAL_INVENTORY_TX_SHEET_NAME,
  MAINTENANCE_TICKETS_SHEET_NAME,
  UTILITY_BILLS_SHEET_NAME,
  ACADEMIC_TERMS_SHEET_NAME,
  fetchCurrentAttendanceAlertSettingsSheet,
  fetchCurrentConductPointDefaultsSheet,
  fetchCurrentGeneralInventoryItemsSheet,
  fetchCurrentGeneralInventoryTransactionsSheet,
  fetchCurrentMaintenanceTicketsSheet,
  fetchCurrentUtilityBillsSheet,
  fetchCurrentAcademicTermsSheet,
} from '@/lib/currentDataSheetsExtra';
import {
  uploadAttendanceAlertSettingsSheet,
  uploadConductPointDefaultsSheet,
  uploadGeneralInventoryItemsSheet,
  uploadGeneralInventoryTransactionsSheet,
  uploadMaintenanceTicketsSheet,
  uploadUtilityBillsSheet,
  uploadAcademicTermsSheet,
} from '@/lib/bulkHandlersExtra';
import {
  SELF_HIRED_LETTER_SHEET_NAME,
  ANNUAL_LETTER_SHEET_NAME,
  SERVICE_CERT_SHEET_NAME,
  fetchCurrentServiceCertSheet,
  fetchCurrentAppointmentLetterSheet,
  uploadServiceCertSheet,
  uploadAppointmentLetterSheet,
} from '@/lib/teacherLetters';
import {
  uploadClassesSheet,
  uploadCurriculumSheet,
  uploadTeacherAssignmentsSheet,
  uploadSchoolTimetableSheet,
  uploadPeriodConfigSheet,
  uploadGradingRulesSheet,
  uploadStudentsImportSheet,
  uploadAllScoresSheet,
  uploadAllAttendanceSheet,
  uploadAllConductSheet,
  inviteAccountsSheet,
} from '@/lib/bulkHandlers';
import { fetchAllScoresSheet, fetchAllAttendanceSheet, fetchAllConductSheet } from '@/lib/schoolWideDataQueries';
import { buildSchedulerExportSheetData } from '@/lib/schedulerExcelExport';
import { importScheduleExcel } from '@/lib/schedulerBridge';
import type { SchedulerProjectData } from '@/lib/schedulerBackupClient';

type SheetResult = { sheet: string; successCount: number; errors: string[] };

const SCORES_SHEET_NAME = '全校成績(現況)';
const ATTENDANCE_SHEET_NAME = '全校出缺勤(現況)';
const CONDUCT_SHEET_NAME = '全校獎懲(現況)';

// 「任課教師設定(現況)」「學校課表(現況)」是查詢/快照專用的下載格式，欄位順序其實跟
// 「任課教師設定」「學校課表」這兩張可上傳範本一模一樣，只差在只有1列表頭（範本是2列）。
// 這裡直接重用既有的上傳函式，補一列空白表頭讓行號對齊，不用另外重寫一份解析邏輯。
const TEACHER_ASSIGNMENTS_CURRENT_SHEET_NAME = '任課教師設定(現況)';
const SCHOOL_TIMETABLE_CURRENT_SHEET_NAME = '學校課表(現況)';

// 排課系統「匯出Excel」的8張工作表裡，只有這兩張（內容完全相同）是唯一、完整、可以還原回
// 班級/導師/課表/科目節數的來源格式，寫回資料庫的邏輯已經在 lib/schedulerBridge.ts 的
// importScheduleExcel() 做好了（原本只給「排課系統」頁面的匯入按鈕用），這裡直接重用。
const SCHEDULER_GRID_SHEET_NAMES = ['全校總課表(輸入)', '課表模板(修改用)'];
// 其餘5張（全校教師任課表／各教師課表／各班課表／值日教師參考／匯入教師 & 導師資料）都只是
// 同一份課表資料換不同版面呈現的「檢視用」快照：
// - 前4張跟「全校總課表(輸入)」是完全同一份 S.schedules 來源，只是換了排版（老師為列、班級為列、算出誰沒課...），
//   資料已經可以從「全校總課表(輸入)」完整還原，沒有必要（也不應該）再各自解析寫回一次，
//   否則同一批資料被拆成5套邏輯各自寫入，格式稍有出入就會互相打架。
// - 「值日教師參考」更進一步：內容是「這個時段誰沒課」，是純粹算出來的結果，不是任何人手動填的
//   原始資料，本質上就無法「還原」回課表（不知道空格是本來沒排課、還是漏填）。
// - 「匯入教師 & 導師資料」欄位比「全校總課表(輸入)」少了星期/節次，是「全校總課表(輸入)」的子集，
//   同樣已經被涵蓋，不用重複處理。
const SCHEDULER_VIEW_ONLY_SHEET_NAMES = ['全校教師任課表', '各教師課表', '各班課表', '值日教師參考', '匯入教師 & 導師資料'];

// 目前登入者可以邀請哪些角色（跟「帳號管理」頁的規則一致）
function allowedRolesFor(role: string | undefined): string[] {
  if (role === 'system_admin_s') return ['admin_a', 'admin_b', 'homeroom_teacher', 'subject_teacher'];
  if (role === 'admin_a') return ['admin_a', 'homeroom_teacher', 'subject_teacher'];
  if (role === 'admin_b') return ['admin_b', 'homeroom_teacher', 'subject_teacher'];
  return [];
}

export default function BulkExcelPanel({ myRole }: { myRole: string | undefined }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SheetResult[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [overlapNotice, setOverlapNotice] = useState<string[]>([]);
  const [snapshotBusy, setSnapshotBusy] = useState(false);

  // 這個學年度/學期原本是每次下載/上傳都跳出 prompt() 讓管理者手動打字輸入，沒有任何預設值、
  // 也看不到目前打的到底是什麼——只要打錯一個數字（例如少打一年），下載出來的「現況」（含學生
  // 名冊）就會整個是空的，卻沒有任何提示看起來像是「系統漏了學生資料」。改成看得到、
  // 有預設值（抓系統目前設定生效的學年學期）的欄位，下載/上傳前都能先確認清楚。
  const [snapshotYear, setSnapshotYear] = useState<number>(new Date().getFullYear());
  const [snapshotTerm, setSnapshotTerm] = useState<'上學期' | '下學期'>('上學期');
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('current_academic_term');
      const term = Array.isArray(data) ? data[0] : data;
      if (term) {
        setSnapshotYear(term.academic_year);
        setSnapshotTerm(term.term);
      }
    })();
  }, []);

  // 「下載全部表格範本」：跟以前一樣，8張空白範本，適合全新學校第一次建檔用
  // 「下載完整資料快照」：範本8張 + 排課工具8頁（最近一次存檔的內容）+ 全校成績/出缺勤/獎懲現況，
  //   適合要整體備份、或要把資料搬到別的系統時用
  async function handleDownloadFullSnapshot() {
    const academicYear = snapshotYear;
    const term = snapshotTerm;
    if (!academicYear) {
      alert('請先在上面填學年度');
      return;
    }

    setSnapshotBusy(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();

      // 帳號名單要附上信箱，信箱存在 Supabase Auth 不在 app_users，需要帶登入憑證
      // 呼叫 /api/admin/list-accounts-with-email 才查得到（見 fetchCurrentAccountsSheet 內註解）
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      const setupSheets = await Promise.all([
        fetchCurrentAccountsSheet(accessToken),
        fetchCurrentClassesSheet(academicYear),
        fetchCurrentCurriculumSheet(academicYear, term),
        fetchCurrentTeacherAssignmentsSheet(academicYear, term),
        fetchCurrentSchoolTimetableSheet(academicYear, term),
        fetchCurrentPeriodConfigSheet(),
        fetchCurrentGradingRulesSheet(academicYear, term),
        fetchCurrentStudentsSheet(academicYear, term),
      ]);
      // 這裡改成真的去資料庫查詢目前現況，取代舊版誤用的空白範本
      // （舊版 buildDeveloperSetupSheets() 除了帳號名單，其餘7張都只是2列示範資料的空白範本，
      // 放進「完整資料快照」裡會讓人誤以為系統資料大量缺失）
      setupSheets.forEach(({ name, aoa }) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name));

      // 排課工具那8頁：抓這個學年度/學期「最近一次」存進系統的排課工具存檔
      const { data: backupRow } = await supabase
        .from('scheduler_backups')
        .select('data')
        .eq('academic_year', academicYear)
        .eq('term', term)
        .order('saved_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (backupRow?.data) {
        const sheets = buildSchedulerExportSheetData(backupRow.data as SchedulerProjectData);
        sheets.forEach((s) => {
          // 「課表模板(修改用)」內容跟「全校總課表(輸入)」完全一樣，工作表名稱不能重複，這裡加個角括號區分
          const name = wb.SheetNames.includes(s.name) ? s.name + '(2)' : s.name;
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), name);
        });
      } else {
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.aoa_to_sheet([[`${academicYear}學年度／${term}目前還沒有排課工具的存檔，請先到「排課系統」頁排課後按「存檔到校務系統」。`]]),
          '排課工具存檔(尚無資料)'
        );
      }

      // 全校成績/出缺勤/獎懲現況
      const [scoresSheet, attendanceSheet, conductSheet] = await Promise.all([
        fetchAllScoresSheet(),
        fetchAllAttendanceSheet(),
        fetchAllConductSheet(),
      ]);
      [scoresSheet, attendanceSheet, conductSheet].forEach((s) => {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.aoa), s.name);
      });

      // 訓導／總務／開發人員現況——原本「完整資料快照」完全沒有涵蓋這三個部門的資料，
      // 管理員S反映「一鍵上傳/下載缺分頁」，這裡補齊（教師歷年資料／聘書兩張表另外
      // 有自己的「下載目前資料」按鈕，見「開發人員」分頁的「聘書」，這裡一併納入快照）。
      const deptSheets = await Promise.all([
        fetchCurrentAttendanceAlertSettingsSheet(),
        fetchCurrentConductPointDefaultsSheet(),
        fetchCurrentGeneralInventoryItemsSheet(),
        fetchCurrentGeneralInventoryTransactionsSheet(),
        fetchCurrentMaintenanceTicketsSheet(),
        fetchCurrentUtilityBillsSheet(),
        fetchCurrentAcademicTermsSheet(),
        fetchCurrentServiceCertSheet(),
        fetchCurrentAppointmentLetterSheet('自聘教師聘書'),
        fetchCurrentAppointmentLetterSheet('當年教師聘書'),
      ]);
      deptSheets.forEach(({ name, aoa }) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name.slice(0, 31)));

      const ts = new Date();
      const pad = (n: number) => (n < 10 ? '0' : '') + n;
      XLSX.writeFile(wb, `校務系統完整資料快照_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}.xlsx`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResults(null);
    setSkipped([]);
    setOverlapNotice([]);

    try {
      const buf = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetNames = new Set(wb.SheetNames);

      // 先看看這份檔案裡有沒有「跟排課系統存檔重疊」的工作表，有的話先提醒一次
      const overlapping = DEVELOPER_SCHEDULER_OVERLAP_SHEETS.filter((s) => sheetNames.has(s));
      if (overlapping.length > 0) {
        const proceed = confirm(
          `這份檔案裡包含「${overlapping.join('、')}」，這幾張表平常是由【排課系統】排課後按「💾 存檔到校務系統」直接寫入的。\n\n` +
            `如果本學期已經用排課系統存過檔，這裡繼續上傳可能會覆蓋掉排課系統寫入的資料（之後排課系統再存檔一次，又會蓋回來，兩邊會一直互相覆蓋）。\n\n` +
            `只有「全新學校、資料庫還是空的、還沒用過排課系統」的情況才建議繼續。確定要繼續上傳這幾張表嗎？`
        );
        if (!proceed) {
          setResults([{ sheet: '（全部）', successCount: 0, errors: ['使用者確認後選擇不繼續，已取消整份上傳'] }]);
          return;
        }
        setOverlapNotice(overlapping as unknown as string[]);
      }

      const academicYear = snapshotYear;
      const term = snapshotTerm;
      if (!academicYear) {
        setResults([{ sheet: '（全部）', successCount: 0, errors: ['請先在上面填學年度，已取消整批上傳'] }]);
        return;
      }

      const rowsOf = (name: string) => {
        const sheet = wb.Sheets[name];
        if (!sheet) return null;
        return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][];
      };

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const accessTokenUserId = sessionData.session?.user?.id ?? null;
      const allowedRoles = allowedRolesFor(myRole);

      // 每張表都同時列出「可上傳範本」的工作表名稱，以及「下載完整資料快照」用的「(現況)」
      // 工作表名稱兩種——這樣不管上傳的是空白範本填好的檔案、還是直接把「下載完整資料快照」
      // 拿回來改一改重新上傳，同一份檔案都能被讀到，達到「開發人員一口氣上傳、取代所有檔案，
      // 完成系統轉換」的目的，不用先手動把「(現況)」工作表名稱改掉才能上傳。
      // currentPrependRows：「(現況)」版本表頭列數通常比範本少（範本多一列使用說明），
      // 用這個數字補上對應數量的空白列，讓資料從同一個欄位位置開始解析，重用同一支上傳函式。
      type PlanStep = {
        templateName: string;
        currentName?: string;
        currentPrependRows?: number;
        run: (rows: any[][]) => Promise<{ successCount: number; errors: string[] }>;
      };

      const plan: PlanStep[] = [
        {
          templateName: ACCOUNTS_SHEET_NAME,
          currentName: '帳號名單(現況)',
          currentPrependRows: 1,
          run: (rows) =>
            accessToken
              ? inviteAccountsSheet(rows, accessToken, allowedRoles)
              : Promise.resolve({ successCount: 0, errors: ['請重新登入後再上傳「帳號名單」工作表'] }),
        },
        {
          templateName: CLASSES_SHEET_NAME,
          currentName: '班級與導師設定(現況)',
          currentPrependRows: 0,
          run: (rows) => uploadClassesSheet(rows, academicYear),
        },
        {
          templateName: CURRICULUM_SHEET_NAME,
          currentName: '科目與比重設定(現況)',
          currentPrependRows: 0,
          run: (rows) => uploadCurriculumSheet(rows, term),
        },
        {
          templateName: TEACHER_ASSIGNMENTS_SHEET_NAME,
          currentName: TEACHER_ASSIGNMENTS_CURRENT_SHEET_NAME,
          currentPrependRows: 1,
          run: (rows) => uploadTeacherAssignmentsSheet(rows),
        },
        {
          templateName: SCHOOL_TIMETABLE_SHEET_NAME,
          currentName: SCHOOL_TIMETABLE_CURRENT_SHEET_NAME,
          currentPrependRows: 1,
          run: (rows) => uploadSchoolTimetableSheet(rows),
        },
        {
          templateName: PERIOD_CONFIG_SHEET_NAME,
          currentName: '節次設定(現況)',
          currentPrependRows: 1,
          run: (rows) => uploadPeriodConfigSheet(rows),
        },
        {
          templateName: GRADING_RULES_SHEET_NAME,
          currentName: '整體佔比與加扣分規則(現況)',
          currentPrependRows: 0,
          run: (rows) => uploadGradingRulesSheet(rows, academicYear, term),
        },
        {
          templateName: STUDENTS_IMPORT_SHEET_NAME,
          currentName: '既有學生快速建檔(現況)',
          currentPrependRows: 1,
          run: (rows) => uploadStudentsImportSheet(rows),
        },
        { templateName: SCORES_SHEET_NAME, run: (rows) => uploadAllScoresSheet(rows) },
        { templateName: ATTENDANCE_SHEET_NAME, run: (rows) => uploadAllAttendanceSheet(rows) },
        { templateName: CONDUCT_SHEET_NAME, run: (rows) => uploadAllConductSheet(rows) },
        // 訓導／總務／開發人員：原本一鍵上傳完全沒有涵蓋這幾張表，這裡補上
        // （見 lib/currentDataSheetsExtra.ts／lib/bulkHandlersExtra.ts 開頭說明）
        { templateName: ATTENDANCE_ALERT_SETTINGS_SHEET_NAME, run: (rows) => uploadAttendanceAlertSettingsSheet(rows, accessTokenUserId) },
        { templateName: CONDUCT_POINT_DEFAULTS_SHEET_NAME, run: (rows) => uploadConductPointDefaultsSheet(rows) },
        { templateName: GENERAL_INVENTORY_ITEMS_SHEET_NAME, run: (rows) => uploadGeneralInventoryItemsSheet(rows, accessTokenUserId) },
        { templateName: GENERAL_INVENTORY_TX_SHEET_NAME, run: (rows) => uploadGeneralInventoryTransactionsSheet(rows, accessTokenUserId) },
        { templateName: MAINTENANCE_TICKETS_SHEET_NAME, run: (rows) => uploadMaintenanceTicketsSheet(rows, accessTokenUserId) },
        { templateName: UTILITY_BILLS_SHEET_NAME, run: (rows) => uploadUtilityBillsSheet(rows, accessTokenUserId) },
        { templateName: ACADEMIC_TERMS_SHEET_NAME, run: (rows) => uploadAcademicTermsSheet(rows, accessTokenUserId) },
        { templateName: SERVICE_CERT_SHEET_NAME, currentName: '歷年教師資料(現況)', run: (rows) => uploadServiceCertSheet(rows, accessTokenUserId) },
        {
          templateName: SELF_HIRED_LETTER_SHEET_NAME,
          currentName: SELF_HIRED_LETTER_SHEET_NAME + '(現況)',
          run: (rows) => uploadAppointmentLetterSheet(rows, '自聘教師聘書', accessTokenUserId),
        },
        {
          templateName: ANNUAL_LETTER_SHEET_NAME,
          currentName: ANNUAL_LETTER_SHEET_NAME + '(現況)',
          run: (rows) => uploadAppointmentLetterSheet(rows, '當年教師聘書', accessTokenUserId),
        },
      ];

      const collected: SheetResult[] = [];
      const notFound: string[] = [];

      for (const step of plan) {
        let rows = rowsOf(step.templateName);
        let sourceSheetName = step.templateName;

        if (!rows && step.currentName) {
          const currentRows = rowsOf(step.currentName);
          if (currentRows) {
            const blankRows: any[][] = Array.from({ length: step.currentPrependRows ?? 0 }, () => []);
            rows = [...blankRows, ...currentRows];
            sourceSheetName = step.currentName;
          }
        }

        if (!rows) {
          notFound.push(step.templateName);
          continue;
        }
        const r = await step.run(rows);
        collected.push({ sheet: sourceSheetName, ...r });
      }

      // 排課工具匯出的「全校總課表(輸入)」／「課表模板(修改用)」：兩張內容相同，是排課工具那8頁
      // 唯一能完整還原回班級/導師/課表/科目節數的來源格式，直接重用排課系統頁面本來就有的匯入邏輯。
      const gridSheetName = SCHEDULER_GRID_SHEET_NAMES.find((n) => sheetNames.has(n));
      if (gridSheetName) {
        try {
          const gridResult = await importScheduleExcel(file, academicYear, term);
          collected.push({
            sheet: gridSheetName,
            successCount: gridResult.classesUpserted + gridResult.curriculumUpserted + gridResult.scheduleUpserted,
            errors: gridResult.warnings,
          });
        } catch (err: any) {
          collected.push({ sheet: gridSheetName, successCount: 0, errors: [err.message ?? '匯入失敗'] });
        }
      }

      // 其餘5張是同一份課表資料換版面的檢視用快照，沒有獨立、可還原的來源資料，不會從這裡寫回資料庫
      const viewOnlySheetsPresent = wb.SheetNames.filter((n) => SCHEDULER_VIEW_ONLY_SHEET_NAMES.includes(n));

      setResults(collected);
      setSkipped(notFound);
      if (viewOnlySheetsPresent.length > 0) {
        setResults((prev) => [
          ...(prev ?? []),
          {
            sheet: viewOnlySheetsPresent.join('、'),
            successCount: 0,
            errors: [
              '這幾張是同一份課表資料換版面的檢視用快照（老師課表、班級課表、值日教師參考等），資料已經包含在「全校總課表(輸入)」／「課表模板(修改用)」裡面，不會從這裡另外寫回資料庫，已略過。',
            ],
          },
        ]);
      }
    } catch (err: any) {
      setResults([{ sheet: '（全部）', successCount: 0, errors: [err.message ?? '解析失敗'] }]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        把系統裡「帳號名單、班級與導師設定、科目與比重設定、任課教師設定、學校課表、節次設定、整體佔比與加扣分規則、既有學生快速建檔、
        全校成績現況、全校出缺勤現況、全校獎懲現況」這11張表格合併成一份Excel，一次填完、一次上傳，不用每個功能頁分開跑一次；
        「下載完整資料快照」再加上排課工具匯出的8頁課表資料，適合整體備份、第一次建檔或搬資料用——快照裡的「(現況)」工作表現在
        都可以直接改一改、原封不動地重新上傳（不用先改成範本格式、也不用先手動改掉工作表名稱），開發人員可以只靠「下載完整資料快照
        →改一改→整份重新上傳」這一來一回，就把系統裡所有表格整批取代掉，完成資料搬遷／系統轉換。
      </p>
      <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 16 }}>
        提醒：「班級與導師設定」「科目與比重設定（節數）」「任課教師設定」「學校課表」「全校總課表(輸入)」「課表模板(修改用)」這6張，
        如果本學期已經用過【排課系統（自動排課工具）】排課並按過「💾 存檔到校務系統」，請不要在這裡重複上傳，以免蓋掉排課系統寫入的資料
        （詳見下方確認視窗說明）。「全校教師任課表」「各教師課表」「各班課表」「值日教師參考」「匯入教師 & 導師資料」這5張只是同一份課表
        換版面呈現的檢視用快照，資料已經包含在「全校總課表(輸入)」裡，只能下載查看，沒辦法從這裡上傳寫回。
      </p>

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#666' }}>下載/上傳要用的學年度／學期：</span>
        <input
          type="number"
          value={snapshotYear}
          onChange={(e) => setSnapshotYear(Number(e.target.value))}
          style={{ padding: 6, width: 90 }}
          placeholder="學年度"
        />
        <select value={snapshotTerm} onChange={(e) => setSnapshotTerm(e.target.value as any)} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <span style={{ fontSize: 11, color: '#999' }}>
          （預設抓系統目前設定生效的學年學期；如果系統還沒設定過，這裡先用今年帶入，請務必確認是不是您要的那一年再下載/上傳——
          填錯的話「既有學生快速建檔(現況)」等「現況」表格會整個是空的，看起來會像資料不見了）
        </span>
      </div>

      <div style={{ marginBottom: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={downloadDeveloperAllTemplate}
          style={{ padding: '8px 16px', background: '#fff', color: '#2C6E9E', border: '1px solid #2C6E9E', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
        >
          ↓ 下載全部表格範本（10張工作表＋說明，適合全新建檔）
        </button>
        <button
          type="button"
          onClick={handleDownloadFullSnapshot}
          disabled={snapshotBusy}
          style={{ padding: '8px 16px', background: '#2C6E9E', color: '#fff', border: '1px solid #2C6E9E', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
        >
          {snapshotBusy ? '準備中…' : `↓ 下載完整資料快照（${snapshotYear}學年度／${snapshotTerm}，含排課工具8頁＋全校成績/出缺勤/獎懲）`}
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>填好後，選擇檔案一次上傳（檔案裡有哪幾張工作表就處理哪幾張，沒有的會略過）：</label>
        <input ref={inputRef} type="file" accept=".xlsx" onChange={handleChange} disabled={busy} style={{ fontSize: 13 }} />
      </div>

      {busy && <p style={{ fontSize: 12, color: '#666' }}>處理中，資料量大時可能要等一下…</p>}

      {overlapNotice.length > 0 && (
        <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>
          已依您的確認繼續上傳「{overlapNotice.join('、')}」，請之後留意排課系統那邊是否需要重新存檔一次以保持一致。
        </p>
      )}

      {results && (
        <div style={{ fontSize: 13, marginTop: 12 }}>
          {results.map((r, idx) => (
            <div key={r.sheet + idx} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
              <p style={{ fontWeight: 'bold', marginBottom: 4 }}>{r.sheet}</p>
              {r.successCount > 0 && <p style={{ color: '#3B6D11' }}>成功匯入 {r.successCount} 筆</p>}
              {r.errors.length > 0 && (
                <ul style={{ color: '#A32D2D', paddingLeft: 18, fontSize: 12 }}>
                  {r.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {r.errors.length > 20 && <li>…還有 {r.errors.length - 20} 筆錯誤</li>}
                </ul>
              )}
            </div>
          ))}
          {skipped.length > 0 && <p style={{ fontSize: 12, color: '#999' }}>檔案中沒有這些工作表，已略過：{skipped.join('、')}</p>}
        </div>
      )}
    </div>
  );
}
