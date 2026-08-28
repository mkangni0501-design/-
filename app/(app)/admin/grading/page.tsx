'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { isDepartmentLead } from '@/lib/departments';
import CurriculumSettingsTab from '@/components/admin-tabs/CurriculumSettingsTab';
import GradingRulesTab from '@/components/admin-tabs/GradingRulesTab';
import ScoresEntryTab from '@/components/admin-tabs/ScoresEntryTab';
import ConductScoresTab from '@/components/admin-tabs/ConductScoresTab';
import ReportCardStyleTab from '@/components/admin-tabs/ReportCardStyleTab';
import ClassSummaryTab from '@/components/admin-tabs/ClassSummaryTab';
import ClassResultsTab from '@/components/admin-tabs/ClassResultsTab';
import SchoolRankingsTab from '@/components/admin-tabs/SchoolRankingsTab';
import HistoryTab from '@/components/admin-tabs/HistoryTab';
import BatchReportCardTab from '@/components/admin-tabs/BatchReportCardTab';
import ReportCardMergeTemplateTab from '@/components/admin-tabs/ReportCardMergeTemplateTab';

type TabKey =
  | 'settings'
  | 'entry'
  | 'conduct'
  | 'class-summary'
  | 'class-results'
  | 'school-rankings'
  | 'history'
  | 'batch-print'
  | 'report-card-style'
  | 'report-card-merge-template';

const TABS: { key: TabKey; label: string; adminOnly: boolean }[] = [
  { key: 'settings', label: '成績相關設定', adminOnly: true },
  { key: 'entry', label: '學生成績登錄', adminOnly: false },
  { key: 'conduct', label: '操行成績評分', adminOnly: false },
  { key: 'class-summary', label: '班級成績總表', adminOnly: false },
  { key: 'class-results', label: '班級成績結果與排名', adminOnly: false },
  { key: 'school-rankings', label: '全校排行榜', adminOnly: false },
  { key: 'history', label: '歷年成績查詢', adminOnly: false },
  { key: 'batch-print', label: '批次列印成績單（多班／全校）', adminOnly: true },
  { key: 'report-card-style', label: '成績單樣式設定', adminOnly: true },
  { key: 'report-card-merge-template', label: '成績單合併列印範本', adminOnly: true },
];

const TAB_KEYS: TabKey[] = TABS.map((t) => t.key);

function GradingHubPageInner() {
  // 這裡原本只認角色（system_admin_s／admin_a／admin_b），教務處負責人如果帳號角色是
  // 導師／任課教師（只是掛在 app_user_departments 底下當「教務」主管），會完全看不到
  // 「成績相關設定」「批次列印成績單」這兩個分頁——但底下 GradingRulesTab／
  // CurriculumSettingsTab 元件自己其實都已經比照這樣的人可以直接寫入（canWriteDirect），
  // 只是分頁本身先被擋住、根本點不進去。改成跟底下元件用同一套規則判斷。
  const perms = useDepartmentPermissions();
  const isAdmin = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('entry');
  // 從管理後台首頁「展開細項」點進來時，網址會帶 ?tab=xxx，直接跳到對應分頁；
  // 沒帶／帶了不認得的值，維持原本「依身分決定預設分頁」的行為。
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab') as TabKey | null;

  useEffect(() => {
    if (perms.loading) return;
    const fallback = isAdmin ? 'settings' : 'entry';
    setTab(requestedTab && TAB_KEYS.includes(requestedTab) ? requestedTab : fallback);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms.loading, isAdmin, requestedTab]);

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
      <h1 style={{ fontSize: 16, marginBottom: 12 }}>成績相關設定及查詢</h1>
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

      {tab === 'settings' && isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          <section>
            <h2 style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>科目與比重設定</h2>
            <CurriculumSettingsTab />
          </section>
          <section style={{ borderTop: '1px solid #eee', paddingTop: 24 }}>
            <h2 style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>整體佔比與加扣分規則</h2>
            <GradingRulesTab />
          </section>
        </div>
      )}
      {tab === 'entry' && <ScoresEntryTab />}
      {tab === 'conduct' && <ConductScoresTab />}
      {tab === 'class-summary' && <ClassSummaryTab />}
      {tab === 'class-results' && <ClassResultsTab />}
      {tab === 'school-rankings' && <SchoolRankingsTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'batch-print' && isAdmin && <BatchReportCardTab />}
      {tab === 'report-card-style' && isAdmin && <ReportCardStyleTab />}
      {tab === 'report-card-merge-template' && isAdmin && <ReportCardMergeTemplateTab />}
    </main>
  );
}

export default function GradingHubPage() {
  return (
    <Suspense fallback={null}>
      <GradingHubPageInner />
    </Suspense>
  );
}
