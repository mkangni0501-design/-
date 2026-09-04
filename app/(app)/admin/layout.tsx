'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import { getMyDepartments } from '@/lib/departments';
import { ALL_MODULES, computeVisibleModuleKeys, getModuleCategoryMap, getModuleOverridesFor } from '@/lib/adminModules';

const ADMIN_ROLES = ['system_admin_s', 'admin_a', 'admin_b'];

// 這幾個路徑就算不是管理員也能進來，頁面內部自己依角色決定要顯示哪些分頁：
// - /admin 是後台首頁本身，會依角色自動只顯示該身分看得到的區塊。
// - /admin/grading（成績相關設定及查詢）：非管理員只看得到「學生成績登錄」等教學分頁，看不到「成績相關設定」。
// - /admin/registrar（學籍設定及查詢）：非管理員只看得到「查詢學生」分頁，看不到其他學籍管理分頁。
const OPEN_TO_ALL_PATHS = new Set(['/admin', '/admin/grading', '/admin/registrar']);

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<'checking' | 'allowed' | 'denied'>('checking');

  useEffect(() => {
    setStatus('checking');
    (async () => {
      if (pathname && OPEN_TO_ALL_PATHS.has(pathname)) {
        setStatus('allowed');
        return;
      }
      const appUser = await getCurrentAppUser();
      if (!appUser) {
        setStatus('denied');
        return;
      }
      // 「身分切換」到教師視角時，就算帳號角色其實是管理員，這裡也要當作沒有管理員角色權限，
      // 直接照下面「部門/個別例外」那條路徑走（並且部門一律當作空的）——不然像系統管理員S這種
      // 帳號，切成教師視角後只是首頁少顯示幾張卡片，只要知道網址還是能直接進到任何管理頁面，
      // 「身分切換」就形同虛設。
      const viewingAsTeacher = typeof window !== 'undefined' && sessionStorage.getItem('viewMode') === 'teacher';
      if (!viewingAsTeacher && ADMIN_ROLES.includes(appUser.role)) {
        setStatus('allowed');
        return;
      }
      // 這裡原本只認 role（system_admin_s／admin_a／admin_b），部門主管（例如「教務處負責人」）
      // 就算帳號角色是導師／任課教師，只要掛在 app_user_departments 底下，其實已經能通過
      // 對應資料表的 RLS 政策直接寫入（is_department_lead('academic') 那一類判斷），
      // 但先前這裡沒有比照後台首頁（/admin 首頁卡片）的規則一起檢查部門職務，
      // 導致這種帳號在首頁看得到「排課系統」卡片、點進去卻被這裡擋下來「沒有權限」。
      // 這裡改成跟首頁 computeVisibleModuleKeys() 用同一套規則（角色/部門通則 ＋ 個別例外設定），
      // 只要首頁看得到這個功能卡片，這裡就一致地放行。
      const module = ALL_MODULES.find((m) => m.href === pathname);
      if (!module || !module.adminOnly) {
        setStatus('allowed');
        return;
      }
      const [myDepartments, overrides, categoryMap] = await Promise.all([
        viewingAsTeacher ? Promise.resolve([]) : getMyDepartments(appUser.id).then((rows) => rows.map((r) => r.department)),
        getModuleOverridesFor(appUser.id),
        getModuleCategoryMap(),
      ]);
      const visible = computeVisibleModuleKeys({ isSystemAdmin: false, myDepartments, categoryMap, overrides });
      setStatus(visible.has(module.key) ? 'allowed' : 'denied');
    })();
  }, [pathname]);

  if (status === 'checking') {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  if (status === 'denied') {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 8 }}>沒有權限</h1>
        <p style={{ fontSize: 13, color: '#999' }}>
          這個頁面只開放給管理員（系統管理員S／管理者A／管理者B）使用，如需協助請聯絡學校管理員。
        </p>
      </main>
    );
  }

  return <>{children}</>;
}
