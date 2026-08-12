'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useDepartmentPermissions } from '@/lib/useDepartmentPermissions';
import { writeGoverned } from '@/lib/pendingChanges';
import { isDepartmentLead } from '@/lib/departments';
import PendingChangesReviewPanel from '@/components/PendingChangesReviewPanel';
import MyPendingChangesList from '@/components/MyPendingChangesList';

type Category = '書庫' | '校服' | '簿本';

type Item = {
  id: string;
  category: Category;
  name: string;
  spec: string | null;
  unit: string;
  unit_price: number | null;
  quantity_on_hand: number;
  note: string | null;
};

const DIRECTIONS_BY_CATEGORY: Record<Category, { in: string; out: string }> = {
  書庫: { in: '歸還', out: '借出' },
  校服: { in: '入庫', out: '售出' },
  簿本: { in: '入庫', out: '售出' },
};

const emptyItemForm = { name: '', spec: '', unit: '件', unit_price: '', note: '' };
const emptyTxForm = { itemId: '', direction: '', quantity: '1', counterparty: '', note: '' };

export default function InventoryAdminPage({ category, title, hint }: { category: Category; title: string; hint: string }) {
  const perms = useDepartmentPermissions();
  const canWriteDirect = perms.isSystemAdmin || isDepartmentLead(perms.myDepartments, 'general');

  const [items, setItems] = useState<Item[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [txForm, setTxForm] = useState(emptyTxForm);

  const dirs = DIRECTIONS_BY_CATEGORY[category];

  async function load() {
    const { data, error } = await supabase
      .from('general_inventory_items')
      .select('*')
      .eq('category', category)
      .order('name');
    setLoadError(error ? '讀取清單失敗：' + error.message : null);
    setItems((data ?? []) as Item[]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId) return;
    const payload = {
      category,
      name: itemForm.name,
      spec: itemForm.spec || null,
      unit: itemForm.unit || '件',
      unit_price: itemForm.unit_price ? Number(itemForm.unit_price) : null,
      note: itemForm.note || null,
      created_by: perms.userId,
    };
    const { error, pending } = await writeGoverned('general_inventory_items', 'insert', payload, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
    });
    if (error) {
      alert('新增失敗：' + error);
      return;
    }
    if (pending) alert('已送出新增申請，等總務主管核准後才會生效。');
    setItemForm(emptyItemForm);
    load();
  }

  async function handleDeleteItem(id: string) {
    if (!perms.userId) return;
    if (!confirm('確定要刪除這個品項嗎？這個品項底下所有的進出紀錄也會一併被刪除，無法復原！')) return;
    const row = items.find((r) => r.id === id);
    const { error, pending } = await writeGoverned('general_inventory_items', 'delete', {}, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
      recordKey: id,
      beforeSnapshot: row ?? null,
    });
    if (error) {
      alert('刪除失敗：' + error);
      return;
    }
    if (pending) alert('已送出刪除申請，等總務主管核准後才會真正刪除。');
    load();
  }

  async function handleAddTransaction(e: React.FormEvent) {
    e.preventDefault();
    if (!perms.userId || !txForm.itemId || !txForm.direction) return;
    const item = items.find((i) => i.id === txForm.itemId);
    const payload = {
      item_id: txForm.itemId,
      direction: txForm.direction,
      quantity: Number(txForm.quantity),
      unit_price_at_time: txForm.direction === dirs.out && item?.unit_price != null ? item.unit_price : null,
      counterparty: txForm.counterparty || null,
      note: txForm.note || null,
      recorded_by: perms.userId,
    };
    const { error, pending } = await writeGoverned('general_inventory_transactions', 'insert', payload, {
      myDepartments: perms.myDepartments,
      isSystemAdmin: perms.isSystemAdmin,
      requestedBy: perms.userId,
    });
    if (error) {
      alert('登記失敗：' + error);
      return;
    }
    if (pending) alert('已送出登記申請，等總務主管核准後庫存才會更新。');
    setTxForm({ ...emptyTxForm, direction: txForm.direction });
    load();
  }

  if (perms.loading) return null;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>{title}</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>{hint}</p>
      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}

      {!canWriteDirect && perms.userId && (
        <p style={{ fontSize: 12, color: '#A36A00', background: '#FFF8E1', border: '1px solid #f0d98a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          您的帳號是總務承辦人員，這裡的新增／登記／刪除會先送給總務主管核准，核准後庫存數量才會更新。
        </p>
      )}
      <PendingChangesReviewPanel
        department="general"
        reviewerId={perms.userId ?? ''}
        canReview={isDepartmentLead(perms.myDepartments, 'general') || perms.isSystemAdmin}
        onReviewed={load}
      />

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>新增品項</h2>
      <form onSubmit={handleAddItem} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <input placeholder="品名" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} style={{ padding: 6, width: 140 }} required />
        <input placeholder="規格（選填）" value={itemForm.spec} onChange={(e) => setItemForm({ ...itemForm, spec: e.target.value })} style={{ padding: 6, width: 140 }} />
        <input placeholder="單位" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} style={{ padding: 6, width: 70 }} />
        <input type="number" step="0.01" placeholder="單價（選填）" value={itemForm.unit_price} onChange={(e) => setItemForm({ ...itemForm, unit_price: e.target.value })} style={{ padding: 6, width: 100 }} />
        <input placeholder="備註" value={itemForm.note} onChange={(e) => setItemForm({ ...itemForm, note: e.target.value })} style={{ padding: 6, width: 120 }} />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '新增品項' : '送出新增申請'}
        </button>
      </form>

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>
        登記{dirs.in}／{dirs.out}
      </h2>
      <form onSubmit={handleAddTransaction} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
        <select value={txForm.itemId} onChange={(e) => setTxForm({ ...txForm, itemId: e.target.value })} style={{ padding: 6, width: 160 }} required>
          <option value="">選擇品項</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.spec ? `（${i.spec}）` : ''}
            </option>
          ))}
        </select>
        <select value={txForm.direction} onChange={(e) => setTxForm({ ...txForm, direction: e.target.value })} style={{ padding: 6 }} required>
          <option value="">動作</option>
          <option value={dirs.in}>{dirs.in}</option>
          <option value={dirs.out}>{dirs.out}</option>
          <option value="報損">報損</option>
        </select>
        <input type="number" min={1} placeholder="數量" value={txForm.quantity} onChange={(e) => setTxForm({ ...txForm, quantity: e.target.value })} style={{ padding: 6, width: 70 }} required />
        <input placeholder={category === '書庫' ? '借閱人（選填）' : '買家（選填）'} value={txForm.counterparty} onChange={(e) => setTxForm({ ...txForm, counterparty: e.target.value })} style={{ padding: 6, width: 130 }} />
        <input placeholder="備註" value={txForm.note} onChange={(e) => setTxForm({ ...txForm, note: e.target.value })} style={{ padding: 6, width: 120 }} />
        <button type="submit" style={{ padding: '6px 14px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          {canWriteDirect ? '登記' : '送出登記申請'}
        </button>
      </form>

      {perms.userId && (
        <>
          <MyPendingChangesList userId={perms.userId} tableName="general_inventory_items" />
          <MyPendingChangesList userId={perms.userId} tableName="general_inventory_transactions" />
        </>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}>品名</th>
            <th style={{ textAlign: 'left', padding: 6 }}>規格</th>
            <th style={{ textAlign: 'right', padding: 6 }}>目前庫存</th>
            <th style={{ textAlign: 'right', padding: 6 }}>單價</th>
            <th style={{ textAlign: 'left', padding: 6 }}>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} style={{ borderTop: '1px solid #eee', background: i.quantity_on_hand <= 0 ? '#FBEFE9' : undefined }}>
              <td style={{ padding: 6 }}>{i.name}</td>
              <td style={{ padding: 6 }}>{i.spec ?? '—'}</td>
              <td style={{ padding: 6, textAlign: 'right', fontWeight: i.quantity_on_hand <= 0 ? 700 : 400 }}>
                {i.quantity_on_hand} {i.unit}
                {i.quantity_on_hand <= 0 && <span style={{ marginLeft: 4, fontSize: 10, color: '#A32D2D' }}>缺貨</span>}
              </td>
              <td style={{ padding: 6, textAlign: 'right' }}>{i.unit_price != null ? i.unit_price : '—'}</td>
              <td style={{ padding: 6 }}>{i.note ?? '—'}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>
                <button onClick={() => handleDeleteItem(i.id)} style={{ fontSize: 12 }}>
                  刪除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                目前沒有品項，請先在上面新增。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
