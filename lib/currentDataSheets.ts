import { supabase } from './supabaseClient';
import { SPECIFIC_GRADE_LEVELS } from './gradeMapping';
import type { SheetRows } from './schoolWideDataQueries';

// ============================================================
// 問題根源（管理員S反映「一鍵下載的資料有大量缺失」）：
// 「下載完整資料快照」原本呼叫的是 buildDeveloperSetupSheets()——那組函式是
// 設計給「全新學校第一次建檔」用的空白範本產生器（每張表只有2列示範資料），
// 除了「帳號名單」以外，7張表完全不是從資料庫查出來的真實現況，
// 卻被放進標榜「完整資料快照」的下載檔案裡，難怪打開來看幾乎全是空的。
// 這個檔案補上「真的去查資料庫現況」的版本，取代那7張假資料。
// ============================================================

// 注意：這裡原本自己另外寫了一份 SPECIFIC_GRADE_LEVELS（幼幼班/小班/中班/大班...），
// 跟 lib/gradeMapping.ts 真正在用的年級代碼（幼兒園/幼甲/幼乙...）完全對不上——
// 貴校幼兒園只分「幼乙、幼甲」兩個年級，用錯的那份清單會找不到任何幼兒園的科目/比重資料，
// 下載「科目與比重設定(現況)」時幼兒園那幾欄會整個是空的。改成直接 import 同一份，
// 之後年級代碼異動只要改 gradeMapping.ts 一個地方，不會有第二份跟著不同步。

/**
 * 帳號名單（目前現況）：姓名／電子郵件／角色，跟上傳範本同樣4欄（初始密碼留空＝上傳時走邀請信流程，不會覆蓋密碼）
 *
 * 【2026-08 修正】這裡原本直接 `select('name, email, role')`，但 `email` 其實不是
 * `app_users` 表的欄位——信箱存在 Supabase Auth（`auth.users`），`app_users` 只有
 * id/name/role/created_at（見 sql/1schema.sql），前端一般權限也查不到 `auth.users`。
 * 原本這樣寫從一開始就會整批失敗，回傳「讀取失敗：column app_users.email does not exist」，
 * 導致「下載完整資料快照」的帳號名單那一頁完全讀不到。
 * 系統其實已經有現成、安全的作法可以補回信箱——`app/api/admin/list-accounts-with-email`
 * （帳號管理頁本來就在用，用呼叫者的 access token 驗證身分/角色後，用 service role
 * 呼叫 `auth.admin.listUsers()` 把信箱查回來，只回傳有要求的那幾個 id），這裡改成
 * 先查 app_users 拿 id/name/role，再帶 accessToken 呼叫這支 API 補上信箱。
 * accessToken 沒帶（呼叫端沒登入/沒傳）時，信箱欄位留空但姓名/角色仍然照常列出，
 * 不會讓整張表變成「讀取失敗」。
 */
export async function fetchCurrentAccountsSheet(accessToken?: string): Promise<SheetRows> {
  const { data, error } = await supabase.from('app_users').select('id, name, role').order('name');
  if (error || !data) return { name: '帳號名單(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };

  let emails: Record<string, string | null> = {};
  if (accessToken && data.length > 0) {
    try {
      const res = await fetch('/api/admin/list-accounts-with-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ userIds: data.map((u: any) => u.id) }),
      });
      const json = await res.json();
      if (res.ok) emails = json.emails ?? {};
    } catch {
      // 查信箱失敗不影響姓名/角色照常輸出，只是信箱欄位留空
    }
  }

  const rows = data.map((u: any) => [u.name, emails[u.id] ?? '', u.role, '']);
  return { name: '帳號名單(現況)', aoa: [['姓名', '電子郵件', '角色', '初始密碼(留空)'], ...rows] };
}

/** 班級與導師設定（目前現況） */
export async function fetchCurrentClassesSheet(academicYear: number): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('classes')
    .select('grade_level, class_name, department, teachers(name)')
    .eq('academic_year', academicYear)
    .order('grade_level')
    .order('class_name');
  if (error || !data) return { name: '班級與導師設定(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const rows = data.map((c: any) => ['', c.grade_level, c.class_name, '', '', '', '', '', c.teachers?.name ?? '']);
  const hintRow = [
    `⚠️ 改完重新上傳前請確認「部別(年級)」欄位是照下面這份清單「照字打」：${SPECIFIC_GRADE_LEVELS.join('、')}` +
      `（多一個字/少一個字，例如打成「初中一」，會讓這個班級對不到部別、對不到排課系統的年級，也會讓「科目與比重設定」抓不到對應資料）`,
    '', '', '', '', '', '', '', '',
  ];
  return {
    name: '班級與導師設定(現況)',
    aoa: [['序號', '部別(年級)', '班級名稱', '合併名稱', '泰文代碼', '男生', '女生', '合計', '級任老師'], hintRow, ...rows],
  };
}

/** 任課教師設定（目前現況）：class_schedule 依「班級+科目+老師」去重（不看星期/節次） */
export async function fetchCurrentTeacherAssignmentsSheet(academicYear: number, term: string): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('class_schedule')
    .select('subject, classes(grade_level, class_name), teachers(name)')
    .eq('academic_year', academicYear)
    .eq('term', term);
  if (error || !data) return { name: '任課教師設定(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const seen = new Set<string>();
  const rows: any[][] = [];
  for (const r of data as any[]) {
    const grade = r.classes?.grade_level ?? '';
    const cls = r.classes?.class_name ?? '';
    const teacher = r.teachers?.name ?? '';
    const key = `${grade}|${cls}|${r.subject}|${teacher}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([academicYear, term, grade, cls, r.subject, teacher]);
  }
  return { name: '任課教師設定(現況)', aoa: [['學年度', '學期', '年級', '班級', '科目', '任課教師'], ...rows] };
}

/** 學校課表（目前現況）：class_schedule 每一節逐列列出 */
export async function fetchCurrentSchoolTimetableSheet(academicYear: number, term: string): Promise<SheetRows> {
  const WEEKDAY_LABEL = ['', '一', '二', '三', '四', '五', '六'];
  const { data, error } = await supabase
    .from('class_schedule')
    .select('weekday, period_no, subject, classes(grade_level, class_name), teachers(name)')
    .eq('academic_year', academicYear)
    .eq('term', term)
    .order('weekday')
    .order('period_no');
  if (error || !data) return { name: '學校課表(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const rows = (data as any[]).map((r) => [
    academicYear,
    term,
    r.classes?.grade_level ?? '',
    r.classes?.class_name ?? '',
    WEEKDAY_LABEL[r.weekday] ?? r.weekday,
    r.period_no,
    r.subject,
    r.teachers?.name ?? '',
  ]);
  return { name: '學校課表(現況)', aoa: [['學年度', '學期', '年級', '班級', '星期(一~六)', '節次', '科目', '任課教師'], ...rows] };
}

/** 節次設定（目前現況） */
export async function fetchCurrentPeriodConfigSheet(): Promise<SheetRows> {
  const WEEKDAY_LABEL = ['', '一', '二', '三', '四', '五', '六'];
  const { data, error } = await supabase.from('period_config').select('scope, scope_ref, weekday, period_count').order('scope').order('weekday');
  if (error || !data) return { name: '節次設定(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const rows = (data as any[]).map((r) => [r.scope, r.scope_ref ?? '', WEEKDAY_LABEL[r.weekday] ?? r.weekday, r.period_count]);
  return { name: '節次設定(現況)', aoa: [['範圍(全校/部別)', '部別(範圍=全校時留空)', '星期(一~六)', '堂數'], ...rows] };
}

/** 整體佔比與加扣分規則（目前現況）：grading_rules 目前是「每學年學期一組期中/期末/平時比重」，
 *  加扣分項目（conduct_point_defaults）沒有學年學期區分，是全校共用一份 */
export async function fetchCurrentGradingRulesSheet(academicYear: number, term: string): Promise<SheetRows> {
  const [{ data: gr, error: grErr }, { data: cp, error: cpErr }] = await Promise.all([
    supabase.from('grading_rules').select('midterm_weight, final_weight, daily_weight').eq('academic_year', academicYear).eq('term', term).maybeSingle(),
    supabase.from('conduct_point_defaults').select('item, points').order('item'),
  ]);
  if (grErr || cpErr) return { name: '整體佔比與加扣分規則(現況)', aoa: [['讀取失敗：' + (grErr?.message ?? cpErr?.message ?? '未知錯誤')]] };
  const items = cp ?? [];
  const rows: any[][] = [];
  const maxLen = Math.max(1, items.length);
  for (let i = 0; i < maxLen; i++) {
    const item = items[i];
    rows.push([
      i === 0 ? gr?.midterm_weight ?? '' : '',
      i === 0 ? gr?.final_weight ?? '' : '',
      i === 0 ? gr?.daily_weight ?? '' : '',
      '',
      item?.item ?? '',
      item?.points ?? '',
    ]);
  }
  return { name: '整體佔比與加扣分規則(現況)', aoa: [['期中比重', '期末比重', '平時比重', '', '項目', '分數'], ...rows] };
}

/** 既有學生快速建檔格式的「目前現況」：只列基本學籍資料（曠課~操行等彙總欄位本來上傳就不會用到，這裡留空） */
export async function fetchCurrentStudentsSheet(academicYear: number, term: string): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('enrollments')
    .select('seat_no, students(student_no, name), classes(academic_year, grade_level, class_name)')
    .eq('term', term)
    .eq('is_current', true);
  if (error || !data) return { name: '既有學生快速建檔(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };
  const rows = (data as any[])
    .filter((r) => r.classes?.academic_year === academicYear)
    .map((r) => [
      academicYear,
      term,
      r.classes?.grade_level ?? '',
      r.classes?.class_name ?? '',
      r.students?.student_no ?? '',
      r.students?.name ?? '',
      r.seat_no,
      '',
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '',
    ]);
  const header = ['學年度', '學期', '年級', '班級', '學號', '姓名', '座號', '導師評語', '曠課', '遲到', '病假', '事假', '公假', '小功', '大功', '警告', '小過', '大過', '操行'];
  if (rows.length === 0) {
    return {
      name: '既有學生快速建檔(現況)',
      aoa: [
        [`查不到 ${academicYear}學年度／${term} 的在學學生資料。`],
        ['請先確認：上面填的學年度／學期是不是您要查的那一個（最容易的原因就是這裡填錯年度，跟資料庫實際存的年度對不上）；'],
        ['如果學年度／學期正確，代表這個系統目前還沒有任何學生資料，請用「既有學生快速建檔」範本上傳建檔。'],
        [],
        header,
      ],
    };
  }
  return {
    name: '既有學生快速建檔(現況)',
    aoa: [header, ...rows],
  };
}

/** 科目與比重設定（目前現況）：curriculum 是「每列一個學年度+比重+節數」，
 *  同一列可以有多個年級/科目共用同一組比重節數（用格子對應年級與科目名稱）。
 *  這裡把資料庫裡正規化的 (academic_year, grade_level, subject, weight, periods)
 *  依「比重+節數」分組還原成範本那種寬表格式；同一組比重節數裡同一年級出現兩個以上
 *  科目時，會另外多開一列避免互相蓋掉。 */
export async function fetchCurrentCurriculumSheet(academicYear: number, term: string): Promise<SheetRows> {
  const { data, error } = await supabase
    .from('curriculum')
    .select('grade_level, subject, weight, periods')
    .eq('academic_year', academicYear)
    .eq('term', term);
  if (error || !data) return { name: '科目與比重設定(現況)', aoa: [['讀取失敗：' + (error?.message ?? '未知錯誤')]] };

  const groups = new Map<string, any[]>(); // key = weight|periods
  for (const r of data as any[]) {
    const key = `${r.weight}|${r.periods ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const header = ['學年度', '(保留)', '(保留)', '(保留)', '(保留)', '比重(0-1)', '節數', ...SPECIFIC_GRADE_LEVELS];
  const rows: any[][] = [];
  for (const [key, items] of groups) {
    const [weightStr, periodsStr] = key.split('|');
    // 同一組比重/節數，可能有好幾個年級各自對到不同科目；每個年級的格子放科目名稱，
    // 若同一年級撞到第二個科目，另開一列處理
    const lines: any[][] = [];
    for (const item of items) {
      const idx = SPECIFIC_GRADE_LEVELS.indexOf(item.grade_level);
      if (idx === -1) continue;
      let line = lines.find((l) => !l[7 + idx]);
      if (!line) {
        line = [academicYear, '', '', '', '', Number(weightStr), periodsStr ? Number(periodsStr) : '', ...SPECIFIC_GRADE_LEVELS.map(() => '')];
        lines.push(line);
      }
      line[7 + idx] = item.subject;
    }
    rows.push(...lines);
  }
  return { name: '科目與比重設定(現況)', aoa: [header, ...rows] };
}
