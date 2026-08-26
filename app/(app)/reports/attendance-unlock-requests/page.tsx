'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser } from '@/lib/supabaseClient';
import ErrorBanner from '@/components/ErrorBanner';

type RequestRow = {
  id: string;
  requested_by: string;
  scope: string | null;
  scope_ref: string | null;
  record_id: string | null;
  reason: string | null;
  status: string;
  created_at: string;
};

// 出缺勤修正／開放申請審核：
// 【2026-08-26 修正】原本這頁只顯示「整班/整週鎖定」時送出的開放申請
// （scope 不是空值的那種），完全沒有顯示導師在單一格「補登超過範圍」時
// 送出的個別修正申請（record_id 有值、scope 是空值的那種）——這種申請
// 送出後會直接存進資料庫（沒有錯誤），但整個系統找不到任何畫面可以審核
// 它，等於卡死在「待審核」狀態永遠沒有人看得到、也永遠不會生效，導師
// 會感覺像是「送出後沒有真的送出去」。
// 修正：拿掉原本 `.not('scope','is',null)` 的篩選，兩種類型的申請都撈出來，
// 畫面上用 scope 是否有值來分開顯示「範圍開放申請」跟「單筆補登修正申請」，
// 審核邏輯本來就已經只在 `scope` 有值時才會去解鎖 submission_windows
// （單筆修正申請不需要這一步——核准後 has_approved_correction() 這個資料庫
// 函式會直接生效，讓導師能重新編輯那一筆紀錄，不需要額外的動作）。
export default function AttendanceUnlockRequestsPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [classLabels, setClassLabels] = useState<Record<string, string>>({});
  const [recordLabels, setRecordLabels] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const appUser = await getCurrentAppUser();
    const admin = !!appUser && ['system_admin_s', 'admin_a'].includes(appUser.role);
    setIsAdmin(admin);
    if (!admin) return;

    const { data, error } = await supabase
      .from('correction_requests')
      .select('id, requested_by, scope, scope_ref, record_id, reason, status, created_at')
      .eq('data_type', '出缺勤')
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

    // 單筆修正申請：record_id 指向 attendance.id，撈出對應的學生/日期/節次，
    // 讓審核畫面能顯示「哪個學生、哪一天、第幾節」，而不是只有一串 record_id。
    const recordIds = Array.from(new Set(rows.filter((r) => r.record_id).map((r) => r.record_id as string)));
    if (recordIds.length > 0) {
      const { data: attRows } = await supabase
        .from('attendance')
        .select('id, student_no, record_date, period_no')
        .in('id', recordIds);
      const studentNos = Array.from(new Set((attRows ?? []).map((a: any) => a.student_no)));
      const { data: studentRows } = studentNos.length
        ? await supabase.from('students').select('student_no, name').in('student_no', studentNos)
        : { data: [] as any[] };
      const nameMap: Record<string, string> = {};
      (studentRows ?? []).forEach((s: any) => (nameMap[s.student_no] = s.name));
      const map: Record<string, string> = {};
      (attRows ?? []).forEach((a: any) => {
        map[a.id] = `${nameMap[a.student_no] ?? a.student_no}　${a.record_date}　第${a.period_no}節`;
      });
      setRecordLabels(map);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function scopeLabel(r: RequestRow) {
    if (r.record_id) return recordLabels[r.record_id] ?? `單筆紀錄（${r.record_id}）`;
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
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺勤修正／開放申請審核</h1>
        <p style={{ fontSize: 13, color: '#999' }}>本頁僅提供管理員A／系統管理員S使用。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺勤修正／開放申請審核</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        導師在「學生出缺席登錄（一週）」頁面送出的兩種申請都會列在這裡：整班/整週鎖定時的「申請開放」（核准後解除該範圍鎖定），
        以及單一格「補登超過範圍」時針對某一筆紀錄送出的修正申請（核准後導師就能重新編輯那一筆紀錄，不影響其他紀錄）。
      </p>
      <ErrorBanner message={loadError} />

      {requests.length === 0 && <p style={{ fontSize: 13, color: '#666' }}>目前沒有待審核的申請。</p>}

      {requests.map((r) => (
        <div key={r.id} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
          <p style={{ fontSize: 13 }}>
            {teacherNames[r.requested_by] ?? r.requested_by} 申請{r.record_id ? '修正' : '開放'}：{scopeLabel(r)}
          </p>
          {r.reason && <p style={{ fontSize: 13, color: '#666' }}>原因：{r.reason}</p>}
          <p style={{ fontSize: 12, color: '#999' }}>{new Date(r.created_at).toLocaleString('zh-TW')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => handleDecision(r, '核准')}
              disabled={busyId === r.id}
              style={{ padding: '4px 12px', background: '#3B6D11', color: '#fff', border: 'none', borderRadius: 6 }}
            >
              {r.record_id ? '核准' : '核准並解鎖'}
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
