import { supabase } from './supabaseClient';

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六'];

export const DEPARTMENTS = ['幼兒園', '國小', '國中', '高中'];

export type PeriodConfigRow = {
  id: string;
  scope: '全校' | '部別' | '班級';
  scope_ref: string | null;
  weekday: number;
  period_count: number;
};

// 找不到任何設定時的保底堂數（避免畫面完全空白）
const FALLBACK_PERIOD_COUNT = 8;

/**
 * 依「班級 > 部別 > 全校」優先順序，取得某個星期幾的堂數設定。
 * classId 用來比對 scope='班級' 的覆寫；department 用來比對 scope='部別'。
 */
export async function getEffectivePeriodCount(
  weekday: number,
  department: string,
  classId: string
): Promise<number> {
  const { data } = await supabase
    .from('period_config')
    .select('scope, scope_ref, period_count')
    .eq('weekday', weekday)
    .order('scope_ref', { ascending: false, nullsFirst: false });

  const rows = (data ?? []) as PeriodConfigRow[];
  const classRow = rows.find((r) => r.scope === '班級' && r.scope_ref === classId);
  if (classRow) return classRow.period_count;
  const deptRow = rows.find((r) => r.scope === '部別' && r.scope_ref === department);
  if (deptRow) return deptRow.period_count;
  const schoolRow = rows.find((r) => r.scope === '全校');
  if (schoolRow) return schoolRow.period_count;
  return FALLBACK_PERIOD_COUNT;
}

// ---------- 帳號角色階層（用於「帳號管理」頁的角色編輯/密碼重製權限判斷） ----------
export const ROLE_LEVEL: Record<string, number> = {
  system_admin_s: 4,
  admin_a: 3,
  admin_b: 2,
  homeroom_teacher: 1,
  subject_teacher: 1,
};

/** 目前登入者是否有權限編輯目標帳號的角色／重設其密碼：必須階層嚴格高於對方，且系統管理員S帳號本身永遠不能被此功能異動 */
export function canManageAccount(myRole: string, targetRole: string): boolean {
  if (targetRole === 'system_admin_s') return false;
  return (ROLE_LEVEL[myRole] ?? 0) > (ROLE_LEVEL[targetRole] ?? 0);
}

/** 某角色可以把目標帳號改成哪些角色（一律只能往下，不能改成跟自己同階或更高） */
export function assignableRoles(myRole: string): string[] {
  const myLevel = ROLE_LEVEL[myRole] ?? 0;
  return Object.entries(ROLE_LEVEL)
    .filter(([role, level]) => role !== 'system_admin_s' && level < myLevel)
    .map(([role]) => role);
}

/**
 * 把姓名「正規化」成比對用的樣子：去掉所有空白（含全形空格）、全形英數字轉半形。
 * 用來判斷「王小明」「王 小明」「王　小明」「Ｗａｎｇ小明」這種其實是同一個人、只是打法不同的姓名。
 * 帳號管理新增帳號時，比對系統裡「還沒連結帳號」的既有教師資料用這個，不用管理者自己肉眼一筆一筆看。
 */
export function normalizeNameForMatch(name: string): string {
  return (name || '')
    .replace(/[\u3000\s]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * 判斷兩個姓名很可能是同一個人：正規化後完全相同，或其中一個是另一個的簡稱
 * （例如「王小明」vs「王明」這種拿掉中間字的簡稱），至少要有2個字才算，避免只有一個菜市場姓氏就誤判。
 * 這只是「很可能是同一人」的提示用比對，實際綁不綁定一律要管理者親眼看過資料再確認，不會自動綁定。
 */
export function namesLikelySamePerson(a: string, b: string): boolean {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 2 && longer.includes(shorter);
}
