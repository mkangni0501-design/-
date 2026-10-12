import { createClient } from '@supabase/supabase-js';

// 環境變數需在 .env.local 設定：
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export type UserRole =
  | 'system_admin_s'
  | 'admin_a'
  | 'admin_b'
  | 'homeroom_teacher'
  | 'subject_teacher';

export const ROLE_LABEL: Record<UserRole, string> = {
  system_admin_s: '系統管理員S',
  admin_a: '系統管理員A',
  admin_b: '管理員B',
  homeroom_teacher: '班級導師',
  subject_teacher: '任課教師',
};

export const ADMIN_ROLES: UserRole[] = ['system_admin_s', 'admin_a', 'admin_b'];

/**
 * 判斷「目前這個畫面該不該當作管理員」：跟只看 role 的差別是，管理員帳號用「身分切換」切到
 * 教師視角時（sessionStorage.viewMode==='teacher'），這裡一律回傳 false。
 * 各分頁/元件裡原本各自寫「ADMIN_ROLES.includes(appUser.role)」的地方都應該改呼叫這支，
 * 不然管理員切成教師視角後，各分頁裡「刪除設定」「編輯任一班成績」「編輯學生名單」這類管理員
 * 專屬功能還是會照舊角色繼續顯示出來，「身分切換」形同虛設。
 */
export function isAdminInCurrentView(role: string | null | undefined): boolean {
  if (!role || !ADMIN_ROLES.includes(role as UserRole)) return false;
  if (typeof window !== 'undefined' && sessionStorage.getItem('viewMode') === 'teacher') return false;
  return true;
}

async function fetchCurrentAppUser() {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return null;

  const { data, error } = await supabase
    .from('app_users')
    .select('id, name, role')
    .eq('id', authData.user.id)
    .single();

  if (error) {
    console.error('讀取使用者資料失敗', error);
    return null;
  }
  // 附上目前登入信箱：同一個人如果先前被建立過兩個不同帳號（例如導師帳號 + 後來另外建立的管理員帳號），
  // 光看名字容易誤以為是同一筆資料，附上信箱才看得出目前登入的到底是哪一個帳號。
  return { ...data, email: authData.user.email ?? null };
}

// 【效能】一個頁面通常有好幾個元件（分頁、權限 hook…）各自呼叫 getCurrentAppUser()，
// 每次都要打一趟 Auth 伺服器＋一趟 app_users。這裡把同一時間的呼叫合併成一次，
// 並短暫快取 30 秒；登入/登出/換 token/改信箱等任何驗證狀態變化都會立刻清掉快取。
let appUserCache: { at: number; promise: ReturnType<typeof fetchCurrentAppUser> } | null = null;
if (typeof window !== 'undefined') {
  supabase.auth.onAuthStateChange(() => {
    appUserCache = null;
  });
}

/** 取得目前登入使用者的角色資料，尚未登入回傳 null */
export function getCurrentAppUser() {
  const now = Date.now();
  if (appUserCache && now - appUserCache.at < 30_000) return appUserCache.promise;
  const promise = fetchCurrentAppUser();
  appUserCache = { at: now, promise };
  promise.then((u) => {
    if (!u && appUserCache?.promise === promise) appUserCache = null; // 沒登入/查詢失敗不要快取
  });
  return promise;
}

/**
 * 取得目前登入使用者對應的 teachers.id（如果這個帳號有連結教師資料的話）。
 * 【2026-08-11 新增】原本「通知」頁跟 TopNav 的未讀通知數都直接查
 * staff_notifications 全部欄位，沒有自己在前端過濾 teacher_id，變成完全依賴
 * RLS 政策幫忙擋——但 RLS 政策裡系統管理員／訓導部門本來就特意放寬可以看到
 * 「全部教師」的通知（用於審核/監督），結果這些帳號打開「通知」頁看到的就是
 * 全校所有人的通知混在一起，感覺像是「大家共用同一份」。改成前端明確查自己的
 * teacher_id、只抓屬於自己的通知，才會是「個人（相關人員）」專屬的提示。
 * 沒有連結教師資料的帳號（純管理帳號、沒有教師身分）回傳 null，代表沒有「屬於
 * 自己」的個人通知——如果之後要做「管理員審核用的全校通知總覽」，應該另外開一個
 * 獨立頁面，不要跟這裡的「個人通知」混在一起。
 */
export async function getCurrentTeacherId(): Promise<string | null> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return null;
  const { data } = await supabase.from('teachers').select('id').eq('app_user_id', authData.user.id).maybeSingle();
  return data?.id ?? null;
}

/**
 * 這位老師目前是不是「真的有帶班/排課/社團」：用於首頁功能表自動隱藏
 * 「有 adminOnly:false 但沒有任何指派就打開也是空的」那幾個教學現場功能
 * （出缺席登錄、社團點名/成績——見 lib/adminModules.ts 的 requiresTeachingAssignment）。
 * 三種來源只要符合其中一種就算「有」：導師班（classes.homeroom_teacher_id）、
 * 排課（class_schedule.teacher_id）、社團授課（clubs.teacher_id）。
 */
export async function getHasTeachingAssignment(teacherId: string | null): Promise<boolean> {
  if (!teacherId) return false;
  const [homeroom, schedule, club] = await Promise.all([
    supabase.from('classes').select('id').eq('homeroom_teacher_id', teacherId).limit(1),
    supabase.from('class_schedule').select('id').eq('teacher_id', teacherId).limit(1),
    supabase.from('clubs').select('id').eq('teacher_id', teacherId).limit(1),
  ]);
  return (homeroom.data?.length ?? 0) > 0 || (schedule.data?.length ?? 0) > 0 || (club.data?.length ?? 0) > 0;
}
