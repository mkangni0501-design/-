'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { hasDepartment, isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';

type Ticket = {
  id: string;
  location: string;
  issue: string;
  status: '待處理' | '處理中' | '已完成' | '取消';
  assigned_to: string | null;
  reported_at: string;
  resolved_at: string | null;
  note: string | null;
};

const emptyForm = { location: '', issue: '' };

// 修繕登記：任何教職員都可以在這裡回報壞掉的東西（不需要是總務也能通報），
// 但只有總務主管／系統管理員S能指派承辦廠商、更新處理狀態、結案。
export default function MaintenancePage() {
  const perms = useDepartmentPermissions();
  const canManage = perms.isSystemAdmin || hasDepartment(perms.myDepartments, 'general');
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'general');

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, { status: string; assigned_to: string }>>({});

  async function load() {
    const { data, error } = await supabase.from('maintenance_tickets').select('*').order('reported_at', { ascending: false });
    setLoadError(error ? '讀取修繕清單失敗：' + error.message : null);
    setTickets((data ?? []) as Ticket[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleReport(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    // 回報新問題：所有教職員都能直接寫入（RLS已開放任何登入者insert），不用走送審。
    const { error } = await supabase.from('maintenance_tickets').insert({
      location: form.location,
      issue: form.issue,
      reported_by: perms.userId,
    });
    if (error) {
      alert('回報失敗：' + error.message);
      return;
    }
    setForm(emptyForm);
    load();
  }

  async function handleUpdateStatus(ticket: Ticket) {
    if (!perms.userId) return;
    const draft = editDrafts[ticket.id] ?? { status: ticket.status, assigned_to: ticket.assigned_to ?? '' };
    const payload = {
      status: draft.status,
      assigned_to: draft.assigned_to || null,
      resolved_at: draft.status === '已完成' ? new Date().toISOString() : null,
    };
    if (canWriteDirect) {
      const { error } = await supabase.from('maintenance_tickets').update(payload).eq('id', ticket.id);
      if (error) {
        alert('更新失敗：' + error.message);
        return;
      }
    } else {
      const { error, pending } = await writeGoverned('maintenance_tickets', 'update', payload, {
        myDepartments: perms.myDepartments,
        isSystemAdmin: perms.isSystemAdmin,
        requestedBy: perms.userId,
        recordKey: ticket.id,
        beforeSnapshot: ticket,
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

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>修繕登記</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        發現設備或設施損壞，任何教職員都可以在這裡回報，總務處會安排處理。
      </p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>回報新問題</h2>
      <form onSubmit={handleReport} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 24 }}>
        <input placeholder="地點（例如：三年一班）" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} style={{ padding: 6, width: 160 }} required />
        <input placeholder="問題描述" value={form.issue} onChange={(e) => setForm({ ...form, issue: e.target.value })} style={{ padding: 6, width: 260 }} required />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          送出回報
        </button>
      </form>

      {!canManage ? (
        <p style={{ fontSize: 13, color: '#999' }}>後續處理狀態僅提供總務處人員查看與更新。</p>
      ) : (
        <>
          {!canWriteDirect && (
            <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
              您的帳號是總務承辦人員，更新狀態會先送給總務主管核准。
            </p>
          )}
          <PendingChangesReviewPanel
            department="general"
            reviewerId={perms.userId ?? ''}
            canReview={isDepartmentLead(perms.myDepartments, 'general') || perms.isSystemAdmin}
            onReviewed={load}
          />
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 6 }}>回報時間</th>
                <th style={{ textAlign: 'left', padding: 6 }}>地點</th>
                <th style={{ textAlign: 'left', padding: 6 }}>問題</th>
                <th style={{ textAlign: 'left', padding: 6 }}>承辦</th>
                <th style={{ textAlign: 'left', padding: 6 }}>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const draft = editDrafts[t.id] ?? { status: t.status, assigned_to: t.assigned_to ?? '' };
                return (
                  <tr key={t.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{new Date(t.reported_at).toLocaleDateString('zh-TW')}</td>
                    <td style={{ padding: 6 }}>{t.location}</td>
                    <td style={{ padding: 6 }}>{t.issue}</td>
                    <td style={{ padding: 6 }}>
                      <input
                        value={draft.assigned_to}
                        onChange={(e) => setEditDrafts({ ...editDrafts, [t.id]: { ...draft, assigned_to: e.target.value } })}
                        placeholder="承辦人/廠商"
                        style={{ fontSize: 12, padding: 4, width: 100 }}
                      />
                    </td>
                    <td style={{ padding: 6 }}>
                      <select
                        value={draft.status}
                        onChange={(e) => setEditDrafts({ ...editDrafts, [t.id]: { ...draft, status: e.target.value } })}
                        style={{ fontSize: 12, padding: 4 }}
                      >
                        <option value="待處理">待處理</option>
                        <option value="處理中">處理中</option>
                        <option value="已完成">已完成</option>
                        <option value="取消">取消</option>
                      </select>
                    </td>
                    <td style={{ padding: 6 }}>
                      <button onClick={() => handleUpdateStatus(t)} style={{ fontSize: 12 }}>
                        {canWriteDirect ? '儲存' : '送出申請'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {tickets.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                    目前沒有修繕紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
