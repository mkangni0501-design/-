'use client';

import { useEffect, useState } from 'react';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import BackupRestorePanel from '@/components/dev-tools/BackupRestorePanel';
import BulkExcelPanel from '@/components/dev-tools/BulkExcelPanel';
import TeacherLettersPanel from '@/components/dev-tools/TeacherLettersPanel';
import PasswordPolicySettingsPanel from '@/components/dev-tools/PasswordPolicySettingsPanel';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { hasDepartment } from '@/lib/departments';

export default function DevToolsPage() {
  const [me, setMe] = useState<{ id: string; name: string; role: string } | null>(null);
  const perms = useDepartmentPermissions();

  useEffect(() => {
    (async () => {
      setMe(await getCurrentAppUser());
    })();
  }, []);

  // 歸屬開發人員(dev)部門：只有身兼「開發人員」職務的帳號（或系統管理員S）能用這頁，
  // 對應資料庫端 app_users／backups／account_audit_log 等表已經改成 is_system_admin() or has_department('dev')。
  const isAdmin = me && (perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'dev'));

  if (me && !isAdmin) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>開發人員區</h1>
        <p style={{ fontSize: 13, color: '#999' }}>只有管理員可以查看這個頁面。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>開發人員區</h1>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 24 }}>
        跟系統維運相關、比較「技術性」的功能都集中放在這裡：備份與還原、一次上傳/下載系統內所有Excel表格。
        一般日常操作（登錄成績、點名、查詢學生等）請到首頁其他分類的功能卡片。
      </p>

      <section id="backup-restore" style={{ marginBottom: 40, paddingBottom: 24, borderBottom: '1px solid #eee' }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>備份與還原</h2>
        <BackupRestorePanel />
      </section>

      <section id="bulk-excel" style={{ marginBottom: 40, paddingBottom: 24, borderBottom: '1px solid #eee' }}>
        <h2 style={{ fontSize: 14, marginBottom: 12 }}>一鍵上傳／下載（系統內所有Excel表格）</h2>
        <BulkExcelPanel myRole={me?.role} />
      </section>

      <section id="teacher-letters" style={{ marginBottom: 40, paddingBottom: 24, borderBottom: '1px solid #eee' }}>
        <h2 style={{ fontSize: 14, marginBottom: 4 }}>聘書（歷年教師資料／自聘教師聘書／當年教師聘書／列印）</h2>
        <p style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
          原本要開Excel用VBA巨集列印的「教師資料」，改成在這裡管理：可以下載範本、整批上傳、下載目前資料，也可以逐筆新增/編輯/刪除。
        </p>
        <TeacherLettersPanel userId={me?.id ?? null} />
      </section>

      <section id="password-policy-settings">
        <h2 style={{ fontSize: 14, marginBottom: 4 }}>密碼政策設定</h2>
        <PasswordPolicySettingsPanel />
      </section>
    </main>
  );
}
