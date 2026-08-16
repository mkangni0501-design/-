// ============================================================
// 管理後台首頁「分類」展開細項用：有些功能模組（例如「成績相關設定及查詢」）
// 進去之後裡面其實還分好幾個分頁／區塊，使用者常常只是想直接跳去做某一件事
// （例如「學生成績登錄」），不想每次都先進入再自己找分頁點。
//
// 這裡登記每個模組底下有哪些「細項」可以直接跳過去：
// - type: 'tab'    — 目標頁面內部用同一個 URL、切換元件顯示（如 /admin/grading），
//                     連結會加上 `?tab=<key>`，該頁面已改成一進去就讀這個參數直接切到對應分頁。
// - type: 'anchor' — 目標頁面本身是一路往下捲動的長頁面，各區塊已加上對應的 id，
//                     連結會加上 `#<key>`，Next.js 導頁後會自動捲動到該區塊。
//
// 沒有在這裡登記的模組（多半本身內容單純、沒有再分頁/分區塊）就不會顯示展開箭頭，
// 點標題一樣直接進入該功能，行為維持不變。
// ============================================================

export type SubItemType = 'tab' | 'anchor';

export type ModuleSubItem = {
  key: string; // tab 型：查詢字串 tab 的值；anchor 型：頁面上對應元素的 id
  label: string;
};

export type ModuleSubItemsConfig = {
  type: SubItemType;
  items: ModuleSubItem[];
};

export const MODULE_SUB_ITEMS: Record<string, ModuleSubItemsConfig> = {
  '/admin/grading': {
    type: 'tab',
    items: [
      { key: 'settings', label: '成績相關設定（科目比重／加扣分規則）' },
      { key: 'entry', label: '學生成績登錄' },
      { key: 'conduct', label: '操行成績評分（禮貌／衣著／服務／紀律）' },
      { key: 'class-summary', label: '班級成績總表' },
      { key: 'class-results', label: '班級成績結果與排名' },
      { key: 'school-rankings', label: '全校排行榜' },
      { key: 'history', label: '歷年成績查詢' },
      { key: 'batch-print', label: '批次列印成績單（多班／全校）' },
    ],
  },
  '/admin/registrar': {
    type: 'tab',
    items: [
      { key: 'search', label: '查詢學生（全校／各班級）' },
      { key: 'new', label: '新生入學登記（完整版）' },
      { key: 'import', label: '既有學生快速建檔（精簡版）' },
      { key: 'status-change', label: '學籍狀態變更' },
      { key: 'transfer', label: '學期中轉班' },
      { key: 'promotion', label: '升級作業' },
      { key: 'grade-progression', label: '年級升級對照表設定' },
    ],
  },
  '/admin/dev-tools': {
    type: 'anchor',
    items: [
      { key: 'backup-restore', label: '備份與還原' },
      { key: 'bulk-excel', label: '一鍵上傳／下載（系統內所有Excel表格）' },
      { key: 'teacher-letters', label: '聘書（歷年教師資料／自聘教師聘書／當年教師聘書／列印）' },
    ],
  },
  '/admin/site-content': {
    type: 'anchor',
    items: [
      { key: 'bgm', label: '背景音樂' },
      { key: 'card-labels', label: '功能卡片名稱' },
      { key: 'other-text', label: '其他說明文字' },
    ],
  },
  '/admin/accounts': {
    type: 'anchor',
    items: [
      { key: 'orphaned', label: '孤兒帳號（信箱已註冊，但清單裡看不到）' },
      { key: 'departments', label: '部門職務指派（教務／訓導／總務／開發人員）' },
      { key: 'overrides', label: '帳號可見內容（個別調整）' },
      { key: 'audit-log', label: '帳號異動紀錄（角色變更／密碼重設）' },
    ],
  },
  '/admin/school-timetable': {
    type: 'anchor',
    items: [
      { key: 'bulk-upload', label: '整批上傳（一鍵匯入／覆蓋）' },
      { key: 'manual-add', label: '手動新增單一堂課' },
    ],
  },
  '/admin/substitute-teaching': {
    type: 'anchor',
    items: [
      { key: 'batch-assign', label: '同一天批次代課安排' },
      { key: 'recent-history', label: '近期代課紀錄' },
    ],
  },
};

/** 依模組 key 組出細項要用的連結。tab 型加 ?tab=；anchor 型加 #。 */
export function buildSubItemHref(moduleHref: string, config: ModuleSubItemsConfig, itemKey: string): string {
  if (config.type === 'tab') {
    const sep = moduleHref.includes('?') ? '&' : '?';
    return `${moduleHref}${sep}tab=${itemKey}`;
  }
  return `${moduleHref}#${itemKey}`;
}
