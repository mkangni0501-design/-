'use client';

import { useEffect, useState } from 'react';
import { supabase, ROLE_LABEL, UserRole } from '@/lib/supabaseClient';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import { downloadAccountsList, ACCOUNTS_SHEET_NAME } from '@/lib/excelTemplates';
import { inviteAccountsSheet } from '@/lib/bulkHandlers';
import { canManageAccount, assignableRoles, namesLikelySamePerson } from '@/lib/periodConfig';
import { AdminDepartment, DepartmentLevel, MyDepartment, DEPARTMENT_LABEL, getMyDepartments, setDepartmentsFor } from '@/lib/departments';
import {
  ALL_MODULES,
  CATEGORY_LABEL,
  ModuleCategory,
  computeVisibleModuleKeys,
  getModuleCategoryMap,
  getModuleOverridesFor,
  saveModuleOverridesFor,
} from '@/lib/adminModules';

const ALL_DEPARTMENTS: AdminDepartment[] = ['dev', 'academic', 'discipline', 'general'];

type AppUser = { id: string; name: string; role: UserRole };
type AuditLogRow = {
  id: string;
  target_user_id: string;
  action: 'role_change' | 'password_reset';
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
};

export default function AdminAccountsPage() {
  const [me, setMe] = useState<AppUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('admin_b');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  // 建帳號時如果對象是導師/任課教師，讓管理者可以直接勾選要綁定哪一筆「還沒連結帳號」的既有教師資料
  // （例如批次匯入課表時打的名字跟這裡輸入的不完全一樣，系統自動比對抓不到），
  // 不綁定的話會照原本邏輯自動用同名比對、找不到才新建。
  const [unlinkedTeachers, setUnlinkedTeachers] = useState<{ id: string; name: string }[]>([]);
  const [bindTeacherId, setBindTeacherId] = useState('');
  // 姓名很像既有教師資料時，跳出來讓管理者確認的提示卡（顯示那筆既有資料目前的導師班/任教科目班級），
  // 管理者要親自按「是，綁定」或「否，仍新增」才會繼續，不會自動幫忙決定。
  const [matchCandidate, setMatchCandidate] = useState<{ id: string; name: string } | null>(null);
  const [matchCandidateInfo, setMatchCandidateInfo] = useState<string[] | null>(null);
  const [matchDismissedFor, setMatchDismissedFor] = useState<string | null>(null); // 记录已经手动确认过「否」的姓名，避免同一个字每打一下就再跳一次
  const [roleEdits, setRoleEdits] = useState<Record<string, UserRole>>({});
  const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [armedDelete, setArmedDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 孤兒帳號（信箱已在 Supabase Auth 註冊，但 app_users 沒有對應角色資料，導致「信箱已存在」
  // 卻在清單裡完全看不到）：只有系統管理員S看得到、能清理，見 /api/admin/orphaned-accounts。
  const [orphaned, setOrphaned] = useState<{ id: string; email: string | null; created_at: string }[] | null>(null);
  const [orphanedError, setOrphanedError] = useState<string | null>(null);
  const [orphanedLoading, setOrphanedLoading] = useState(false);
  const [deletingOrphanId, setDeletingOrphanId] = useState<string | null>(null);
  // 孤兒帳號批次刪除／逐筆編輯（補上姓名＋角色，讓帳號變成可以正常使用，不用刪除重建）
  const [orphanedSelected, setOrphanedSelected] = useState<Set<string>>(new Set());
  const [batchDeletingOrphans, setBatchDeletingOrphans] = useState(false);
  const [editingOrphanId, setEditingOrphanId] = useState<string | null>(null);
  const [editOrphanName, setEditOrphanName] = useState('');
  const [editOrphanRole, setEditOrphanRole] = useState<UserRole>('homeroom_teacher');
  const [savingOrphanEdit, setSavingOrphanEdit] = useState(false);

  // 帳號多重部門職務（app_user_departments）：只有系統管理員S能查看/調整。
  // 一個帳號可以同時勾選多個部門（例如身兼教務＋總務），每個部門各自選 lead(主管)/staff(承辦)。
  const [deptEdits, setDeptEdits] = useState<Record<string, Partial<Record<AdminDepartment, DepartmentLevel>>>>({});
  const [savingDeptFor, setSavingDeptFor] = useState<string | null>(null);

  // 帳號個別可見內容（app_user_module_overrides）：系統管理員S挑一個帳號後展開，
  // 逐項打勾決定要不要覆蓋掉「角色/部門」原本算出來的通則結果。
  const [categoryMap, setCategoryMap] = useState<Record<string, ModuleCategory[]>>({});
  const [visibilityUserId, setVisibilityUserId] = useState<string>('');
  const [visibilityChecks, setVisibilityChecks] = useState<Record<string, boolean>>({});
  const [visibilityLoading, setVisibilityLoading] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);

  async function loadVisibilityFor(userId: string) {
    setVisibilityUserId(userId);
    if (!userId) return;
    setVisibilityLoading(true);
    try {
      const target = users.find((u) => u.id === userId);
      const [myDepartments, overrides, catMap] = await Promise.all([
        getMyDepartments(userId).then((rows) => rows.map((r) => r.department)),
        getModuleOverridesFor(userId),
        categoryMap && Object.keys(categoryMap).length > 0 ? Promise.resolve(categoryMap) : getModuleCategoryMap(),
      ]);
      if (Object.keys(categoryMap).length === 0) setCategoryMap(catMap);
      const isSystemAdmin = target?.role === 'system_admin_s';
      const defaults = computeVisibleModuleKeys({ isSystemAdmin, myDepartments, categoryMap: catMap });
      const checks: Record<string, boolean> = {};
      for (const m of ALL_MODULES) checks[m.key] = m.key in overrides ? overrides[m.key] : defaults.has(m.key);
      setVisibilityChecks(checks);
    } finally {
      setVisibilityLoading(false);
    }
  }

  function toggleVisibility(moduleKey: string) {
    setVisibilityChecks((prev) => ({ ...prev, [moduleKey]: !prev[moduleKey] }));
  }

  async function handleSaveVisibility() {
    if (!visibilityUserId) return;
    setSavingVisibility(true);
    try {
      const target = users.find((u) => u.id === visibilityUserId);
      const isSystemAdmin = target?.role === 'system_admin_s';
      const myDepartments = await getMyDepartments(visibilityUserId).then((rows) => rows.map((r) => r.department));
      const defaults = computeVisibleModuleKeys({ isSystemAdmin, myDepartments, categoryMap });
      // 只把「跟通則不一樣」的項目存成例外，一樣的不用存，之後通則變動時才不會被舊例外卡住
      const overrides: Record<string, boolean> = {};
      for (const m of ALL_MODULES) {
        const checked = !!visibilityChecks[m.key];
        if (checked !== defaults.has(m.key)) overrides[m.key] = checked;
      }
      const { error } = await saveModuleOverridesFor(visibilityUserId, overrides);
      if (error) {
        alert('儲存可見內容失敗：' + error);
        return;
      }
      alert('已儲存可見內容設定');
    } finally {
      setSavingVisibility(false);
    }
  }

  async function loadDepartments() {
    const { data, error } = await supabase.from('app_user_departments').select('app_user_id, department, level');
    if (error) return; // 非系統管理員S會被RLS擋下來，這是預期行為，安靜失敗即可
    const grouped: Record<string, Partial<Record<AdminDepartment, DepartmentLevel>>> = {};
    (data ?? []).forEach((row: any) => {
      grouped[row.app_user_id] = grouped[row.app_user_id] ?? {};
      grouped[row.app_user_id][row.department as AdminDepartment] = row.level as DepartmentLevel;
    });
    setDeptEdits(grouped);
  }

  function toggleDept(userId: string, dept: AdminDepartment) {
    setDeptEdits((prev) => {
      const current = { ...(prev[userId] ?? {}) };
      if (current[dept]) delete current[dept];
      else current[dept] = 'staff';
      return { ...prev, [userId]: current };
    });
  }

  function setDeptLevel(userId: string, dept: AdminDepartment, level: DepartmentLevel) {
    setDeptEdits((prev) => ({ ...prev, [userId]: { ...(prev[userId] ?? {}), [dept]: level } }));
  }

  async function handleSaveDepartments(userId: string) {
    setSavingDeptFor(userId);
    try {
      const entry = deptEdits[userId] ?? {};
      const departments: MyDepartment[] = ALL_DEPARTMENTS.filter((d) => entry[d]).map((d) => ({ department: d, level: entry[d]! }));
      const { error } = await setDepartmentsFor(userId, departments);
      if (error) {
        alert('儲存部門職務失敗：' + error);
        return;
      }
      alert('已儲存部門職務');
    } finally {
      setSavingDeptFor(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBatchDelete() {
    if (selected.size === 0) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch('/api/admin/delete-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetUserIds: Array.from(selected) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('批次刪除失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      if (body.errors?.length > 0) {
        alert('部分帳號刪除失敗：\n' + body.errors.join('\n'));
      } else {
        alert(`已刪除 ${body.deleted.length} 個帳號`);
      }
      setSelected(new Set());
      setArmedDelete(false);
      loadUsers();
      loadAuditLog();
    } finally {
      setDeleting(false);
    }
  }

  async function loadAuditLog() {
    const { data } = await supabase
      .from('account_audit_log')
      .select('id, target_user_id, action, old_value, new_value, changed_by, changed_at')
      .order('changed_at', { ascending: false })
      .limit(50);
    setAuditLog((data ?? []) as AuditLogRow[]);
  }

  async function loadUsers() {
    const { data, error } = await supabase.from('app_users').select('id, name, role');
    if (error) {
      setLoadError('讀取帳號清單失敗：' + error.message);
      return;
    }
    setUsers((data ?? []) as AppUser[]);
  }

  async function loadMe() {
    setLoadError(null);
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData.user) {
      setLoadError('尚未登入或登入已過期，請重新整理頁面再登入一次：' + (authErr?.message ?? ''));
      return;
    }
    const { data, error } = await supabase.from('app_users').select('id, name, role').eq('id', authData.user.id).maybeSingle();
    if (error) {
      setLoadError('讀取您自己的帳號角色失敗（可能是 app_users 資料表的權限設定問題）：' + error.message);
      return;
    }
    if (!data) {
      setLoadError('找不到您這個帳號在 app_users 裡的角色資料，請確認資料庫裡有正確建立這筆資料。');
      return;
    }
    setMe(data as AppUser);
  }

  async function loadOrphaned() {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return;
    setOrphanedLoading(true);
    setOrphanedError(null);
    try {
      const res = await fetch('/api/admin/orphaned-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 非系統管理員S會被擋（403），這是預期行為，不用顯示錯誤訊息干擾畫面
        if (res.status !== 403) setOrphanedError(body.error ?? '讀取孤兒帳號失敗');
        return;
      }
      setOrphaned(body.orphaned ?? []);
    } finally {
      setOrphanedLoading(false);
    }
  }

  async function handleDeleteOrphaned(id: string) {
    if (!confirm('確定要刪除這個孤兒登入帳號嗎？刪除後這個信箱就可以重新正確新增帳號了。')) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return;
    setDeletingOrphanId(id);
    try {
      const res = await fetch('/api/admin/delete-orphaned-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetAuthUserId: id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('刪除失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      loadOrphaned();
    } finally {
      setDeletingOrphanId(null);
    }
  }

  function toggleOrphanSelect(id: string) {
    setOrphanedSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBatchDeleteOrphaned() {
    if (orphanedSelected.size === 0) return;
    if (!confirm(`確定要刪除這 ${orphanedSelected.size} 個孤兒登入帳號嗎？刪除後這些信箱就可以重新正確新增帳號了。`)) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setBatchDeletingOrphans(true);
    try {
      const res = await fetch('/api/admin/delete-orphaned-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetAuthUserIds: Array.from(orphanedSelected) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('批次刪除失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      if (body.errors?.length > 0) alert('部分帳號刪除失敗：\n' + body.errors.join('\n'));
      else alert(`已刪除 ${body.deleted.length} 個孤兒帳號`);
      setOrphanedSelected(new Set());
      loadOrphaned();
    } finally {
      setBatchDeletingOrphans(false);
    }
  }

  function startEditOrphan(id: string) {
    setEditingOrphanId(id);
    setEditOrphanName('');
    setEditOrphanRole(creatableRoles[0] ?? 'homeroom_teacher');
  }

  async function handleSaveOrphanEdit() {
    if (!editingOrphanId || !editOrphanName.trim()) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setSavingOrphanEdit(true);
    try {
      const res = await fetch('/api/admin/edit-orphaned-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetAuthUserId: editingOrphanId, name: editOrphanName.trim(), role: editOrphanRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('編輯失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      alert('已補上帳號資料，這個帳號現在可以正常使用了');
      setEditingOrphanId(null);
      loadOrphaned();
      loadUsers();
    } finally {
      setSavingOrphanEdit(false);
    }
  }

  useEffect(() => {
    loadMe();
    loadUsers();
    loadAuditLog();
    loadDepartments();
    getModuleCategoryMap().then(setCategoryMap);
  }, []);

  useEffect(() => {
    if (me?.role === 'system_admin_s') loadOrphaned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // 系統管理員S：可新增 system_admin_s（另一位系統管理員S）、admin_a / admin_b，以及導師/任課教師帳號
  // 系統管理員A：可新增 admin_a（自己同角色），以及導師/任課教師帳號
  // 管理員B：可新增 admin_b（自己同角色），以及導師/任課教師帳號
  const creatableRoles: UserRole[] =
    me?.role === 'system_admin_s'
      ? ['system_admin_s', 'admin_a', 'admin_b', 'homeroom_teacher', 'subject_teacher']
      : me?.role === 'admin_a'
      ? ['admin_a', 'homeroom_teacher', 'subject_teacher']
      : me?.role === 'admin_b'
      ? ['admin_b', 'homeroom_teacher', 'subject_teacher']
      : [];

  useEffect(() => {
    if (creatableRoles.length > 0 && !creatableRoles.includes(newRole)) {
      setNewRole(creatableRoles[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  useEffect(() => {
    if (newRole !== 'homeroom_teacher' && newRole !== 'subject_teacher') {
      setUnlinkedTeachers([]);
      setBindTeacherId('');
      setMatchCandidate(null);
      setMatchCandidateInfo(null);
      return;
    }
    (async () => {
      const { data } = await supabase.from('teachers').select('id, name').is('app_user_id', null).order('name');
      setUnlinkedTeachers((data ?? []) as any);
    })();
  }, [newRole]);

  // 姓名一改動，就重新比對「還沒連結帳號」的既有教師資料裡有沒有名字很像的（正規化後完全一樣，
  // 或其中一個是另一個的簡稱），有的話跳提示卡讓管理者確認，不會自動幫忙綁定或新增。
  useEffect(() => {
    setMatchCandidateInfo(null);
    if (!newName.trim() || unlinkedTeachers.length === 0) {
      setMatchCandidate(null);
      return;
    }
    if (matchDismissedFor === newName.trim()) {
      setMatchCandidate(null);
      return;
    }
    const found = unlinkedTeachers.find((t) => namesLikelySamePerson(t.name, newName));
    setMatchCandidate(found ?? null);
  }, [newName, unlinkedTeachers, matchDismissedFor]);

  useEffect(() => {
    if (!matchCandidate) return;
    (async () => {
      const [{ data: homeroomOf }, { data: teachingRows }] = await Promise.all([
        supabase.from('classes').select('academic_year, grade_level, class_name').eq('homeroom_teacher_id', matchCandidate.id),
        supabase
          .from('class_schedule')
          .select('academic_year, term, subject, classes(grade_level, class_name)')
          .eq('teacher_id', matchCandidate.id)
          .not('weekday', 'is', null)
          .limit(20),
      ]);
      const lines: string[] = [];
      (homeroomOf ?? []).forEach((c: any) => lines.push(`${c.academic_year}學年度 導師：${c.grade_level}${c.class_name}`));
      const taughtSet = new Set<string>();
      (teachingRows ?? []).forEach((r: any) => {
        if (r.classes) taughtSet.add(`${r.academic_year}學年度／${r.term}：${r.classes.grade_level}${r.classes.class_name}－${r.subject}`);
      });
      taughtSet.forEach((l) => lines.push(l));
      setMatchCandidateInfo(lines.length > 0 ? lines : ['（目前查不到這筆教師資料有排課紀錄）']);
    })();
  }, [matchCandidate]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!me || creatableRoles.length === 0) return;
    if (matchCandidate && !bindTeacherId && matchDismissedFor !== newName.trim()) {
      alert(`系統偵測到「${matchCandidate.name}」很可能已經有教師資料，請先在下面確認是否要綁定同一人，再新增帳號`);
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }

    const res = await fetch('/api/admin/invite-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        email: newEmail,
        name: newName,
        role: creatableRoles.length > 1 ? newRole : creatableRoles[0],
        password: newPassword || undefined,
        bindTeacherId: bindTeacherId || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert('新增失敗：' + (body.error ?? '未知錯誤'));
      return;
    }
    alert(newPassword ? '帳號已建立，可直接用這組密碼登入' : '已寄出邀請信');
    setNewEmail('');
    setNewName('');
    setNewPassword('');
    setBindTeacherId('');
    setMatchCandidate(null);
    setMatchCandidateInfo(null);
    setMatchDismissedFor(null);
    loadUsers();
  }

  async function handleUpdateRole(targetUserId: string) {
    const newRole = roleEdits[targetUserId];
    if (!newRole) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    setSavingRoleFor(targetUserId);
    try {
      const res = await fetch('/api/admin/update-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetUserId, newRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('更新角色失敗：' + (body.error ?? '未知錯誤'));
        return;
      }
      if (body.logWarning) alert(body.logWarning);
      loadUsers();
      loadAuditLog();
    } finally {
      setSavingRoleFor(null);
    }
  }

  async function handleResetPassword(targetUserId: string, targetName: string) {
    const newPw = prompt(`為「${targetName}」設定新密碼（至少6碼）：`);
    if (!newPw) return;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      alert('請重新登入');
      return;
    }
    const res = await fetch('/api/admin/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ targetUserId, newPassword: newPw }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert('重設密碼失敗：' + (body.error ?? '未知錯誤'));
      return;
    }
    alert(body.logWarning ?? '密碼已重設，請告知對方新密碼');
    loadAuditLog();
  }

  // 解析「帳號名單」格式：姓名,電子郵件,角色（第3列起為資料），逐筆呼叫邀請API
  async function handleUploadFile(file: File) {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return { successCount: 0, errors: ['請重新登入'] };

    const buf = await file.arrayBuffer();
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames.includes(ACCOUNTS_SHEET_NAME) ? ACCOUNTS_SHEET_NAME : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rowsRaw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    const result = await inviteAccountsSheet(rowsRaw, accessToken, creatableRoles);
    loadUsers();
    return result;
  }

  // 「下載目前帳號名單」：前端 users 只有 id/姓名/角色（沒有信箱），先呼叫API把信箱補回來，
  // 密碼欄一律留空，格式跟批次上傳範本一致，下載下來可以直接修改後重新上傳。
  async function handleDownloadAccountsList() {
    if (users.length === 0) {
      await downloadAccountsList([]);
      return;
    }
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    let emails: Record<string, string | null> = {};
    if (accessToken) {
      try {
        const res = await fetch('/api/admin/list-accounts-with-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ userIds: users.map((u) => u.id) }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) emails = body.emails ?? {};
      } catch {
        // 查詢信箱失敗不擋下載，仍會下載出檔案，只是信箱欄位顯示查無資料
      }
    }
    await downloadAccountsList(users.map((u) => ({ name: u.name, role: u.role, email: emails[u.id] ?? null })));
  }

  if (loadError) {
    return (
      <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>帳號管理</h1>
        <p style={{ fontSize: 13, color: '#A32D2D', background: '#FBEEEE', border: '1px solid #E5C6C6', borderRadius: 6, padding: 12 }}>
          {loadError}
        </p>
      </main>
    );
  }
  if (!me) return <main style={{ padding: 24 }}>載入中…</main>;

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>帳號管理</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        目前身分：{ROLE_LABEL[me.role]}
        {creatableRoles.length > 0 && '。您可以在下面新增/批次邀請：' + creatableRoles.map((r) => ROLE_LABEL[r]).join('、')}
      </p>

      {me.role === 'system_admin_s' && (orphanedLoading || orphanedError || (orphaned && orphaned.length > 0)) && (
        <div style={{ marginBottom: 20, padding: 12, background: '#FBF3EA', border: '1px solid #E5D6C6', borderRadius: 8 }}>
          <h2 id="orphaned" style={{ fontSize: 13, color: '#8A5A00', marginBottom: 4 }}>孤兒帳號（信箱已註冊，但清單裡看不到）</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            這些信箱在登入系統裡已經存在（新增帳號時會被擋「這個信箱已經有帳號了」），但沒有對應的角色資料，
            不會出現在下面的帳號清單裡，通常是之前新增失敗留下的殘留。刪除後就可以用同一個信箱重新正確新增。
          </p>
          {orphanedLoading && <p style={{ fontSize: 12, color: '#999' }}>檢查中…</p>}
          {orphanedError && <p style={{ fontSize: 12, color: '#A32D2D' }}>{orphanedError}</p>}
          {orphaned && orphaned.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={handleBatchDeleteOrphaned}
                disabled={orphanedSelected.size === 0 || batchDeletingOrphans}
                style={{
                  padding: '4px 10px',
                  background: orphanedSelected.size === 0 ? '#eee' : '#A32D2D',
                  color: orphanedSelected.size === 0 ? '#999' : '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: orphanedSelected.size === 0 ? 'default' : 'pointer',
                }}
              >
                {batchDeletingOrphans ? '刪除中…' : `批次刪除已勾選（${orphanedSelected.size}）`}
              </button>
            </div>
          )}
          {orphaned && orphaned.map((o) => (
            <div key={o.id} style={{ padding: '4px 0', borderBottom: '1px solid #EEE0CE' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={orphanedSelected.has(o.id)} onChange={() => toggleOrphanSelect(o.id)} />
                  {o.email ?? '（無信箱）'}　<span style={{ color: '#999', fontSize: 11 }}>建立於 {new Date(o.created_at).toLocaleString()}</span>
                </span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => (editingOrphanId === o.id ? setEditingOrphanId(null) : startEditOrphan(o.id))}
                    style={{ padding: '4px 10px', background: '#fff', color: '#8A5A00', border: '1px solid #8A5A00', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                  >
                    {editingOrphanId === o.id ? '取消編輯' : '編輯'}
                  </button>
                  <button
                    onClick={() => handleDeleteOrphaned(o.id)}
                    disabled={deletingOrphanId === o.id}
                    style={{ padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                  >
                    {deletingOrphanId === o.id ? '刪除中…' : '刪除'}
                  </button>
                </span>
              </div>
              {editingOrphanId === o.id && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0 8px 22px' }}>
                  <span style={{ fontSize: 11, color: '#666' }}>補上姓名＋角色，這個帳號就能正常使用（不用刪除重建）：</span>
                  <input
                    placeholder="姓名"
                    value={editOrphanName}
                    onChange={(e) => setEditOrphanName(e.target.value)}
                    style={{ padding: 6, fontSize: 12, width: 120 }}
                  />
                  <select value={editOrphanRole} onChange={(e) => setEditOrphanRole(e.target.value as UserRole)} style={{ padding: 6, fontSize: 12 }}>
                    {creatableRoles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleSaveOrphanEdit}
                    disabled={!editOrphanName.trim() || savingOrphanEdit}
                    style={{ padding: '4px 10px', background: '#2C6E9E', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                  >
                    {savingOrphanEdit ? '儲存中…' : '儲存'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {creatableRoles.length === 0 && (
        <p style={{ fontSize: 13, color: '#A36A2D', background: '#FBF3EA', border: '1px solid #E5D6C6', borderRadius: 6, padding: 12, marginBottom: 16 }}>
          您目前的身分（{ROLE_LABEL[me.role]}）沒有新增帳號的權限，所以看不到批次上傳/手動新增區塊。只有系統管理員S／系統管理員A／管理員B可以新增帳號。
        </p>
      )}

      {creatableRoles.length > 0 && (
        <>
          <h2 style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
            批次上傳（格式同「{ACCOUNTS_SHEET_NAME}」工作表；有填「初始密碼」欄位就直接建立可登入帳號、不寄信，沒填則逐筆寄邀請信）
          </h2>
          <div style={{ marginBottom: 12 }}>
            <TemplateDownloadButton label="下載帳號名單（已有帳號＝目前資料／尚無帳號＝範本，密碼欄一律留空）" onClick={handleDownloadAccountsList} />
            <ExcelUploadButton onFile={handleUploadFile} />
          </div>
        </>
      )}

      {creatableRoles.length > 0 && (
        <form onSubmit={handleInvite} style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <input
            placeholder="姓名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ padding: 8, flex: 1 }}
            required
          />
          <input
            type="email"
            placeholder="電子郵件"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            style={{ padding: 8, flex: 1 }}
            required
          />
          {creatableRoles.length > 1 && (
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)} style={{ padding: 8 }}>
              {creatableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          )}
          {unlinkedTeachers.length > 0 && (
            <select
              value={bindTeacherId}
              onChange={(e) => {
                setBindTeacherId(e.target.value);
                if (e.target.value) setMatchDismissedFor(null);
              }}
              style={{ padding: 8 }}
              title="系統會自動偵測姓名很像的既有教師資料並跳提示卡確認；如果那筆沒抓到但您知道是同一人，也可以在這裡手動選"
            >
              <option value="">（不綁定，用姓名自動比對／新增）</option>
              {unlinkedTeachers.map((t) => (
                <option key={t.id} value={t.id}>
                  綁定既有教師資料：{t.name}
                </option>
              ))}
            </select>
          )}

          {matchCandidate && matchDismissedFor !== newName.trim() && (
            <div
              style={{
                background: '#FFF8E1',
                border: '1px solid #f0d98a',
                borderRadius: 8,
                padding: 12,
                width: '100%',
                fontSize: 13,
              }}
            >
              <p style={{ marginBottom: 6 }}>
                系統偵測到「{newName}」姓名跟既有教師資料「<strong>{matchCandidate.name}</strong>」很像（可能只是多空格、簡稱、全形半形不同），是否是同一個人？
              </p>
              {matchCandidateInfo ? (
                <ul style={{ paddingLeft: 18, marginBottom: 8, color: '#555' }}>
                  {matchCandidateInfo.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ color: '#999', marginBottom: 8 }}>查詢這筆教師資料的相關紀錄中…</p>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setBindTeacherId(matchCandidate.id);
                    setMatchDismissedFor(null);
                  }}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    background: bindTeacherId === matchCandidate.id ? '#2C6E9E' : undefined,
                    color: bindTeacherId === matchCandidate.id ? '#fff' : undefined,
                  }}
                >
                  是，綁定同一人
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMatchDismissedFor(newName.trim());
                    setBindTeacherId('');
                  }}
                  style={{ padding: '6px 14px', fontSize: 12 }}
                >
                  否，是不同的人，仍新增
                </button>
              </div>
            </div>
          )}

          <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
            <input
              type={showNewPassword ? 'text' : 'password'}
              placeholder="初始密碼（選填，至少6碼；有填就直接建立可登入帳號、不寄信）"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={{ padding: 8, width: '100%', boxSizing: 'border-box', paddingRight: 56 }}
            />
            <button
              type="button"
              onClick={() => setShowNewPassword((s) => !s)}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: '#666',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {showNewPassword ? '隱藏' : '顯示'}
            </button>
          </div>
          <button type="submit" style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
            新增{ROLE_LABEL[creatableRoles.length > 1 ? newRole : creatableRoles[0]]}
          </button>
        </form>
      )}

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#666' }}>已選取 {selected.size} 筆</span>
          {!armedDelete ? (
            <>
              <button onClick={() => setArmedDelete(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                批次刪除
              </button>
              <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消選取
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: '#A32D2D' }}>
                確定要刪除這 {selected.size} 個帳號嗎？此動作無法復原（教師本身的班級/課表/成績資料會保留，只是這些帳號無法再登入）。
              </span>
              <button
                onClick={handleBatchDelete}
                disabled={deleting}
                style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}
              >
                {deleting ? '刪除中…' : '確定刪除'}
              </button>
              <button onClick={() => setArmedDelete(false)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 32 }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }}>
              <input
                type="checkbox"
                checked={users.length > 0 && users.filter((u) => canManageAccount(me.role, u.role)).every((u) => selected.has(u.id)) && users.some((u) => canManageAccount(me.role, u.role))}
                onChange={() =>
                  setSelected((prev) => {
                    const manageableIds = users.filter((u) => canManageAccount(me.role, u.role)).map((u) => u.id);
                    const allSelected = manageableIds.length > 0 && manageableIds.every((id) => prev.has(id));
                    return allSelected ? new Set() : new Set(manageableIds);
                  })
                }
              />
            </th>
            <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
            <th style={{ textAlign: 'left', padding: 6 }}>角色</th>
            <th style={{ textAlign: 'left', padding: 6 }}>編輯角色</th>
            <th style={{ textAlign: 'left', padding: 6 }}>密碼</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const manageable = me.id !== u.id && canManageAccount(me.role, u.role);
            const options = assignableRoles(me.role);
            return (
              <tr key={u.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 6 }}>
                  {manageable ? (
                    <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleSelect(u.id)} />
                  ) : (
                    <span style={{ color: '#ccc' }}>—</span>
                  )}
                </td>
                <td style={{ padding: 6 }}>{u.name}</td>
                <td style={{ padding: 6 }}>{ROLE_LABEL[u.role]}</td>
                <td style={{ padding: 6 }}>
                  {manageable ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        value={roleEdits[u.id] ?? u.role}
                        onChange={(e) => setRoleEdits((prev) => ({ ...prev, [u.id]: e.target.value as UserRole }))}
                        style={{ padding: 4, fontSize: 12 }}
                      >
                        <option value={u.role}>{ROLE_LABEL[u.role]}（不變）</option>
                        {options
                          .filter((r) => r !== u.role)
                          .map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r as UserRole]}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={() => handleUpdateRole(u.id)}
                        disabled={savingRoleFor === u.id || (roleEdits[u.id] ?? u.role) === u.role}
                        style={{ fontSize: 12, padding: '2px 8px' }}
                      >
                        {savingRoleFor === u.id ? '更新中…' : '更新'}
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: '#ccc' }}>—</span>
                  )}
                </td>
                <td style={{ padding: 6 }}>
                  {manageable ? (
                    <button onClick={() => handleResetPassword(u.id, u.name)} style={{ fontSize: 12, padding: '2px 8px' }}>
                      重設密碼
                    </button>
                  ) : (
                    <span style={{ color: '#ccc' }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {me.role === 'system_admin_s' && (
        <>
          <h2 id="departments" style={{ fontSize: 13, marginBottom: 4 }}>部門職務指派（教務／訓導／總務／開發人員）</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            一個帳號可以同時勾選多個部門（例如身兼教務＋總務）。每個部門要選「主管(lead，可核准送審申請、可直接寫入)」或「承辦(staff，新增/修改/刪除需送審)」。
            只有這裡有勾選部門的帳號，才能使用對應部門的管理功能；只有系統管理員S能調整這裡。
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 32 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
                {ALL_DEPARTMENTS.map((d) => (
                  <th key={d} style={{ textAlign: 'center', padding: 6 }}>
                    {DEPARTMENT_LABEL[d]}
                  </th>
                ))}
                <th style={{ padding: 6 }}></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const entry = deptEdits[u.id] ?? {};
                return (
                  <tr key={u.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{u.name}</td>
                    {ALL_DEPARTMENTS.map((d) => (
                      <td key={d} style={{ padding: 6, textAlign: 'center' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          <input type="checkbox" checked={!!entry[d]} onChange={() => toggleDept(u.id, d)} />
                          {entry[d] && (
                            <select
                              value={entry[d]}
                              onChange={(e) => setDeptLevel(u.id, d, e.target.value as DepartmentLevel)}
                              style={{ fontSize: 11, padding: 1 }}
                            >
                              <option value="staff">承辦</option>
                              <option value="lead">主管</option>
                            </select>
                          )}
                        </div>
                      </td>
                    ))}
                    <td style={{ padding: 6, textAlign: 'right' }}>
                      <button
                        onClick={() => handleSaveDepartments(u.id)}
                        disabled={savingDeptFor === u.id}
                        style={{ fontSize: 12, padding: '2px 8px' }}
                      >
                        {savingDeptFor === u.id ? '儲存中…' : '儲存'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {me.role === 'system_admin_s' && (
        <>
          <h2 id="overrides" style={{ fontSize: 13, marginBottom: 4 }}>帳號可見內容（個別調整）</h2>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
            預設情況下，一個帳號看不看得到某功能是由「角色」＋「上面的部門職務」決定。這裡可以再針對「單一帳號」開放或隱藏個別功能，
            不會影響其他同角色/同部門的人。挑一個帳號後，勾選狀態預設就是目前的通則結果，只有跟通則不同的勾選才會被存成例外。
          </p>
          <select
            value={visibilityUserId}
            onChange={(e) => loadVisibilityFor(e.target.value)}
            style={{ padding: 6, fontSize: 13, marginBottom: 12 }}
          >
            <option value="">請選擇帳號…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}（{ROLE_LABEL[u.role]}）
              </option>
            ))}
          </select>

          {visibilityUserId && visibilityLoading && <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>}

          {visibilityUserId && !visibilityLoading && (
            <div style={{ marginBottom: 32 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                {(['academic', 'discipline', 'general', 'teacher', 'parent_student', 'dev'] as ModuleCategory[]).map((cat) => {
                  const modules = ALL_MODULES.filter((m) => (categoryMap[m.key] ?? []).includes(cat));
                  if (modules.length === 0) return null;
                  return (
                    <div key={cat} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10 }}>
                      <h3 style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{CATEGORY_LABEL[cat]}</h3>
                      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {modules.map((m) => (
                          <li key={m.key} style={{ fontSize: 12 }}>
                            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                              <input
                                type="checkbox"
                                checked={!!visibilityChecks[m.key]}
                                onChange={() => toggleVisibility(m.key)}
                              />
                              <span>{m.label}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <button onClick={handleSaveVisibility} disabled={savingVisibility} style={{ fontSize: 12, padding: '6px 14px' }}>
                {savingVisibility ? '儲存中…' : '儲存可見內容'}
              </button>
            </div>
          )}
        </>
      )}

      {['system_admin_s', 'admin_a', 'admin_b'].includes(me.role) && (
        <>
          <h2 id="audit-log" style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>帳號異動紀錄（角色變更／密碼重設，最近50筆）</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>時間</th>
                <th style={{ textAlign: 'left', padding: 6 }}>對象</th>
                <th style={{ textAlign: 'left', padding: 6 }}>動作</th>
                <th style={{ textAlign: 'left', padding: 6 }}>內容</th>
                <th style={{ textAlign: 'left', padding: 6 }}>異動者</th>
              </tr>
            </thead>
            <tbody>
              {auditLog.map((log) => {
                const target = users.find((u) => u.id === log.target_user_id);
                const changer = users.find((u) => u.id === log.changed_by);
                return (
                  <tr key={log.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{new Date(log.changed_at).toLocaleString()}</td>
                    <td style={{ padding: 6 }}>{target?.name ?? log.target_user_id}</td>
                    <td style={{ padding: 6 }}>{log.action === 'role_change' ? '角色變更' : '密碼重設'}</td>
                    <td style={{ padding: 6 }}>
                      {log.action === 'role_change'
                        ? `${ROLE_LABEL[log.old_value as UserRole] ?? log.old_value} → ${ROLE_LABEL[log.new_value as UserRole] ?? log.new_value}`
                        : log.new_value}
                    </td>
                    <td style={{ padding: 6 }}>{changer?.name ?? log.changed_by ?? '—'}</td>
                  </tr>
                );
              })}
              {auditLog.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    尚無異動紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
