'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type Row = { department: string; grade_level: string; next_department: string; next_grade_level: string };

const emptyForm = { department: '', grade_level: '', next_department: '', next_grade_level: '' };

export default function GradeProgressionPage() {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'academic');

  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState(emptyForm);

  async function load() {
    const { data } = await supabase.from('grade_progression').select('*').order('department');
    setRows((data ?? []) as Row[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    if (canWriteDirect) {
      const { error } = await supabase.from('grade_progression').upsert(form, { onConflict: 'department,grade_level' });
      if (error) {
        alert('儲存失敗：' + error.message);
        return;
      }
    } else {
      const existing = rows.find((r) => r.department === form.department && r.grade_level === form.grade_level);
      const { error, pending } = await writeGoverned(
        'grade_progression',
        existing ? 'update' : 'insert',
        form,
        {
          myDepartments: perms.myDepartments,
          isSystemAdmin: perms.isSystemAdmin,
          requestedBy: perms.userId,
          recordKey: existing ? `${form.department}|${form.grade_level}` : undefined,
          beforeSnapshot: existing ?? null,
        }
      );
      if (error) {
        alert('送出申請失敗：' + error);
        return;
      }
      if (pending) alert('已送出申請，等教務主管核准後才會生效。');
    }
    setForm(emptyForm);
    load();
  }

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>年級升級對照表</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        設定每個部別/年級，升級後會變成哪個部別/年級（例如：國小5年 → 國小6年，國小6年 → 國中1年）。「升級作業」會照這張表自動算出每個學生升級後該去的年級。
      </p>

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是教務承辦人員，這裡的新增／修改會先送給教務主管核准。
        </p>
      )}
      <PendingChangesReviewPanel
        department="academic"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'academic') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <input placeholder="目前部別" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} style={{ padding: 6, width: 100 }} required />
        <input placeholder="目前年級" value={form.grade_level} onChange={(e) => setForm({ ...form, grade_level: e.target.value })} style={{ padding: 6, width: 100 }} required />
        <span style={{ padding: 6 }}>→</span>
        <input placeholder="升級後部別" value={form.next_department} onChange={(e) => setForm({ ...form, next_department: e.target.value })} style={{ padding: 6, width: 100 }} required />
        <input placeholder="升級後年級" value={form.next_grade_level} onChange={(e) => setForm({ ...form, next_grade_level: e.target.value })} style={{ padding: 6, width: 100 }} required />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增／更新' : '送出申請'}
        </button>
      </form>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="grade_progression" />}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>目前</th>
            <th style={{ textAlign: 'left', padding: 6 }}>升級後</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.department}-${r.grade_level}`} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.department} {r.grade_level}</td>
              <td style={{ padding: 6 }}>{r.next_department} {r.next_grade_level}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
