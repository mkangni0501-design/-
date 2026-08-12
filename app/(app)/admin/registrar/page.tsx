'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import StudentsSearchTab from '@/components/admin-tabs/StudentsSearchTab';
import StudentsNewTab from '@/components/admin-tabs/StudentsNewTab';
import StudentsImportTab from '@/components/admin-tabs/StudentsImportTab';
import StudentsStatusChangeTab from '@/components/admin-tabs/StudentsStatusChangeTab';
import StudentsTransferTab from '@/components/admin-tabs/StudentsTransferTab';
import StudentsPromotionTab from '@/components/admin-tabs/StudentsPromotionTab';
import GradeProgressionTab from '@/components/admin-tabs/GradeProgressionTab';

const ADMIN_ROLES = ['system_admin_s', 'admin_a', 'admin_b'];

type TabKey = 'search' | 'new' | 'import' | 'status-change' | 'transfer' | 'promotion' | 'grade-progression';

const TABS: { key: TabKey; label: string; adminOnly: boolean }[] = [
  { key: 'search', label: '查詢學生（全校／各班級）', adminOnly: false },
  { key: 'new', label: '新生入學登記（完整版）', adminOnly: true },
  { key: 'import', label: '既有學生快速建檔（精簡版）', adminOnly: true },
  { key: 'status-change', label: '學籍狀態變更', adminOnly: true },
  { key: 'transfer', label: '學期中轉班', adminOnly: true },
  { key: 'promotion', label: '升級作業', adminOnly: true },
  { key: 'grade-progression', label: '年級升級對照表設定', adminOnly: true },
];

const TAB_KEYS: TabKey[] = TABS.map((t) => t.key);

function RegistrarHubPageInner() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('search');
  // 從管理後台首頁「展開細項」點進來時，網址會帶 ?tab=xxx，直接跳到對應分頁。
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab') as TabKey | null;

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      setIsAdmin(isAdminInCurrentView(appUser?.role));
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (requestedTab && TAB_KEYS.includes(requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

  if (loading) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  const visibleTabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 12 }}>學籍設定及查詢</h1>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid #eee', marginBottom: 20 }}>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid #2C2C2A' : '2px solid transparent',
              background: 'none',
              fontSize: 13,
              color: tab === t.key ? '#2C2C2A' : '#999',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'search' && <StudentsSearchTab />}
      {isAdmin && tab === 'new' && <StudentsNewTab />}
      {isAdmin && tab === 'import' && <StudentsImportTab />}
      {isAdmin && tab === 'status-change' && <StudentsStatusChangeTab />}
      {isAdmin && tab === 'transfer' && <StudentsTransferTab />}
      {isAdmin && tab === 'promotion' && <StudentsPromotionTab />}
      {isAdmin && tab === 'grade-progression' && <GradeProgressionTab />}
    </main>
  );
}

export default function RegistrarHubPage() {
  return (
    <Suspense fallback={null}>
      <RegistrarHubPageInner />
    </Suspense>
  );
}
