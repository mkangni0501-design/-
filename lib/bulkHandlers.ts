import { supabase } from './supabaseClient';
import { departmentForGrade, SPECIFIC_GRADE_LEVELS } from './gradeMapping';

export type UploadResult = { successCount: number; errors: string[] };

const WEEKDAY_LABEL_TO_NUM: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

/* -------------------- 共用小工具 -------------------- */

// 依教師姓名找到既有教師，找不到就直接建立一筆新的（教師名稱用打的即可）
export async function resolveTeacherByName(name: string): Promise<string | null> {
  if (!name || !name.trim()) return null;
  const { data: existing } = await supabase.from('teachers').select('id').eq('name', name.trim()).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await supabase.from('teachers').insert({ name: name.trim() }).select('id').single();
  if (error || !created) throw new Error('建立教師失敗：' + error?.message);
  return created.id;
}

// 依學年度/年級/班級找到既有班級，找不到就直接建立
export async function resolveClassId(academicYear: number, gradeLevel: string, className: string): Promise<string> {
  const department = departmentForGrade(gradeLevel);
  const { data: existing } = await supabase
    .from('classes')
    .select('id')
    .eq('academic_year', academicYear)
    .eq('department', department)
    .eq('grade_level', gradeLevel)
    .eq('class_name', className)
    .maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await supabase
    .from('classes')
    .insert({ academic_year: academicYear, department, grade_level: gradeLevel, class_name: className })
    .select('id')
    .single();
  if (error || !created) throw new Error('建立班級失敗：' + error?.message);
  return created.id;
}

/* -------------------- 1. 班級與導師設定 -------------------- */
// 格式：序號,部別(其實是年級),班級名稱,合併名稱,泰文代碼,男生,女生,合計,級任老師（第3列起為資料）
export async function uploadClassesSheet(rowsRaw: any[][], academicYear: number): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[1] == null || r[2] == null) continue; // 跳過空列/合計列
    const gradeLevel = String(r[1]).trim();
    const className = String(r[2]).trim();
    const teacherName = r[8] != null ? String(r[8]).trim() : '';
    try {
      const teacherId = await resolveTeacherByName(teacherName);
      const { error } = await supabase.from('classes').upsert(
        {
          academic_year: academicYear,
          department: departmentForGrade(gradeLevel),
          grade_level: gradeLevel,
          class_name: className,
          homeroom_teacher_id: teacherId,
        },
        { onConflict: 'academic_year,department,grade_level,class_name' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${gradeLevel}${className}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 2. 科目與比重設定 -------------------- */
// 格式：row1為表頭(含各年級欄位標題)，row2起每列一個科目，具體年級欄位裡的值＝那個年級對這個科目的名稱
export async function uploadCurriculumSheet(rowsRaw: any[][], term: string): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const header = rowsRaw[0] ?? [];
  const gradeColumns: { index: number; grade: string }[] = [];
  header.forEach((h, idx) => {
    if (h && SPECIFIC_GRADE_LEVELS.includes(String(h).trim())) {
      gradeColumns.push({ index: idx, grade: String(h).trim() });
    }
  });

  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r) continue;
    const academicYear = Number(r[0]);
    const weight = Number(r[5]);
    const periods = r[6] != null ? Number(r[6]) : null;
    if (!academicYear || Number.isNaN(weight)) continue;

    for (const { index, grade } of gradeColumns) {
      const subject = r[index];
      if (!subject || String(subject).trim() === '以下空白') continue;
      try {
        const { error } = await supabase.from('curriculum').upsert(
          { academic_year: academicYear, term, grade_level: grade, subject: String(subject).trim(), weight, periods },
          { onConflict: 'academic_year,term,grade_level,subject' }
        );
        if (error) throw new Error(error.message);
        successCount++;
      } catch (err: any) {
        errors.push(`第${i + 1}列 ${grade}：${err.message}`);
      }
    }
  }
  return { successCount, errors };
}

/* -------------------- 3. 整體佔比與加扣分規則 -------------------- */
// A2:C3(index1:2列) = 期中考/期末考/平時 三個整體佔比；E欄(index4)「項目」/F欄(index5)「分數」= 加扣分參考值
export async function uploadGradingRulesSheet(rowsRaw: any[][], academicYear: number, term: string): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  const weightsRow = rowsRaw[2];
  if (weightsRow && weightsRow[0] != null) {
    const { error } = await supabase.from('grading_rules').upsert(
      {
        academic_year: academicYear,
        term,
        midterm_weight: Number(weightsRow[0]),
        final_weight: Number(weightsRow[1]),
        daily_weight: Number(weightsRow[2]),
      },
      { onConflict: 'academic_year,term' }
    );
    if (error) errors.push('整體佔比：' + error.message);
    else successCount++;
  }

  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[4] == null || r[5] == null) continue;
    const { error } = await supabase.from('conduct_point_defaults').upsert({ item: String(r[4]).trim(), points: Number(r[5]) });
    if (error) errors.push(`${r[4]}：${error.message}`);
    else successCount++;
  }

  return { successCount, errors };
}

/* -------------------- 4. 既有學生快速建檔（精簡版） -------------------- */
// 年度,學期,年級,班級,學號,姓名,座號,導師評語,曠課...大過,操行（第3列起為資料）
export async function uploadStudentsImportSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const classCache = new Map<string, string>();

  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[4] == null || r[5] == null) continue; // 沒有學號/姓名就跳過
    const academicYear = Number(r[0]);
    const term = String(r[1]).trim();
    const gradeLevel = String(r[2]).trim();
    const className = String(r[3]).trim();
    const studentNo = String(r[4]).trim();
    const name = String(r[5]).trim();
    const seatNo = Number(r[6]);

    try {
      const cacheKey = `${academicYear}-${gradeLevel}-${className}`;
      let classId = classCache.get(cacheKey);
      if (!classId) {
        classId = await resolveClassId(academicYear, gradeLevel, className);
        classCache.set(cacheKey, classId);
      }

      const { data: existingStudent } = await supabase.from('students').select('student_no').eq('student_no', studentNo).maybeSingle();
      if (!existingStudent) {
        const { error: studentErr } = await supabase.from('students').insert({ student_no: studentNo, name });
        if (studentErr) throw new Error(studentErr.message);
      }

      await upsertEnrollment(studentNo, classId, term, seatNo);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}／${studentNo}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

// 把一個學生編到某班某學期的某個座號。可以重複呼叫（例如重新上傳同一份檔案修正錯誤）：
// - 這個學生在這班這學期已經有學籍列 → 直接更新座號，不會因為 (class_id, term, seat_no) 的唯一限制而衝突
// - 座號被別的學生佔用 → 丟出看得懂的錯誤訊息，而不是資料庫的 duplicate key 原始錯誤
// - 都沒有 → 把這個學生原本其他「現行」學籍標成非現行，再新增這筆
export async function upsertEnrollment(studentNo: string, classId: string, term: string, seatNo: number) {
  const { data: sameEnrollment } = await supabase
    .from('enrollments')
    .select('id')
    .eq('student_no', studentNo)
    .eq('class_id', classId)
    .eq('term', term)
    .maybeSingle();

  if (sameEnrollment) {
    const { error } = await supabase.from('enrollments').update({ seat_no: seatNo, is_current: true }).eq('id', sameEnrollment.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { data: seatTaken } = await supabase
    .from('enrollments')
    .select('student_no')
    .eq('class_id', classId)
    .eq('term', term)
    .eq('seat_no', seatNo)
    .maybeSingle();
  if (seatTaken && seatTaken.student_no !== studentNo) {
    throw new Error(`座號${seatNo}已經被學號${seatTaken.student_no}使用，請確認座號有沒有填錯或重複`);
  }

  await supabase.from('enrollments').update({ is_current: false }).eq('student_no', studentNo).eq('is_current', true);
  const { error } = await supabase.from('enrollments').insert({ student_no: studentNo, class_id: classId, term, seat_no: seatNo });
  if (error) throw new Error(error.message);
}

/* -------------------- 5. 任課教師設定（class_schedule，不含星期/節次） -------------------- */
// 學年度,學期,年級,班級,科目,任課教師（第3列起為資料）
// 這裡的 class_schedule 資料列 weekday/period_no 都是 null，代表「只是設定誰教哪班哪科」，
// 不是實際課表時段（時段請用「學校課表」設定）。因為 null 在 unique constraint 裡彼此不算重複，
// 所以用「先查再新增/更新」，不能用 upsert 的 onConflict。
export async function uploadTeacherAssignmentsSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const classCache = new Map<string, string>();

  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[4] == null) continue; // 沒有科目就跳過
    const academicYear = Number(r[0]);
    const term = String(r[1]).trim();
    const gradeLevel = String(r[2]).trim();
    const className = String(r[3]).trim();
    const subject = String(r[4]).trim();
    const teacherName = r[5] != null ? String(r[5]).trim() : '';

    try {
      if (!academicYear || !term) throw new Error('學年度或學期格式不正確');
      const teacherId = await resolveTeacherByName(teacherName);
      if (!teacherId) throw new Error('未填寫任課教師姓名');

      const cacheKey = `${academicYear}-${gradeLevel}-${className}`;
      let classId = classCache.get(cacheKey);
      if (!classId) {
        classId = await resolveClassId(academicYear, gradeLevel, className);
        classCache.set(cacheKey, classId);
      }

      await upsertTeacherAssignment(classId, academicYear, term, subject, teacherId);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${gradeLevel}${className} ${subject}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

// 找同班同科目、weekday為null的既有「任課教師設定」列，有就更新老師，沒有就新增一列
export async function upsertTeacherAssignment(classId: string, academicYear: number, term: string, subject: string, teacherId: string) {
  const { data: existing } = await supabase
    .from('class_schedule')
    .select('id')
    .eq('class_id', classId)
    .eq('academic_year', academicYear)
    .eq('term', term)
    .eq('subject', subject)
    .is('weekday', null)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from('class_schedule').update({ teacher_id: teacherId }).eq('id', existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('class_schedule').insert({
      class_id: classId,
      academic_year: academicYear,
      term,
      subject,
      teacher_id: teacherId,
      weekday: null,
      period_no: null,
    });
    if (error) throw new Error(error.message);
  }
}

/* -------------------- 5b. 學校課表（class_schedule，含星期/節次） -------------------- */
// 學年度,學期,年級,班級,星期(一~六),節次,科目,任課教師（第3列起為資料）
export async function uploadSchoolTimetableSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];
  const classCache = new Map<string, string>();

  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[4] == null || r[5] == null || r[6] == null) continue; // 星期/節次/科目缺一不可
    const academicYear = Number(r[0]);
    const term = String(r[1]).trim();
    const gradeLevel = String(r[2]).trim();
    const className = String(r[3]).trim();
    const weekdayRaw = String(r[4]).trim();
    const weekday = WEEKDAY_LABEL_TO_NUM[weekdayRaw] ?? Number(weekdayRaw);
    const periodNo = Number(r[5]);
    const subject = String(r[6]).trim();
    const teacherName = r[7] != null ? String(r[7]).trim() : '';

    try {
      if (!academicYear || !term) throw new Error('學年度或學期格式不正確');
      if (!weekday || Number.isNaN(periodNo)) throw new Error('星期或節次格式不正確');
      const teacherId = await resolveTeacherByName(teacherName);
      if (!teacherId) throw new Error('未填寫任課教師姓名');

      const cacheKey = `${academicYear}-${gradeLevel}-${className}`;
      let classId = classCache.get(cacheKey);
      if (!classId) {
        classId = await resolveClassId(academicYear, gradeLevel, className);
        classCache.set(cacheKey, classId);
      }

      const { error } = await supabase.from('class_schedule').upsert(
        { class_id: classId, academic_year: academicYear, term, weekday, period_no: periodNo, subject, teacher_id: teacherId },
        { onConflict: 'class_id,academic_year,term,weekday,period_no' }
      );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${gradeLevel}${className} 星期${weekdayRaw} 第${r[5]}節）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 5c. 節次設定（period_config，只支援全校/部別範圍） -------------------- */
// 範圍(全校/部別),部別(範圍=全校時留空),星期(一~六),堂數（第3列起為資料）
export async function uploadPeriodConfigSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || r[2] == null || r[3] == null) continue; // 範圍/星期/堂數缺一不可
    const scope = String(r[0]).trim();
    const scopeRef = scope === '部別' ? String(r[1] ?? '').trim() : null;
    const weekdayRaw = String(r[2]).trim();
    const weekday = WEEKDAY_LABEL_TO_NUM[weekdayRaw] ?? Number(weekdayRaw);
    const periodCount = Number(r[3]);

    try {
      if (scope !== '全校' && scope !== '部別') throw new Error('範圍請填「全校」或「部別」');
      if (scope === '部別' && !scopeRef) throw new Error('範圍是「部別」時，部別欄位不可空白');
      if (!weekday) throw new Error('星期格式不正確');
      if (Number.isNaN(periodCount)) throw new Error('堂數格式不正確');

      const query = supabase.from('period_config').select('id').eq('scope', scope).eq('weekday', weekday);
      const { data: existing } = scopeRef ? await query.eq('scope_ref', scopeRef).maybeSingle() : await query.is('scope_ref', null).maybeSingle();

      if (existing) {
        const { error } = await supabase.from('period_config').update({ period_count: periodCount }).eq('id', existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('period_config').insert({ scope, scope_ref: scopeRef, weekday, period_count: periodCount });
        if (error) throw new Error(error.message);
      }
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（${scope}${scopeRef ? '／' + scopeRef : ''} 星期${weekdayRaw}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 6. 帳號名單（app_users，批次邀請） -------------------- */
// allowedRoles 要傳目前登入者實際可以新增的角色（跟畫面上「新增」表單的規則一致）：
// 系統管理員S可建立 admin_a/admin_b/導師/任課教師；系統管理員A可建立admin_a/導師/任課教師；
// 管理員B可建立admin_b/導師/任課教師。導師/任課教師帳號建立時會自動連結（或建立）teachers資料列。
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function inviteAccountsSheet(rowsRaw: any[][], accessToken: string, allowedRoles: string[]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  for (let i = 2; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || r[1] == null || r[2] == null) continue; // 姓名/信箱/角色缺一不可
    const name = String(r[0]).trim();
    const email = String(r[1]).trim();
    const role = String(r[2]).trim();
    const password = r[3] != null ? String(r[3]).trim() : '';

    try {
      if (!allowedRoles.includes(role)) {
        throw new Error(`角色「${role}」不正確，或您沒有權限新增此角色（可填：${allowedRoles.join('／')}）`);
      }
      const res = await fetch('/api/admin/invite-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ email, name, role, password: password || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message: string = body.error ?? '新增失敗';
        // 這個信箱已經邀請過、已經有帳號了 → 當作「略過」，不算失敗，重複上傳同一份檔案時不會一直報錯
        if (res.status === 409 || /ALREADY_EXISTS/i.test(message)) {
          errors.push(`第${i + 1}列（${name}／${email}）：這個信箱已經有帳號了，已略過`);
          continue;
        }
        // Supabase 內建郵件服務的寄信頻率限制：達到上限後，剩下的一定都會失敗，
        // 與其逐筆繼續撞牆報錯，不如立刻停下來，把已經成功的筆數跟清楚的原因回報給使用者。
        if (/rate limit/i.test(message)) {
          errors.push(
            `第${i + 1}列以後尚未處理：已達 Supabase 郵件發送頻率限制（${message}）。這一列以前已成功邀請 ${successCount} 位，請稍後幾分鐘再重新上傳同一份檔案繼續（已經成功邀請過的信箱會自動略過、不會重複發信），或到 Supabase 後台設定自訂 SMTP 以提高寄信上限。`
          );
          break;
        }
        throw new Error(message);
      }
      successCount++;
      if (!password) {
        await sleep(1200); // 沒填密碼、走邀請信流程時才需要間隔，降低短時間內連續寄信撞到頻率限制的機會
      }
    } catch (err: any) {
      errors.push(`第${i + 1}列（${name}／${email}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 7. 全校成績（現況）批次上傳 -------------------- */
// 格式跟 lib/schoolWideDataQueries.ts 的 fetchAllScoresSheet() 下載出來的一致：
// 學年度,學期,部別,年級,班級,座號,學號,姓名,考試類型,科目,分數（第2列起為資料）
export async function uploadAllScoresSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[6] == null) continue; // 學號欄空白就跳過
    const studentNo = String(r[6]).trim();
    const examType = r[8] != null ? String(r[8]).trim() : '';
    const subject = r[9] != null ? String(r[9]).trim() : '';
    const score = r[10];
    if (!examType || !subject || score == null || score === '') continue;

    try {
      const { data: enroll, error: enrollErr } = await supabase
        .from('enrollments')
        .select('id')
        .eq('student_no', studentNo)
        .eq('is_current', true)
        .maybeSingle();
      if (enrollErr) throw new Error(enrollErr.message);
      if (!enroll) throw new Error('找不到這個學號目前在學的學籍');

      const { error } = await supabase
        .from('scores')
        .upsert({ enrollment_id: enroll.id, exam_type: examType, subject, score: Number(score) }, { onConflict: 'enrollment_id,exam_type,subject' });
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（學號${studentNo}／${examType}／${subject}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 7b. 全校獎懲（現況）批次上傳 -------------------- */
// 格式跟 lib/schoolWideDataQueries.ts 的 fetchAllConductSheet() 下載出來的一致：
// 學號,姓名,日期,項目,分數,記錄人（第2列起為資料；姓名欄只是方便肉眼核對，上傳時不會用到）
// conduct_events 本來就沒有登錄頁面也沒有上傳功能，這裡新增之後要搭配
// sql/28conduct_events_write_and_import.sql 一起執行（RLS 開放管理者寫入＋加一個
// (student_no,event_date,event_type) 的唯一限制，讓同一份檔案重複上傳時用「更新」取代「一直新增重複列」）。
const CONDUCT_EVENT_TYPES = ['嘉獎', '小功', '大功', '警告', '小過', '大過'];

export async function uploadAllConductSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || r[2] == null || r[3] == null) continue; // 學號/日期/項目缺一不可
    const studentNo = String(r[0]).trim();
    const eventType = String(r[3]).trim();
    const points = r[4];
    const recorderName = r[5] != null ? String(r[5]).trim() : '';
    const rawDate = r[2];
    const dateStr =
      rawDate instanceof Date
        ? rawDate.toISOString().slice(0, 10)
        : typeof rawDate === 'number'
        ? new Date(Math.round((rawDate - 25569) * 86400 * 1000)).toISOString().slice(0, 10)
        : String(rawDate).trim();

    try {
      if (!studentNo) throw new Error('學號空白');
      if (!CONDUCT_EVENT_TYPES.includes(eventType)) throw new Error(`項目「${eventType}」不正確，只能填：${CONDUCT_EVENT_TYPES.join('／')}`);
      if (points == null || points === '' || Number.isNaN(Number(points))) throw new Error('分數格式不正確');
      const recorderId = recorderName ? await resolveTeacherByName(recorderName) : null;

      const { error } = await supabase
        .from('conduct_events')
        .upsert(
          { student_no: studentNo, event_date: dateStr, event_type: eventType, points: Number(points), recorded_by: recorderId },
          { onConflict: 'student_no,event_date,event_type' }
        );
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（學號${studentNo}／${dateStr}／${eventType}）：${err.message}`);
    }
  }
  return { successCount, errors };
}

/* -------------------- 8. 全校出缺勤（現況）批次上傳 -------------------- */
// 格式跟 fetchAllAttendanceSheet() 下載出來的一致：學號,姓名,日期,節次,狀態（第2列起為資料）
export async function uploadAllAttendanceSheet(rowsRaw: any[][]): Promise<UploadResult> {
  let successCount = 0;
  const errors: string[] = [];

  for (let i = 1; i < rowsRaw.length; i++) {
    const r = rowsRaw[i];
    if (!r || r[0] == null || r[2] == null || r[3] == null || r[4] == null) continue;
    const studentNo = String(r[0]).trim();
    const periodNo = Number(r[3]);
    const status = String(r[4]).trim();
    const rawDate = r[2];
    const dateStr =
      rawDate instanceof Date
        ? rawDate.toISOString().slice(0, 10)
        : typeof rawDate === 'number'
        ? new Date(Math.round((rawDate - 25569) * 86400 * 1000)).toISOString().slice(0, 10)
        : String(rawDate).trim();

    try {
      if (!studentNo) throw new Error('學號空白');
      if (Number.isNaN(periodNo)) throw new Error('節次格式不正確');
      if (!status) throw new Error('狀態空白');
      const { error } = await supabase
        .from('attendance')
        .upsert({ student_no: studentNo, record_date: dateStr, period_no: periodNo, status }, { onConflict: 'student_no,record_date,period_no' });
      if (error) throw new Error(error.message);
      successCount++;
    } catch (err: any) {
      errors.push(`第${i + 1}列（學號${studentNo}／${dateStr}／第${r[3]}節）：${err.message}`);
    }
  }
  return { successCount, errors };
}
