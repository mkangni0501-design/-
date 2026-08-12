import { supabase } from '@/lib/supabaseClient';
import { ALL_MODULES } from '@/lib/adminModules';

// 「系統文字管理」目前涵蓋的文字 key 清單，跟畫面上真正會用到這些 key 的地方一一對應：
//   category_hint.*                     ： app/(app)/admin/page.tsx 六個分類卡片的說明文字
//   page_hint.scores_entry              ： 成績登錄頁「批次上傳」收合區塊的標題文字
//   page_hint.attendance_mobile_legend  ： 出缺勤登錄頁（手機版）「顏色圖例」收合區塊的標題文字
//   page_hint.attendance_subject_view   ： 任課班級出席查詢頁的說明文字
//   module_label.<模組key>              ： 每個功能卡片上顯示的名稱（例如「排課系統（自動排課工具）」），
//                                          key 直接對應 lib/adminModules.ts 的 ALL_MODULES 陣列，
//                                          adminModules.ts 增減模組時這份清單會自動跟著更新，不用手動維護。
// 之後要讓其他頁面的文字也能在「系統文字管理」頁編輯，就是在該頁面把寫死的字串
// 換成 getSiteContentMap() 查表、預設值放原本的字，然後在 STATIC_CONTENT_DEFAULTS
// 補上新的 key 跟預設值即可，不用動資料表結構。
const STATIC_CONTENT_DEFAULTS: Record<string, string> = {
  'category_hint.academic': '成績、學籍相關功能',
  'category_hint.discipline': '出缺勤、獎懲相關功能',
  'category_hint.general': '總務、庫存相關功能',
  'category_hint.teacher': '教師教學相關功能',
  'category_hint.parent_student': '家長／學生查詢相關功能',
  'category_hint.dev': '系統開發／除錯用功能',
  'page_hint.scores_entry': '批次上傳（格式同「成績、出缺輸入表」工作表）',
  'page_hint.attendance_mobile_legend': '顏色圖例',
  'page_hint.attendance_subject_view': '只會顯示您自己授課節次的出缺勤累計次數（累計至今），不包含同班其他科目/節次的紀錄。',
};

export const MODULE_LABEL_KEY_PREFIX = 'module_label.';
export function moduleLabelKey(moduleKey: string): string {
  return MODULE_LABEL_KEY_PREFIX + moduleKey;
}

export const SITE_CONTENT_DEFAULTS: Record<string, string> = {
  ...STATIC_CONTENT_DEFAULTS,
  ...Object.fromEntries(ALL_MODULES.map((m) => [moduleLabelKey(m.key), m.label])),
};

/** 讀取目前資料庫裡存的文字內容；沒有存過的 key 用上面 SITE_CONTENT_DEFAULTS 當預設值。
 * 資料庫尚未執行 sql/39site_content_settings_assets.sql、或個別 key 還沒被改過，都會安靜地退回預設值，不會壞掉。 */
export async function getSiteContentMap(): Promise<Record<string, string>> {
  const merged: Record<string, string> = { ...SITE_CONTENT_DEFAULTS };
  try {
    const { data, error } = await supabase.from('site_content').select('content_key, content_value');
    if (!error && data) {
      for (const row of data as { content_key: string; content_value: string }[]) {
        merged[row.content_key] = row.content_value;
      }
    }
  } catch {
    // sql/39site_content_settings_assets.sql 尚未執行：安靜地使用預設值即可
  }
  return merged;
}

/** 系統管理員S在「系統文字管理」頁按儲存時呼叫，把整批文字寫回資料庫（用 upsert，key 不存在就新增）。 */
export async function saveSiteContentMap(values: Record<string, string>): Promise<string | null> {
  const rows = Object.entries(values).map(([content_key, content_value]) => ({ content_key, content_value }));
  const { error } = await supabase.from('site_content').upsert(rows, { onConflict: 'content_key' });
  if (error) return '儲存失敗：' + error.message;
  return null;
}

/** 讀取單一全站設定值（例如背景音樂網址）；沒有設定過就回傳 null。 */
export async function getSiteSetting(key: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('site_settings').select('setting_value').eq('setting_key', key).maybeSingle();
    if (error || !data) return null;
    return data.setting_value ?? null;
  } catch {
    return null;
  }
}

/** 系統管理員S寫入一個全站設定值。 */
export async function saveSiteSetting(key: string, value: string | null): Promise<string | null> {
  const { error } = await supabase.from('site_settings').upsert({ setting_key: key, setting_value: value }, { onConflict: 'setting_key' });
  if (error) return '儲存失敗：' + error.message;
  return null;
}
