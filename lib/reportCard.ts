import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardData } from '@/lib/ReportCardDocument';

const SCHOOL_NAME = '泰國清萊雲南會館附屬華雲學校'; // 依實際校名調整

export type ReportCardResult =
  | { ready: true; data: ReportCardData; studentNo: string; studentName: string }
  | { ready: false; studentNo: string; studentName: string; reason: string };

// 單一學生：組出成績單需要的資料。
// ready = false 代表期中/期末/平時分沒有三個都鎖定（依 03_ranking_lock_granularity_fix.sql
// 的規則，這種情況 class_rankings/grade_rankings 的 total_score 會是 null），
// 不應該產出正式成績單。
export async function getReportCardResult(enrollmentId: string): Promise<ReportCardResult> {
  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, seat_no, term, students(student_no, name), classes(id, class_name, grade_level, academic_year, homeroom_teacher_id)')
    .eq('id', enrollmentId)
    .single();

  if (!enrollment) {
    return { ready: false, studentNo: '', studentName: '', reason: '找不到學籍資料' };
  }

  const cls: any = enrollment.classes;
  const studentNo = (enrollment as any).students.student_no;
  const studentName = (enrollment as any).students.name;

  const { data: totalRow } = await supabaseAdmin
    .from('student_total_scores')
    .select('total_score')
    .eq('enrollment_id', enrollmentId)
    .single();

  const { data: classRankRow } = await supabaseAdmin
    .from('class_rankings')
    .select('class_rank, total_score')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle();

  // total_score 是 null 代表期中/期末/平時分沒有三個都鎖定，這個學生的成績單還不能正式產出
  if (!classRankRow || classRankRow.total_score === null) {
    return { ready: false, studentNo, studentName, reason: '期中/期末/平時分尚未三項都鎖定' };
  }

  const { data: gradeRankRow } = await supabaseAdmin.from('grade_rankings').select('grade_rank').eq('enrollment_id', enrollmentId).maybeSingle();
  const { data: subjectRows } = await supabaseAdmin
    .from('subject_weighted_scores')
    .select('subject, midterm, final, daily, subject_weighted_score')
    .eq('enrollment_id', enrollmentId);
  const { data: remarkRow } = await supabaseAdmin.from('student_remarks').select('comment').eq('enrollment_id', enrollmentId).maybeSingle();

  const { data: attendanceRows } = await supabaseAdmin.from('attendance').select('status').eq('student_no', studentNo);
  const attendanceCounts: Record<string, number> = {};
  (attendanceRows ?? []).forEach((r: any) => {
    if (r.status !== '出席') attendanceCounts[r.status] = (attendanceCounts[r.status] ?? 0) + 1;
  });
  const attendanceSummary =
    Object.entries(attendanceCounts).map(([k, v]) => `${k}${v}`).join('、') || '全勤';

  const { data: conductRows } = await supabaseAdmin.from('conduct_events').select('points').eq('student_no', studentNo);
  const conductBase = 80; // 依實際規則調整基本操行分
  const conductAdjust = (conductRows ?? []).reduce((sum: number, r: any) => sum + r.points, 0);

  const data: ReportCardData = {
    schoolName: SCHOOL_NAME,
    academicYear: cls.academic_year,
    term: enrollment.term,
    className: `${cls.grade_level}${cls.class_name}`,
    seatNo: enrollment.seat_no,
    studentName,
    subjects: (subjectRows ?? []).map((s: any) => ({
      subject: s.subject,
      midterm: s.midterm,
      final: s.final,
      daily: s.daily,
      weightedScore: s.subject_weighted_score,
    })),
    totalScore: totalRow?.total_score ?? 0,
    classRank: classRankRow?.class_rank ?? 0,
    gradeRank: gradeRankRow?.grade_rank ?? 0,
    conduct: conductBase + conductAdjust,
    attendanceSummary,
    remark: remarkRow?.comment ?? '',
  };

  return { ready: true, data, studentNo, studentName };
}

// 驗證呼叫者是否有權限拿到某個班級的成績單。
// 這裡同時檢查「新版部門(app_user_departments 有 academic)」與「舊版角色欄位
// (admin_a/admin_b/system_admin_s)」，在 01_department_rbac_refactor.sql 套用、
// 帳號部門歸屬名單尚未整理完成之前，兩套判斷同時允許通過，避免交接空窗期間
// 教務同仁反而印不出成績單；等部門歸屬名單確認齊全後，可以把舊角色判斷那段刪掉，
// 只留部門判斷。
export async function canAccessClass(callerUserId: string, classId: string): Promise<boolean> {
  const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerUserId).single();
  const isLegacyAdmin = callerProfile && ['admin_a', 'admin_b', 'system_admin_s'].includes(callerProfile.role);
  if (isLegacyAdmin) return true;

  const { data: deptRow } = await supabaseAdmin
    .from('app_user_departments')
    .select('department')
    .eq('app_user_id', callerUserId)
    .eq('department', 'academic')
    .maybeSingle();
  if (deptRow) return true;

  const { data: callerTeacher } = await supabaseAdmin.from('teachers').select('id').eq('app_user_id', callerUserId).maybeSingle();
  if (!callerTeacher) return false;

  const { data: cls } = await supabaseAdmin.from('classes').select('homeroom_teacher_id').eq('id', classId).maybeSingle();
  return !!cls && cls.homeroom_teacher_id === callerTeacher.id;
}
