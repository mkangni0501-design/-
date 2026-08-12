import { supabase } from '@/lib/supabaseClient';

// 對應 sql/01_department_rbac_refactor.sql 的 admin_department / department_level enum
export type AdminDepartment = 'dev' | 'academic' | 'discipline' | 'general';
export type DepartmentLevel = 'lead' | 'staff';

export const DEPARTMENT_LABEL: Record<AdminDepartment, string> = {
  dev: '開發人員',
  academic: '教務',
  discipline: '訓導',
  general: '總務',
};

export type MyDepartment = { department: AdminDepartment; level: DepartmentLevel };

/** 讀取目前登入者身兼的所有部門職務（可能同時身兼多個）。system_admin_s 不會出現在這張表，另外用 isSystemAdmin 判斷。 */
export async function getMyDepartments(userId: string): Promise<MyDepartment[]> {
  const { data, error } = await supabase
    .from('app_user_departments')
    .select('department, level')
    .eq('app_user_id', userId);
  if (error) {
    console.error('讀取部門職務失敗', error);
    return [];
  }
  return (data ?? []) as MyDepartment[];
}

/** 是否身兼某部門（不分 lead/staff） */
export function hasDepartment(mine: MyDepartment[], dept: AdminDepartment): boolean {
  return mine.some((d) => d.department === dept);
}

/** 是否是某部門的主管層級（lead） —— 對應資料庫端 is_department_lead()，可以直接寫入受管資料表、可以核准送審 */
export function isDepartmentLead(mine: MyDepartment[], dept: AdminDepartment): boolean {
  return mine.some((d) => d.department === dept && d.level === 'lead');
}

/** 讀取某個帳號的部門職務（給帳號管理頁面用，管理其他人時用） */
export async function getDepartmentsFor(userId: string): Promise<MyDepartment[]> {
  return getMyDepartments(userId);
}

/** 系統管理員 S 用：整批寫入某帳號的部門職務清單（先刪除舊的再重新插入，簡單可靠） */
export async function setDepartmentsFor(userId: string, departments: MyDepartment[]): Promise<{ error: string | null }> {
  const { error: delErr } = await supabase.from('app_user_departments').delete().eq('app_user_id', userId);
  if (delErr) return { error: '清除舊部門職務失敗：' + delErr.message };
  if (departments.length === 0) return { error: null };
  const { error: insErr } = await supabase.from('app_user_departments').insert(
    departments.map((d) => ({ app_user_id: userId, department: d.department, level: d.level }))
  );
  if (insErr) return { error: '寫入新部門職務失敗：' + insErr.message };
  return { error: null };
}
