'use client';

import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { isDepartmentLead, DEPARTMENT_LABEL, AdminDepartment } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';

const ALL_DEPARTMENTS: AdminDepartment[] = ['dev', 'academic', 'discipline', 'general'];

// 送審總覽：把各部門的送審清單彙整在同一頁，不用分別跑去各功能頁面看。
// 只顯示「我有主管權限的部門」（系統管理員S會看到全部4個部門）。
export default function PendingChangesOverviewPage() {
  const perms = useDepartmentPermissions();

  if (perms.loading) return null;

  const departmentsICanReview = perms.isSystemAdmin
    ? ALL_DEPARTMENTS
    : ALL_DEPARTMENTS.filter((d) => isDepartmentLead(perms.myDepartments, d));

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>送審總覽</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        彙整各部門的送審申請（教務/訓導/總務/開發人員承辦人員送出的新增/修改/刪除申請），核准/駁回後會自動生效，
        不用再分別跑去各功能頁面個別查看。
      </p>

      {departmentsICanReview.length === 0 && (
        <p style={{ fontSize: 13, color: '#999' }}>您目前不是任何部門的主管，沒有需要核准的送審清單。</p>
      )}

      {departmentsICanReview.map((dept) => (
        <div key={dept} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 6 }}>{DEPARTMENT_LABEL[dept]}</h2>
          <PendingChangesReviewPanel department={dept} reviewerId={perms.userId ?? ''} canReview={true} />
        </div>
      ))}
    </div>
  );
}
