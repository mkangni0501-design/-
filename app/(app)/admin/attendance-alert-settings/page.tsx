'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { hasDepartment, isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type Settings = {
  threshold_periods: number;
  exam_deduction_absence_threshold: number | null;
  backfill_overdue_days: number;
};

// 出缺席示警門檻設定：
// 1) 通知信門檻：事假+病假+曠課累計節數達到多少節，導師登錄畫面出現「是否寄信」提示。
// 2) 扣考參考門檻：累計節數達到多少節，視為可能觸及扣考資格（僅供訓導處參考，不自動限制）。
// 3) 補登逾期天數：出缺席記錄距上課日超過幾天，自動視為逾期，需送「開放申請」才能補登/修改。
// 歸屬訓導部門：只有身兼「訓導」職務的帳號（或系統管理員S）能看到這頁。
export default function AttendanceAlertSettingsPage() {
  const perms = useDepartmentPermissions();
  const canView = perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'discipline');
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'discipline');

  const emptySettings: Settings = { threshold_periods: 3, exam_deduction_absence_threshold: null, backfill_overdue_days: 7 };
  const [form, setForm] = useState<Settings>(emptySettings);
  const [saved, setSaved] = useState<Settings>(emptySettings);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data, error } = await supabase
      .from('attendance_alert_settings')
      .select('threshold_periods, exam_deduction_absence_threshold, backfill_overdue_days')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      setLoadError('讀取設定失敗：' + error.message);
      return;
    }
    if (data) {
      setForm(data as Settings);
      setSaved(data as Settings);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  async function handleSave() {
    if (!perms.userId) return;
    setSaving(true);
    try {
      const payload = {
        threshold_periods: form.threshold_periods,
        exam_deduction_absence_threshold: form.exam_deduction_absence_threshold,
        backfill_overdue_days: form.backfill_overdue_days,
        updated_by: perms.userId,
        updated_at: new Date().toISOString(),
      };
      if (canWriteDirect) {
        const { error } = await supabase.from('attendance_alert_settings').update(payload).eq('id', 1);
        if (error) {
          alert('儲存失敗：' + error.message);
          return;
        }
        setSaved(form);
        alert('已儲存');
      } else {
        const { error, pending } = await writeGoverned('attendance_alert_settings', 'update', payload, {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: '1',
          beforeSnapshot: saved,
        });
        if (error) {
          alert('送出申請失敗：' + error);
          return;
        }
        if (pending) alert('已送出申請，等訓導主管核准後才會生效。');
      }
    } finally {
      setSaving(false);
    }
  }

  if (perms.loading) return null;

  if (!canView) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺席示警門檻設定</h1>
        <p style={{ fontSize: 13, color: '#999' }}>本頁僅提供訓導處人員使用。</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 520, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>出缺席示警門檻設定</h1>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {!canWriteDirect && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是訓導承辦人員，這裡的修改會先送給訓導主管核准。
        </p>
      )}
      <PendingChangesReviewPanel
        department="discipline"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'discipline') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          通知信門檻：
          <input
            type="number"
            min={1}
            value={form.threshold_periods}
            onChange={(e) => setForm({ ...form, threshold_periods: Number(e.target.value) })}
            style={{ padding: 8, width: 100 }}
          />
          節
        </label>
        <p style={{ fontSize: 11, color: '#999' }}>
          當某位學生「事假＋病假＋曠課」累計節數達到這個數字時，導師登錄出缺勤畫面會出現「是否寄送通知信」的提示，
          家長/學生查詢頁在達到門檻一半時也會特別放大顯示提醒。
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          扣考參考門檻：
          <input
            type="number"
            min={1}
            placeholder="不設定則不顯示提醒"
            value={form.exam_deduction_absence_threshold ?? ''}
            onChange={(e) => setForm({ ...form, exam_deduction_absence_threshold: e.target.value ? Number(e.target.value) : null })}
            style={{ padding: 8, width: 160 }}
          />
          節
        </label>
        <p style={{ fontSize: 11, color: '#999' }}>
          累計節數達到這個數字時，該生會出現在「扣考參考名單」提醒訓導處注意，但系統不會自動限制報名考試或登錄成績，
          是否真的扣考仍由訓導處人工審查認定。留空代表不啟用這項提醒。
        </p>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          出缺席補登逾期天數：
          <input
            type="number"
            min={1}
            value={form.backfill_overdue_days}
            onChange={(e) => setForm({ ...form, backfill_overdue_days: Number(e.target.value) })}
            style={{ padding: 8, width: 100 }}
          />
          天
        </label>
        <p style={{ fontSize: 11, color: '#999' }}>
          出缺席記錄距離上課日超過這個天數，導師/任課教師就無法再自行補登或修改，需送出「出缺勤鎖定開放申請」給訓導核准後才能補登。
        </p>
      </div>

      <button
        onClick={handleSave}
        disabled={saving || !dirty}
        style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}
      >
        {saving ? '儲存中…' : canWriteDirect ? '儲存' : '送出申請'}
      </button>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="attendance_alert_settings" />}
    </main>
  );
}
