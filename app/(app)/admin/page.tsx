'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { getSiteContentMap, moduleLabelKey } from '@/lib/siteContent';
import { getMyDepartments } from '@/lib/departments';
import { BulletinPost, getPublishedPosts } from '@/lib/bulletin';
import { MODULE_SUB_ITEMS, buildSubItemHref } from '@/lib/moduleSubItems';
import {
  ALL_MODULES,
  CATEGORY_HINT,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  ModuleCategory,
  computeVisibleModuleKeys,
  getModuleCategoryMap,
  getModuleOrderMap,
  getModuleOverridesFor,
  saveModuleCategoryMap,
  saveModuleOrderMap,
  sortModulesByOrder,
} from '@/lib/adminModules';

// 管理後台進「工作分類表」前，要先把布告欄目前已發布的公告看過一次、按「我知道」才放行。
// 用瀏覽器 localStorage 記「看過到哪一篇」（最新一篇的 published_at），
// 之後只要布告欄有新公告發布（published_at 比記錄的新），下次進管理後台就會再跳出來一次；
// 沒有任何已發布公告，或已經看過目前最新一篇，就直接跳過、照原本一樣直接看到工作分類表。
const BULLETIN_ACK_KEY = 'admin_bulletin_ack_published_at';

// 很多功能的 label 是「短名稱＋括號內落落長的說明」（例如「學籍設定及查詢（含查詢學生、
// 新生登記、學籍異動、轉班、升級作業）」）。手機版排版加強：手機斷點下只顯示短名稱，
// 括號內的說明先不顯示，讓每一列在小螢幕上一眼就看得清楚在點什麼；桌機版維持完整顯示，
// 不影響原本熟悉桌機介面的人。
function splitLabel(label: string): { main: string; detail: string | null } {
  const idx = label.indexOf('（');
  if (idx === -1) return { main: label, detail: null };
  return { main: label.slice(0, idx), detail: label.slice(idx) };
}

// 功能清單裡的單一列：標題前面如果有細項（見 lib/moduleSubItems.ts）就顯示一個展開箭頭，
// 點箭頭只做展開/收合、不會跳頁；點標題文字才會真的進入該功能（維持原本一路以來的點法）。
// 展開後的細項清單本身也是連結，點了會直接跳進該功能對應的分頁／區塊，不用先進去再自己找。
function ModuleListItem({
  moduleKey,
  href,
  label,
  isMobile,
  variant,
  expanded,
  onToggle,
}: {
  moduleKey: string;
  href: string;
  label: string;
  isMobile: boolean;
  variant: 'card' | 'flat';
  expanded: boolean;
  onToggle: () => void;
}) {
  const { main } = splitLabel(label);
  const subConfig = MODULE_SUB_ITEMS[moduleKey];
  const padding = variant === 'card' ? (isMobile ? 14 : 10) : isMobile ? 16 : 12;
  const fontSize = variant === 'card' ? (isMobile ? 15 : 13) : isMobile ? 16 : 14;

  return (
    <li>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
        {subConfig && (
          <button
            onClick={onToggle}
            aria-label={expanded ? `收合「${main}」細項` : `展開「${main}」細項`}
            aria-expanded={expanded}
            style={{
              flexShrink: 0,
              width: variant === 'card' ? 28 : 32,
              border: '1px solid #eee',
              borderRadius: 8,
              background: '#fff',
              color: '#999',
              fontSize: 11,
              cursor: 'pointer',
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          >
            ▶
          </button>
        )}
        <Link
          href={href}
          style={{
            display: 'block',
            flex: 1,
            padding,
            background: '#fff',
            border: '1px solid #eee',
            borderRadius: 8,
            fontSize,
            color: '#2C2C2A',
          }}
        >
          {isMobile && variant === 'card' ? main : label}
        </Link>
      </div>
      {subConfig && expanded && (
        <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: '0 0 0 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {subConfig.items.map((item) => (
            <li key={item.key}>
              <Link
                href={buildSubItemHref(href, subConfig, item.key)}
                style={{
                  display: 'block',
                  padding: isMobile ? '10px 12px' : '7px 10px',
                  background: '#FAFAF8',
                  border: '1px solid #f0f0ee',
                  borderRadius: 6,
                  fontSize: isMobile ? 13 : 12,
                  color: '#555',
                }}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function BulletinGate({ posts, onAck }: { posts: BulletinPost[]; onAck: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(posts[0]?.id ?? null);
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>布告欄</h1>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>請先看過以下公告，按「我知道」後才會進入工作分類表。</p>
      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {posts.map((p) => (
          <li key={p.id} style={{ border: '1px solid #e5e2da', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            <button
              onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
            >
              {p.thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbnail_url} alt={p.title} style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }} />
              )}
              <div style={{ padding: '10px 14px' }}>
                <span style={{ display: 'block', fontSize: 14, color: '#2C2C2A' }}>{p.title}</span>
              </div>
            </button>
            {expandedId === p.id && (
              <div style={{ padding: '0 14px 14px', fontSize: 13, color: '#444', whiteSpace: 'pre-wrap' }}>{p.content}</div>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={onAck}
        style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#2C2C2A', color: '#fff', fontSize: 14, cursor: 'pointer' }}
      >
        我知道
      </button>
    </main>
  );
}

const ADMIN_ROLES = ['system_admin_s', 'admin_a', 'admin_b'];
const SYSTEM_ADMIN_ROLE = 'system_admin_s';

const CATEGORY_COLOR: Record<ModuleCategory, { bg: string; border: string; title: string }> = {
  academic: { bg: '#F4F1EA', border: '#E4DFD3', title: '#6B5B3A' },
  discipline: { bg: '#F0F1EC', border: '#DEE3D6', title: '#4C6B3A' },
  general: { bg: '#EFF1F4', border: '#DAE0E8', title: '#3A5470' },
  teacher: { bg: '#F4EDEA', border: '#E4D5D3', title: '#8A4A3A' },
  parent_student: { bg: '#EFF4EE', border: '#D9E4D6', title: '#3A6B4C' },
  dev: { bg: '#EEEFF4', border: '#D8DAE4', title: '#3A3F70' },
};

export default function AdminHomePage() {
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'admin' | 'teacher'>('admin');
  const [categoryMap, setCategoryMap] = useState<Record<string, ModuleCategory[]>>({});
  const [siteContent, setSiteContent] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Set<string> | null>(null); // null＝S的編輯視角，不做篩選
  const [editMode, setEditMode] = useState(false);
  const [savedMap, setSavedMap] = useState<Record<string, ModuleCategory[]>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // 「上下位置」排序：畫面上編輯時用「一份 key 陣列」表示目前順序（陣列順序＝排名），
  // 比直接維護 module_key → 數字的排序表更方便做「▲▼互換位置」；儲存時才轉成排序數字整批寫回。
  const [orderedKeys, setOrderedKeys] = useState<string[]>(ALL_MODULES.map((m) => m.key));
  const [savedOrderedKeys, setSavedOrderedKeys] = useState<string[]>(ALL_MODULES.map((m) => m.key));
  const [draggingKey, setDraggingKey] = useState<string | null>(null); // 目前正在拖曳哪個功能列（用來highlight那一列）
  // 「分類標題前箭頭」展開狀態：記錄目前展開了哪些模組的細項清單，跟排序/分類編輯無關。
  const [expandedModuleKeys, setExpandedModuleKeys] = useState<Set<string>>(new Set());
  function toggleModuleExpanded(key: string) {
    setExpandedModuleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 布告欄關卡：見上面 BulletinGate 說明
  const [bulletinPosts, setBulletinPosts] = useState<BulletinPost[]>([]);
  const [bulletinAcked, setBulletinAcked] = useState(true); // 預設true，讀完公告資料前不擋畫面閃一下

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      setRole(appUser?.role ?? null);

      const map = await getModuleCategoryMap();
      setCategoryMap(map);
      setSavedMap(map);

      getSiteContentMap().then(setSiteContent);

      const orderMap = await getModuleOrderMap();
      const keysInOrder = [...ALL_MODULES.map((m) => m.key)].sort((a, b) => (orderMap[a] ?? 0) - (orderMap[b] ?? 0));
      setOrderedKeys(keysInOrder);
      setSavedOrderedKeys(keysInOrder);

      await refreshViewModeAndVisibleKeys(appUser, map);

      const posts = await getPublishedPosts(10);
      setBulletinPosts(posts);
      const latestPublishedAt = posts[0]?.published_at ?? null;
      const ackedAt = typeof window !== 'undefined' ? localStorage.getItem(BULLETIN_ACK_KEY) : null;
      setBulletinAcked(!latestPublishedAt || ackedAt === latestPublishedAt);

      setLoading(false);
    })();
  }, []);

  function handleAckBulletin() {
    const latestPublishedAt = bulletinPosts[0]?.published_at ?? null;
    if (typeof window !== 'undefined' && latestPublishedAt) localStorage.setItem(BULLETIN_ACK_KEY, latestPublishedAt);
    setBulletinAcked(true);
  }

  // 讀 sessionStorage.viewMode，重新算一次 visibleKeys（是否要篩選、篩選成什麼樣子）。
  // 抽成共用函式，掛載時跟「切換身分」都呼叫同一份，才不會兩邊各算一次卻邏輯兜不起來。
  async function refreshViewModeAndVisibleKeys(appUser: { id: string; role: string } | null, map: Record<string, ModuleCategory[]>) {
    const mode = typeof window !== 'undefined' ? sessionStorage.getItem('viewMode') : null;
    setViewMode(mode === 'teacher' ? 'teacher' : 'admin');

    const isSystemAdmin = appUser?.role === SYSTEM_ADMIN_ROLE;
    // 「身分切換」切到教師視角時，就算帳號本身是系統管理員S或身兼某個部門主管，這裡也要當作
    // 「沒有那些管理權限」來算 visibleKeys——不然像系統管理員S這種帳號，原本規則是「一定看得到
    // 全部」，即使切成教師視角畫面還是會整批不篩選地顯示出來，等於「身分切換」形同虛設。
    const viewingAsTeacher = mode === 'teacher';
    if (appUser && (!isSystemAdmin || viewingAsTeacher)) {
      // 非系統管理員S（或雖然是S、但目前正用教師視角）：算出「這個身分實際看得到哪些功能」
      const [myDepartments, overrides] = await Promise.all([
        viewingAsTeacher ? Promise.resolve([]) : getMyDepartments(appUser.id).then((rows) => rows.map((r) => r.department)),
        getModuleOverridesFor(appUser.id),
      ]);
      setVisibleKeys(computeVisibleModuleKeys({ isSystemAdmin: false, myDepartments, categoryMap: map, overrides }));
    } else {
      setVisibleKeys(null); // S（且目前是管理者視角）看得到全部，也才能調整分類
    }
  }

  // 「切換身分」按下去的當下，如果本來就已經在 /admin 這一頁，Next.js 不會重新
  // 掛載這個頁面，上面那個 useEffect（只在掛載時跑一次）就不會重新讀 sessionStorage，
  // 畫面會停在切換前的視角。這裡另外用一個自訂事件即時同步 viewMode，
  // 不管使用者當下人在哪一頁都能立刻反應，不用整頁重新整理。
  // （這裡連 visibleKeys 也要一起重算，不然只換了「目前是教師視角」的標示文字，
  // 底下的功能清單卻還停在切換前的那一份，管理專屬的卡片一樣會留在畫面上。）
  useEffect(() => {
    function syncViewMode() {
      (async () => {
        const appUser = await getCurrentAppUser();
        await refreshViewModeAndVisibleKeys(appUser, categoryMap);
      })();
    }
    window.addEventListener('viewmode-change', syncViewMode);
    return () => window.removeEventListener('viewmode-change', syncViewMode);
  }, [categoryMap]);

  const isAdminRole = !!role && ADMIN_ROLES.includes(role);
  const isSystemAdminS = role === SYSTEM_ADMIN_ROLE;
  const isAdminView = isAdminRole && viewMode === 'admin';

  // 「上下位置」：目前顯示中的排序，來自 orderedKeys（陣列順序＝排名）。
  const orderMap = useMemo(() => {
    const map: Record<string, number> = {};
    orderedKeys.forEach((key, i) => {
      map[key] = i;
    });
    return map;
  }, [orderedKeys]);
  const sortedAllModules = useMemo(() => sortModulesByOrder(ALL_MODULES, orderMap), [orderMap]);

  // 功能卡片上顯示的名稱：優先用「系統文字管理」頁存過的版本，沒改過就用程式碼內建的 m.label。
  function resolveLabel(m: { key: string; label: string }): string {
    return siteContent[moduleLabelKey(m.key)] ?? m.label;
  }

  // 教師卡片視角／實際上只是教師角色：只顯示自己看得到的功能，攤平成一份清單
  const teacherModules = useMemo(() => {
    if (isSystemAdminS) return sortedAllModules.filter((m) => !m.adminOnly);
    if (!visibleKeys) return sortedAllModules.filter((m) => !m.adminOnly);
    return sortedAllModules.filter((m) => visibleKeys.has(m.key) && !m.adminOnly);
  }, [visibleKeys, isSystemAdminS, sortedAllModules]);

  const visibleModules = useMemo(() => {
    if (isSystemAdminS) return sortedAllModules; // S 永遠看得到全部，才能管理分類/例外
    if (isAdminView) return visibleKeys ? sortedAllModules.filter((m) => visibleKeys.has(m.key)) : sortedAllModules;
    return teacherModules;
  }, [isAdminView, teacherModules, isSystemAdminS, visibleKeys, sortedAllModules]);

  // 一個功能可以同時出現在多個分類區塊（例如「成績相關設定及查詢」同時掛在教務／教師底下）；
  // visibleModules 已經照 orderedKeys 排過序，這裡分組時會保留原本的相對順序。
  const modulesByCategory = useMemo(() => {
    const grouped: Record<ModuleCategory, typeof ALL_MODULES> = {
      academic: [],
      discipline: [],
      general: [],
      teacher: [],
      parent_student: [],
      dev: [],
    };
    for (const m of visibleModules) {
      const cats = categoryMap[m.key] ?? ['academic'];
      for (const cat of cats) grouped[cat].push(m);
    }
    return grouped;
  }, [visibleModules, categoryMap]);

  // 編輯模式底下「▲▼」按鈕：跟相鄰的那一項互換順位。moduleKey 目前排第幾位由 orderedKeys 決定，
  // 跟分類無關（同一份全域順序，套用到每個分類區塊、也套用到教師卡片清單）。
  function moveModule(moduleKey: string, direction: 'up' | 'down') {
    setOrderedKeys((prev) => {
      const idx = prev.indexOf(moduleKey);
      const swapWith = direction === 'up' ? idx - 1 : idx + 1;
      if (idx === -1 || swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      return next;
    });
  }

  // 拖曳排序／輸入數字排序共用：把 moduleKey 直接搬到「第 targetIndex 位」（0-based），
  // 其他項目自動往前/往後擠一格補位，不用一格一格互換。
  function moveModuleToIndex(moduleKey: string, targetIndex: number) {
    setOrderedKeys((prev) => {
      const idx = prev.indexOf(moduleKey);
      if (idx === -1) return prev;
      const clampedTarget = Math.max(0, Math.min(targetIndex, prev.length - 1));
      if (clampedTarget === idx) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(clampedTarget, 0, item);
      return next;
    });
  }

  function toggleModuleCategory(moduleKey: string, cat: ModuleCategory) {
    setCategoryMap((prev) => {
      const current = prev[moduleKey] ?? [];
      const next = current.includes(cat) ? current.filter((c) => c !== cat) : [...current, cat];
      return { ...prev, [moduleKey]: next };
    });
  }

  async function handleSave() {
    setSaveStatus('saving');
    const newOrderMap: Record<string, number> = {};
    orderedKeys.forEach((key, i) => {
      newOrderMap[key] = i;
    });
    const [categoryError, orderError] = await Promise.all([saveModuleCategoryMap(categoryMap), saveModuleOrderMap(newOrderMap)]);
    if (categoryError || orderError) {
      setSaveStatus('error');
      return;
    }
    setSavedMap(categoryMap);
    setSavedOrderedKeys(orderedKeys);
    setSaveStatus('saved');
    setEditMode(false);
    setTimeout(() => setSaveStatus('idle'), 2000);
  }

  function handleCancel() {
    setCategoryMap(savedMap);
    setOrderedKeys(savedOrderedKeys);
    setEditMode(false);
  }

  if (loading) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  // ---------- 教師視角／一般教師帳號：維持簡單的攤平清單，不做六區分類 ----------
  if (!isAdminView) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
        <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>教學作業</h1>
        <p style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
          {viewMode === 'teacher' ? '目前以「教師」身分檢視，僅顯示教學相關功能' : '教學與查詢功能'}
        </p>
        <ul style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 10 : 8, listStyle: 'none', padding: 0 }}>
          {teacherModules.map((m) => (
            <ModuleListItem
              key={m.key}
              moduleKey={m.key}
              href={m.href}
              label={resolveLabel(m)}
              isMobile={isMobile}
              variant="flat"
              expanded={expandedModuleKeys.has(m.key)}
              onToggle={() => toggleModuleExpanded(m.key)}
            />
          ))}
          {teacherModules.length === 0 && <li style={{ fontSize: 12, color: '#bbb' }}>目前沒有開放給您的功能，如需協助請聯絡系統管理員。</li>}
        </ul>
      </main>
    );
  }

  // ---------- 管理者視角：先擋布告欄，看過（按「我知道」）才放行進工作分類表 ----------
  if (!bulletinAcked) {
    return <BulletinGate posts={bulletinPosts} onAck={handleAckBulletin} />;
  }

  // ---------- 管理者視角：教務／訓導／總務／教師／家長學生／開發人員 六區 ----------
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: isMobile ? '16px 12px' : 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h1 style={{ fontSize: 16 }}>管理後台</h1>
        {isSystemAdminS && !editMode && (
          <button
            onClick={() => setEditMode(true)}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #2C2C2A', background: '#fff', color: '#2C2C2A', fontSize: 13, cursor: 'pointer' }}
          >
            修正分類／順序
          </button>
        )}
        {isSystemAdminS && editMode && (
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCancel}
              style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', color: '#666', fontSize: 13, cursor: 'pointer' }}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#2C2C2A', color: '#fff', fontSize: 13, cursor: 'pointer' }}
            >
              {saveStatus === 'saving' ? '儲存中…' : '儲存分類／順序'}
            </button>
          </span>
        )}
      </div>
      {isSystemAdminS && (
        <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
          想調整「某個帳號」實際看得到哪些功能，請到 <Link href="/admin/accounts">帳號管理</Link> 頁面的「帳號可見內容」區塊設定。
        </p>
      )}
      {saveStatus === 'saved' && <p style={{ fontSize: 12, color: '#3B6D11', marginBottom: 8 }}>分類／順序已儲存</p>}
      {saveStatus === 'error' && (
        <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>
          儲存失敗，請確認資料庫已執行 sql/26fix_department_recursion_and_module_visibility.sql、sql/38admin_module_order.sql
        </p>
      )}

      {editMode ? (
        // ---------- 編輯模式：一份完整清單（依目前排序顯示），每一列可以拖曳調整順序、
        // 直接輸入數字調整順序、或用 ▲▼ 一格一格移動（三種都可以，挑順手的用）；
        // 後面接著六個分類勾選框（可以同時勾多個）。排序是全域的一份順序，不分分類——
        // 同一個功能不管出現在哪個分類區塊，相對順序都一樣。 ----------
        <div>
          <p style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
            調整順序有三種方式，挑順手的用：直接拖曳「≡」那一列、在數字框輸入要排第幾個後按 Enter、
            或用 ▲▼ 一格一格移動。同一份順序會套用到下面所有區塊、也套用到教師登入看到的清單。
            勾選要讓這個功能出現在哪些區塊，可以同時勾多個（例如「成績相關設定及查詢」可以同時勾「教務」跟「教師」，
            兩邊都看得到卡片，實際能操作的範圍還是各自由角色/部門權限決定）。
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ padding: 6 }}>順序</th>
                <th style={{ textAlign: 'left', padding: 6 }}>功能</th>
                {CATEGORY_ORDER.map((cat) => (
                  <th key={cat} style={{ padding: 6 }}>
                    {CATEGORY_LABEL[cat]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedAllModules.map((m, i) => (
                <tr
                  key={m.key}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', m.key);
                    setDraggingKey(m.key);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault(); // 一定要擋掉預設事件，drop 事件才會觸發
                    e.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const draggedKey = e.dataTransfer.getData('text/plain') || draggingKey;
                    if (draggedKey && draggedKey !== m.key) moveModuleToIndex(draggedKey, i);
                    setDraggingKey(null);
                  }}
                  onDragEnd={() => setDraggingKey(null)}
                  style={{ borderTop: '1px solid #eee', background: draggingKey === m.key ? '#F5F5F3' : undefined, cursor: 'grab' }}
                >
                  <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                    <span aria-hidden style={{ marginRight: 6, color: '#999', cursor: 'grab' }}>
                      ≡
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={sortedAllModules.length}
                      value={i + 1}
                      aria-label={`把「${m.label}」排到第幾個`}
                      onChange={(e) => {
                        const targetPos = parseInt(e.target.value, 10);
                        if (!Number.isNaN(targetPos)) moveModuleToIndex(m.key, targetPos - 1);
                      }}
                      style={{ width: 40, padding: '2px 4px', marginRight: 4, textAlign: 'center' }}
                    />
                    <button
                      onClick={() => moveModule(m.key, 'up')}
                      disabled={i === 0}
                      aria-label={`把「${m.label}」往上移`}
                      style={{ padding: '4px 6px', marginRight: 2, border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1 }}
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => moveModule(m.key, 'down')}
                      disabled={i === sortedAllModules.length - 1}
                      aria-label={`把「${m.label}」往下移`}
                      style={{
                        padding: '4px 6px',
                        border: '1px solid #ccc',
                        borderRadius: 6,
                        background: '#fff',
                        cursor: i === sortedAllModules.length - 1 ? 'default' : 'pointer',
                        opacity: i === sortedAllModules.length - 1 ? 0.3 : 1,
                      }}
                    >
                      ▼
                    </button>
                  </td>
                  <td style={{ padding: 6 }}>{resolveLabel(m)}</td>
                  {CATEGORY_ORDER.map((cat) => (
                    <td key={cat} style={{ padding: 6, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={(categoryMap[m.key] ?? []).includes(cat)}
                        onChange={() => toggleModuleCategory(m.key, cat)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 16,
            marginTop: 16,
          }}
        >
          {CATEGORY_ORDER.map((cat) => {
            const color = CATEGORY_COLOR[cat];
            if (modulesByCategory[cat].length === 0) return null; // 沒東西的區塊不用佔位
            return (
              <div
                key={cat}
                style={{
                  background: color.bg,
                  border: `1px solid ${color.border}`,
                  borderRadius: 12,
                  padding: 12,
                  minHeight: 120,
                }}
              >
                <h2 style={{ fontSize: isMobile ? 16 : 14, color: color.title, marginBottom: 2 }}>{CATEGORY_LABEL[cat]}</h2>
                {isMobile ? (
                  // 手機斷點：說明文字預設收合，用原生 <details> 做展開/收合（不用額外寫開關邏輯），
                  // 桌機維持原本「常駐顯示一段說明」的樣子，不受影響。
                  <details style={{ marginBottom: 10 }}>
                    <summary style={{ fontSize: 11, color: color.title, cursor: 'pointer' }}>說明</summary>
                    <p style={{ fontSize: 11, color: '#999', marginTop: 4 }}>{siteContent[`category_hint.${cat}`] ?? CATEGORY_HINT[cat]}</p>
                  </details>
                ) : (
                  <p style={{ fontSize: 11, color: '#999', marginBottom: 10 }}>{siteContent[`category_hint.${cat}`] ?? CATEGORY_HINT[cat]}</p>
                )}
                <ul style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 8 : 6, listStyle: 'none', padding: 0 }}>
                  {modulesByCategory[cat].map((m) => (
                    <ModuleListItem
                      key={m.key}
                      moduleKey={m.key}
                      href={m.href}
                      label={resolveLabel(m)}
                      isMobile={isMobile}
                      variant="card"
                      expanded={expandedModuleKeys.has(m.key)}
                      onToggle={() => toggleModuleExpanded(m.key)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
