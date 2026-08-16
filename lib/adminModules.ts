import { supabase } from './supabaseClient';
import type { AdminDepartment } from './departments';

// ============================================================
// 管理後台首頁「教務／訓導／總務／教師／家長學生／開發人員」六大分區設定
// ------------------------------------------------------------
// - ALL_MODULES：所有功能模組的固定資料（網址、名稱、是否僅限管理員），
//   這部分是程式碼決定的，不會被拖曳改變。
// - DEFAULT_CATEGORIES：模組尚未被自訂分類時的「預設分類」（大概分類，
//   一個模組可以對應多個分類，管理者S可再自行調整）。
// - 實際分類結果存在 Supabase 的 admin_module_categories 資料表，
//   如果該表還沒建立、或欄位還沒擴充到支援多分類（需執行
//   sql/26fix_department_recursion_and_module_visibility.sql）或讀取失敗，
//   就自動退回使用 DEFAULT_CATEGORIES，不會讓畫面壞掉。
// - 「某個帳號實際看不看得到某個功能」則是另一套規則，見下方
//   computeVisibleModuleKeys()：由角色／部門職務決定通則，
//   系統管理員S可再用 app_user_module_overrides 對單一帳號做例外調整。
// ============================================================

export type ModuleCategory = 'academic' | 'discipline' | 'general' | 'teacher' | 'parent_student' | 'dev';

export const CATEGORY_ORDER: ModuleCategory[] = ['academic', 'discipline', 'general', 'teacher', 'parent_student', 'dev'];

export const CATEGORY_LABEL: Record<ModuleCategory, string> = {
  academic: '教務',
  discipline: '訓導',
  general: '總務',
  teacher: '教師',
  parent_student: '家長／學生',
  dev: '開發人員',
};

export const CATEGORY_HINT: Record<ModuleCategory, string> = {
  academic: '課程、成績、課表、學籍與升級',
  discipline: '出缺勤、獎懲示警與學生資料異動審核',
  general: '總務庶務（書庫、校服、簿本、修繕、水電）',
  teacher: '教師教學作業與查詢',
  parent_student: '家長／學生登入帳號與相關資料',
  dev: '帳號、系統設定、備份與整批匯入匯出',
};

// 每個「僅限管理員」的分類，預設對應到哪個部門職務（app_user_departments）才看得到，
// 用於 computeVisibleModuleKeys()。teacher／parent_student 這兩區的模組預設不做部門檢查
// （通常本來就是 adminOnly:false，開放給所有已登入教職員）。
export const CATEGORY_REQUIRED_DEPARTMENT: Partial<Record<ModuleCategory, AdminDepartment>> = {
  academic: 'academic',
  discipline: 'discipline',
  general: 'general',
  dev: 'dev',
};

export type AdminModule = {
  key: string; // 用網址當唯一值
  href: string;
  label: string;
  adminOnly: boolean; // true＝僅系統設定／學籍管理等管理員功能；false＝一般教學作業／查詢，教師卡片也看得到
};

export const ALL_MODULES: AdminModule[] = [
  // ---- 教務 ----
  { key: '/admin/grading', href: '/admin/grading', label: '成績相關設定及查詢（含科目比重、加扣分規則、成績登錄、班級總表/排名、歷年查詢）', adminOnly: false },
  { key: '/admin/registrar', href: '/admin/registrar', label: '學籍設定及查詢（含查詢學生、新生登記、學籍異動、轉班、升級作業）', adminOnly: false },
  { key: '/admin/students/roster', href: '/admin/students/roster', label: '學生名冊（依班級查看座號/學號/姓名，點列看個人資料）', adminOnly: false },
  { key: '/admin/school-timetable', href: '/admin/school-timetable', label: '學校課表', adminOnly: true },
  { key: '/admin/scheduling', href: '/admin/scheduling', label: '排課系統（自動排課工具）', adminOnly: true },
  { key: '/admin/period-locks', href: '/admin/period-locks', label: '共同科目時間鎖定', adminOnly: true },
  { key: '/admin/score-submission-windows', href: '/admin/score-submission-windows', label: '成績上傳時間設定表（期中考/期末考/平時分/出缺勤 開放時間與鎖定）', adminOnly: true },
  { key: '/admin/substitute-teaching', href: '/admin/substitute-teaching', label: '代課安排', adminOnly: true },
  { key: '/schedule-lookup', href: '/schedule-lookup', label: '查詢教師/班級課表（選教師或班級直接看整週課表）', adminOnly: false },
  // ---- 訓導 ----
  { key: '/attendance/report', href: '/attendance/report', label: '學生出席紀錄查詢（月報／學期）', adminOnly: false },
  { key: '/reports/school-attendance', href: '/reports/school-attendance', label: '全校出缺席狀況總覽', adminOnly: false },
  { key: '/reports/attendance-unlock-requests', href: '/reports/attendance-unlock-requests', label: '出缺勤鎖定開放申請審核', adminOnly: false },
  { key: '/reports/profile-requests', href: '/reports/profile-requests', label: '學生資料修改申請審核', adminOnly: false },
  { key: '/admin/attendance-alert-settings', href: '/admin/attendance-alert-settings', label: '出缺席示警門檻設定', adminOnly: true },
  { key: '/admin/audit-logs', href: '/admin/audit-logs', label: '修正／解鎖紀錄（出缺勤修改紀錄＋成績鎖定解鎖紀錄，僅系統管理員S、管理員A看得到）', adminOnly: true },

  // ---- 總務（日後建置的五張表格） ----
  { key: '/admin/general/library', href: '/admin/general/library', label: '書庫登記表', adminOnly: true },
  { key: '/admin/general/uniforms', href: '/admin/general/uniforms', label: '校服庫存販賣表', adminOnly: true },
  { key: '/admin/general/notebooks', href: '/admin/general/notebooks', label: '簿本庫存販賣表', adminOnly: true },
  { key: '/admin/general/maintenance', href: '/admin/general/maintenance', label: '修繕登記', adminOnly: false },
  { key: '/admin/general/utilities', href: '/admin/general/utilities', label: '水電網路等費用', adminOnly: true },

  // ---- 教師（教學現場日常作業，教師登入即可看到） ----
  { key: '/attendance/weekly', href: '/attendance/weekly', label: '學生出缺席登錄（一週）', adminOnly: false },
  { key: '/attendance/mobile', href: '/attendance/mobile', label: '學生出缺席登錄（每日／手機版）', adminOnly: false },
  { key: '/attendance/subject-view', href: '/attendance/subject-view', label: '任課班級出席查詢（僅顯示自己任教科目/節次）', adminOnly: false },
  { key: '/notifications', href: '/notifications', label: '通知', adminOnly: false },

  // ---- 家長／學生 ----
  { key: '/admin/students/portal-accounts', href: '/admin/students/portal-accounts', label: '建立家長/學生登入帳號', adminOnly: true },
  { key: '/admin/students/documents', href: '/admin/students/documents', label: '學生歸檔文件查詢', adminOnly: true },

  // ---- 開發人員 ----
  { key: '/admin/accounts', href: '/admin/accounts', label: '帳號管理', adminOnly: true },
  { key: '/admin/teacher-accounts', href: '/admin/teacher-accounts', label: '教師資料檢查／合併（修復老師登入後看不到班級的問題）', adminOnly: true },
  { key: '/admin/class-accounts', href: '/admin/class-accounts', label: '班級資料檢查／合併（修復同一班出現兩次的問題）', adminOnly: true },
  { key: '/admin/dev-tools', href: '/admin/dev-tools', label: '開發人員區（備份與還原、一鍵上傳/下載所有Excel表格）', adminOnly: true },
  { key: '/admin/bulk-import', href: '/admin/bulk-import', label: '整批下載／上傳（整體佔比與加扣分規則、既有學生快速建檔）', adminOnly: true },
  { key: '/admin/academic-terms', href: '/admin/academic-terms', label: '學年學期中央管理主檔（開發人員）', adminOnly: true },
  { key: '/admin/pending-changes', href: '/admin/pending-changes', label: '送審總覽（各部門主管核准申請用）', adminOnly: true },
  { key: '/admin/bulletin', href: '/admin/bulletin', label: '公佈欄管理（首頁登入卡片上方的最新消息）', adminOnly: true },
  { key: '/admin/site-content', href: '/admin/site-content', label: '系統文字與背景音樂設定（僅系統管理員S）', adminOnly: true },
];

// 一個功能可以同時屬於多個分類（例如「成績相關設定及查詢」同時掛在教務／教師底下，
// 各自的權限大小仍然由角色/部門決定，這裡只決定「畫面上會出現在哪幾個區塊」）。
export const DEFAULT_CATEGORIES: Record<string, ModuleCategory[]> = {
  '/admin/grading': ['academic', 'teacher'],
  '/admin/registrar': ['academic', 'teacher'],
  '/admin/students/roster': ['academic', 'teacher'],
  '/admin/school-timetable': ['academic'],
  '/admin/scheduling': ['academic'],
  '/admin/period-locks': ['academic'],
  '/admin/score-submission-windows': ['academic', 'discipline'],
  '/admin/substitute-teaching': ['academic'],
  '/schedule-lookup': ['academic', 'teacher'],

  '/attendance/report': ['discipline', 'teacher'],
  '/reports/school-attendance': ['discipline'],
  '/reports/attendance-unlock-requests': ['discipline'],
  '/reports/profile-requests': ['discipline'],
  '/admin/attendance-alert-settings': ['discipline'],

  '/admin/general/library': ['general'],
  '/admin/general/uniforms': ['general'],
  '/admin/general/notebooks': ['general'],
  '/admin/general/maintenance': ['general'],
  '/admin/general/utilities': ['general'],

  '/attendance/weekly': ['teacher'],
  '/attendance/mobile': ['teacher'],
  '/attendance/subject-view': ['teacher'],
  '/notifications': ['teacher'],

  '/admin/students/portal-accounts': ['parent_student', 'dev'],
  '/admin/students/documents': ['parent_student', 'dev'],

  '/admin/accounts': ['dev'],
  '/admin/teacher-accounts': ['dev'],
  '/admin/class-accounts': ['dev'],
  '/admin/dev-tools': ['dev'],
  '/admin/bulk-import': ['dev'],
  '/admin/academic-terms': ['dev'],
  '/admin/pending-changes': ['dev'],
  '/admin/bulletin': ['general', 'dev'],
  '/admin/site-content': ['dev'],
};

const TABLE = 'admin_module_categories';

/** 讀取目前的分類（DB 自訂 + 預設分類 fallback），DB 尚未建立資料表時不會噴錯，直接退回預設值。
 *  一個模組可能對應到多個分類，回傳的是 module_key → 分類陣列。 */
export async function getModuleCategoryMap(): Promise<Record<string, ModuleCategory[]>> {
  const merged: Record<string, ModuleCategory[]> = {};
  for (const m of ALL_MODULES) merged[m.key] = [...(DEFAULT_CATEGORIES[m.key] ?? ['academic'])];
  try {
    const { data, error } = await supabase.from(TABLE).select('module_key, category');
    if (!error && data && data.length > 0) {
      const grouped: Record<string, ModuleCategory[]> = {};
      for (const row of data as { module_key: string; category: ModuleCategory }[]) {
        if (!(row.module_key in merged)) continue;
        grouped[row.module_key] = grouped[row.module_key] ?? [];
        grouped[row.module_key].push(row.category);
      }
      // 只要資料庫裡有這個模組的任何一筆自訂分類，就整批取代預設值（避免預設跟自訂混在一起搞不清楚）
      for (const key of Object.keys(grouped)) merged[key] = grouped[key];
    }
  } catch {
    // sql/11module_categories.sql 尚未執行：安靜地使用預設分類即可
  }
  return merged;
}

/** 系統管理員S按「儲存分類」時呼叫，把目前畫面上的分類（每個模組可對應多個分類）整批寫回資料表 */
export async function saveModuleCategoryMap(map: Record<string, ModuleCategory[]>): Promise<string | null> {
  const rows: { module_key: string; category: ModuleCategory }[] = [];
  for (const m of ALL_MODULES) {
    const cats = map[m.key] ?? DEFAULT_CATEGORIES[m.key] ?? ['academic'];
    for (const cat of cats) rows.push({ module_key: m.key, category: cat });
  }
  // 先清空全部再整批寫入，最簡單可靠，資料量小（模組數×分類數頂多幾十筆）不用擔心效能
  const { error: delErr } = await supabase.from(TABLE).delete().not('module_key', 'is', null);
  if (delErr) return '清除舊分類失敗：' + delErr.message;
  if (rows.length === 0) return null;
  const { error: insErr } = await supabase.from(TABLE).insert(rows);
  if (insErr) return '寫入新分類失敗：' + insErr.message;
  return null;
}

// ============================================================
// 首頁功能卡片「上下位置」排序（admin_module_order）
// ------------------------------------------------------------
// ALL_MODULES 陣列本身的順序就是「程式碼內建預設排序」；這裡另外存一份
// module_key → 排序數字，讓系統管理員S可以在畫面上用 ▲▼ 調整順序，
// 調整結果存進 Supabase 後，全校所有人登入看到的都是同一套順序
// （跟 admin_module_categories／分類的做法完全比照）。
// 尚未執行 sql/38admin_module_order.sql、或表格還是空的之前，會自動退回
// ALL_MODULES 陣列本身的順序，不會壞掉。
// ============================================================

const ORDER_TABLE = 'admin_module_order';

/** 讀取目前排序（DB 自訂 + 程式碼內建順序 fallback）。回傳 module_key → 排序用數字，數字越小排越前面。 */
export async function getModuleOrderMap(): Promise<Record<string, number>> {
  const merged: Record<string, number> = {};
  ALL_MODULES.forEach((m, i) => {
    merged[m.key] = i;
  });
  try {
    const { data, error } = await supabase.from(ORDER_TABLE).select('module_key, sort_order');
    if (!error && data && data.length > 0) {
      for (const row of data as { module_key: string; sort_order: number }[]) {
        if (row.module_key in merged) merged[row.module_key] = row.sort_order;
      }
    }
  } catch {
    // sql/38admin_module_order.sql 尚未執行：安靜地使用程式碼內建順序即可
  }
  return merged;
}

/** 依排序 map 把一份模組清單排序過一次，供畫面渲染使用（例如某分類底下的功能清單）。 */
export function sortModulesByOrder<T extends { key: string }>(modules: T[], orderMap: Record<string, number>): T[] {
  return [...modules].sort((a, b) => (orderMap[a.key] ?? 0) - (orderMap[b.key] ?? 0));
}

/** 系統管理員S按「儲存排序」時呼叫，把目前畫面上調整過的順序整批寫回資料表。 */
export async function saveModuleOrderMap(orderMap: Record<string, number>): Promise<string | null> {
  const rows = ALL_MODULES.map((m) => ({ module_key: m.key, sort_order: orderMap[m.key] ?? 0 }));
  const { error: delErr } = await supabase.from(ORDER_TABLE).delete().not('module_key', 'is', null);
  if (delErr) return '清除舊排序失敗：' + delErr.message;
  const { error: insErr } = await supabase.from(ORDER_TABLE).insert(rows);
  if (insErr) return '寫入新排序失敗：' + insErr.message;
  return null;
}

// ============================================================
// 帳號個別可見內容調整（app_user_module_overrides）
// ------------------------------------------------------------
// 通則（見 computeVisibleModuleKeys）決定「這個角色／這個部門職務」預設看不看得到
// 某功能；這裡的例外表則讓系統管理員S可以再對「單一帳號」加開或關閉特定功能。
// ============================================================

const OVERRIDES_TABLE = 'app_user_module_overrides';

export type ModuleOverride = { module_key: string; visible: boolean };

/** 系統管理員S用：讀取某個帳號目前被設定的例外清單 */
export async function getModuleOverridesFor(userId: string): Promise<Record<string, boolean>> {
  const { data, error } = await supabase.from(OVERRIDES_TABLE).select('module_key, visible').eq('app_user_id', userId);
  if (error || !data) return {};
  const map: Record<string, boolean> = {};
  for (const row of data as ModuleOverride[]) map[row.module_key] = row.visible;
  return map;
}

/** 系統管理員S用：整批寫入某帳號的例外清單（先刪除舊的再重新插入） */
export async function saveModuleOverridesFor(userId: string, overrides: Record<string, boolean>): Promise<{ error: string | null }> {
  const { error: delErr } = await supabase.from(OVERRIDES_TABLE).delete().eq('app_user_id', userId);
  if (delErr) return { error: '清除舊的可見內容設定失敗：' + delErr.message };
  const rows = Object.entries(overrides).map(([module_key, visible]) => ({ app_user_id: userId, module_key, visible }));
  if (rows.length === 0) return { error: null };
  const { error: insErr } = await supabase.from(OVERRIDES_TABLE).insert(rows);
  if (insErr) return { error: '寫入可見內容設定失敗：' + insErr.message };
  return { error: null };
}

/**
 * 計算某帳號實際看得到哪些模組 key。
 * 規則（由上到下，後面的規則會覆蓋前面）：
 *  1. 系統管理員S：全部看得到（不受部門切割限制）。
 *  2. adminOnly:false 的模組：一般教職員登入即可看到。
 *  3. adminOnly:true 的模組：只有身兼「該分類對應部門」的人看得到
 *     （分類 → 部門的對應見 CATEGORY_REQUIRED_DEPARTMENT；teacher／parent_student
 *     這兩區沒有對應部門，維持第2點的通則）。
 *  4. 個別帳號的例外設定（overrides）：不論通則結果為何，一律以例外設定為準。
 */
export function computeVisibleModuleKeys(params: {
  isSystemAdmin: boolean;
  myDepartments: AdminDepartment[];
  categoryMap: Record<string, ModuleCategory[]>;
  overrides?: Record<string, boolean>;
}): Set<string> {
  const { isSystemAdmin, myDepartments, categoryMap, overrides = {} } = params;
  const visible = new Set<string>();

  for (const m of ALL_MODULES) {
    let ok: boolean;
    if (isSystemAdmin) {
      ok = true;
    } else if (!m.adminOnly) {
      ok = true;
    } else {
      const cats = categoryMap[m.key] ?? DEFAULT_CATEGORIES[m.key] ?? ['academic'];
      // 只要身兼「其中任一個」分類對應的部門，就看得到（例如一個模組同時掛在教務／教師，
      // 教務部門的人跟一般教師都各自有機會看到，只是背後 RLS 權限大小不同）
      ok = cats.some((cat) => {
        const requiredDept = CATEGORY_REQUIRED_DEPARTMENT[cat];
        return requiredDept ? myDepartments.includes(requiredDept) : false;
      });
    }
    if (m.key in overrides) ok = overrides[m.key];
    if (ok) visible.add(m.key);
  }
  return visible;
}
