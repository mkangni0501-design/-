'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { hasDepartment, isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type Bill = {
  id: string;
  category: '水費' | '電費' | '網路費' | '其他';
  billing_month: string;
  amount: number;
  paid: boolean;
  paid_date: string | null;
  note: string | null;
};

const emptyForm = { category: '電費' as Bill['category'], billing_month: '', amount: '', note: '' };

export default function UtilityBillsPage() {
  const perms = useDepartmentPermissions();
  const canView = perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'general');
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'general');

  const [bills, setBills] = useState<Bill[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.from('utility_bills').select('*').order('billing_month', { ascending: false });
    setLoadError(error ? '讀取費用清單失敗：' + error.message : null);
    setBills((data ?? []) as Bill[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId || !form.billing_month) return;
    const payload = {
      category: form.category,
      billing_month: form.billing_month + '-01',
      amount: Number(form.amount),
      note: form.note || null,
      recorded_by: perms.userId,
    };
    const { error, pending } = await writeGoverned('utility_bills', 'insert', payload, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
    });
    if (error) {
      alert('新增失敗：' + error);
      return;
    }
    if (pending) alert('已送出新增申請，等總務主管核准後才會生效。');
    setForm({ ...emptyForm, category: form.category });
    load();
  }

  async function handleTogglePaid(bill: Bill) {
    if (!perms.userId) return;
    const payload = { paid: !bill.paid, paid_date: !bill.paid ? new Date().toISOString().slice(0, 10) : null };
    if (canWriteDirect) {
      const { error } = await supabase.from('utility_bills').update(payload).eq('id', bill.id);
      if (error) {
        alert('更新失敗：' + error.message);
        return;
      }
    } else {
      const { error, pending } = await writeGoverned('utility_bills', 'update', payload, {
        myDepartments: perms.myDepartments,
        isSystemAdmin: perms.isSystemAdmin,
        requestedBy: perms.userId,
        recordKey: bill.id,
        beforeSnapshot: bill,
      });
      if (error) {
        alert('送出申請失敗：' + error);
        return;
      }
      if (pending) alert('已送出申請，等總務主管核准後才會生效。');
    }
    load();
  }

  if (perms.loading) return null;

  if (!canView) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 16, marginBottom: 4 }}>水電網路等費用</h1>
        <p style={{ fontSize: 13, color: '#999' }}>本頁僅提供總務處人員使用。</p>
      </main>
    );
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>水電網路等費用</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>登記每月水費/電費/網路費等帳單金額與繳費狀態。</p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {!canWriteDirect && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是總務承辦人員，這裡的新增／更新會先送給總務主管核准。
        </p>
      )}
      <PendingChangesReviewPanel
        department="general"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'general') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Bill['category'] })} style={{ padding: 6 }}>
          <option value="水費">水費</option>
          <option value="電費">電費</option>
          <option value="網路費">網路費</option>
          <option value="其他">其他</option>
        </select>
        <input type="month" value={form.billing_month} onChange={(e) => setForm({ ...form, billing_month: e.target.value })} style={{ padding: 6 }} required />
        <input type="number" step="0.01" placeholder="金額" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} style={{ padding: 6, width: 110 }} required />
        <input placeholder="備註" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ padding: 6, width: 140 }} />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增' : '送出新增申請'}
        </button>
      </form>

      {perms.userId && <MyPendingChangesList userId={perms.userId} tableName="utility_bills" />}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>月份</th>
            <th style={{ textAlign: 'left', padding: 6 }}>類別</th>
            <th style={{ textAlign: 'right', padding: 6 }}>金額</th>
            <th style={{ textAlign: 'left', padding: 6 }}>繳費狀態</th>
            <th style={{ textAlign: 'left', padding: 6 }}>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{b.billing_month.slice(0, 7)}</td>
              <td style={{ padding: 6 }}>{b.category}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>{b.amount}</td>
              <td style={{ padding: 6 }}>
                {b.paid ? `已繳（${b.paid_date}）` : <span style={{ color: '#A32D2D' }}>未繳</span>}
              </td>
              <td style={{ padding: 6 }}>{b.note ?? '—'}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>
                <button onClick={() => handleTogglePaid(b)} style={{ fontSize: 12 }}>
                  {b.paid ? '標示未繳' : '標示已繳'}
                </button>
              </td>
            </tr>
          ))}
          {bills.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                目前沒有費用紀錄
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
