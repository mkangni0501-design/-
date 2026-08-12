'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type RequestRow = {
  id: string;
  requested_by: string;
  scope: string;
  scope_ref: string | null;
  reason: string | null;
  status: string;
  created_at: string;
};

// 出缺勤「申請開放」審核：導師在「學生出缺席登錄（一週）」頁面，
// 遇到整班/整週被鎖定時送出的開放申請，在這裡由管理員A／系統管理員S審核。
// 核准後直接把對應的 submission_windows 解鎖（is_locked=false），導師才能再次登錄。
export default function AttendanceUnlockRequestsPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [classLabels, setClassLabels] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const appUser = await getCurrentAppUser();
    const admin = !!appUser && ['system_admin_s', 'admin_a'].includes(appUser.role);
    setIsAdmin(admin);
    if (!admin) return;

    const { data, error } = await supabase
      .from('correction_requests')
      .select('id, requested_by, scope, scope_ref, reason, status, created_at')
      .eq('data_type', '出缺勤')
      .not('scope', 'is', null)
      .eq('status', '待審核')
      .order('created_at');
    if (error) {
      setLoadError('讀取申請清單失敗：' + error.message);
      return;
    }
    const rows = (data ?? []) as RequestRow[];
    setRequests(rows);

    const teacherIds = Array.from(new Set(rows.map((r) => r.requested_by)));
    if (teacherIds.length > 0) {
      const { data: teacherRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
      const map: Record<string, string> = {};
      (teacherRows ?? []).forEach((t: any) => (map[t.id] = t.name));
      setTeacherNames(map);
    }

    const classIds = Array.from(new Set(rows.filter((r) => r.scope === '班級' && r.scope_ref).map((r) => r.scope_ref as string)));
    if (classIds.length > 0) {
      const { data: classRows } = await supabase.from('classes').select('id, academic_year, grade_level, class_name').in('id', classIds);
      const map: Record<string, string> = {};
      (classRows ?? []).forEach((c: any) => (map[c.id] = `${c.academic_year} ${c.grade_level}${c.class_name}`));
      setClassLabels(map);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function scopeLabel(r: RequestRow) {
    if (r.scope === '班級') return classLabels[r.scope_ref ?? ''] ?? `班級（${r.scope_ref}）`;
    if (r.scope === '部別') return `部別：${r.scope_ref}`;
    return '全校';
  }

  async function handleDecision(r: RequestRow, decision: '核准' | '駁回') {
    setBusyId(r.id);
    const appUser = await getCurrentAppUser();
    if (!appUser) {
      setBusyId(null);
      return;
    }

    if (decision === '核准' && r.scope) {
      // 核准：直接把對應範圍的出缺勤鎖定解除，導師才能再次登錄。
      // 這裡沿用既有做法（不查 academic_year/term，跟「學生出缺席登錄」頁面查詢鎖定狀態的方式一致）。
      const { error: unlockErr } = await supabase
        .from('submission_windows')
        .update({ is_locked: false })
        .eq('data_type', '出缺勤')
        .eq('scope', r.scope)
        .eq('scope_ref', r.scope_ref);
      if (unlockErr) {
        alert('解鎖失敗：' + unlockErr.message);
        setBusyId(null);
        return;
      }
    }

    const { error } = await supabase
      .from('correction_requests')
      .update({ status: decision, reviewed_by: appUser.id, reviewed_at: new Date().toISOString() })
      .eq('id', r.id);
    setBusyId(null);
    if (error) {
      alert('處理失敗：' + error.message);
      return;
    }
    load();
  }

  if (!isAdmin) {
    return (
      <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺勤鎖定開放申請審核</h1>
        <p style={{ fontSize: 13, color: '#999' }}>本頁僅提供管理員A／系統管理員S使用。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺勤鎖定開放申請審核</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        導師在「學生出缺席登錄（一週）」頁面遇到整班鎖定時送出的開放申請，核准後會直接解除該範圍的鎖定。
      </p>
      <ErrorBanner message={loadError} />

      {requests.length === 0 && <p style={{ fontSize: 13, color: '#666' }}>目前沒有待審核的申請。</p>}

      {requests.map((r) => (
        <div key={r.id} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
          <p style={{ fontSize: 13 }}>
            {teacherNames[r.requested_by] ?? r.requested_by} 申請開放：{scopeLabel(r)}
          </p>
          {r.reason && <p style={{ fontSize: 13, color: '#666' }}>原因：{r.reason}</p>}
          <p style={{ fontSize: 12, color: '#999' }}>{new Date(r.created_at).toLocaleString('zh-TW')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => handleDecision(r, '核准')}
              disabled={busyId === r.id}
              style={{ padding: '4px 12px', background: '#3B6D11', color: '#fff', border: 'none', borderRadius: 6 }}
            >
              核准並解鎖
            </button>
            <button
              onClick={() => handleDecision(r, '駁回')}
              disabled={busyId === r.id}
              style={{ padding: '4px 12px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 6 }}
            >
              駁回
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}
