'use client';

import { useEffect, useState } from 'react';
import {
  fetchPendingChanges,
  reviewPendingChange,
  PendingChangeRow,
} from '@/lib/pendingChanges';
import { AdminDepartment, DEPARTMENT_LABEL } from '@/lib/departments';

const OP_LABEL: Record<string, string> = { insert: '新增', update: '修改', delete: '刪除' };

/**
 * 給部門主管(lead)／系統管理員S 用的送審核准清單。
 * 放在各受管資料表的頁面最上方（只有 lead 或 S 看得到），或掛在獨立頁面都可以。
 */
export default function PendingChangesReviewPanel({
  department,
  reviewerId,
  canReview,
  onReviewed,
}: {
  department: AdminDepartment;
  reviewerId: string;
  canReview: boolean;
  onReviewed?: () => void;
}) {
  const [rows, setRows] = useState<PendingChangeRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    const { data, error } = await fetchPendingChanges(department, showHistory ? undefined : '待審核');
    setRows(data);
    setLoadError(error);
  }

  useEffect(() => {
    if (!canReview) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReview, showHistory]);

  if (!canReview) return null;

  async function handleReview(id: string, approve: boolean) {
    setBusyId(id);
    try {
      const { error } = await reviewPendingChange(id, approve, noteDraft[id] ?? '', reviewerId);
      if (error) {
        alert((approve ? '核准' : '駁回') + '失敗：' + error);
        return;
      }
      await load();
      onReviewed?.();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section style={{ marginBottom: 24, padding: 12, background: '#F7F5F0', border: '1px solid #E5E1D8', borderRadius: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>
          {DEPARTMENT_LABEL[department]}部門送審清單{showHistory ? '（含已處理）' : '（待審核）'}
        </h2>
        <button onClick={() => setShowHistory((s) => !s)} style={{ fontSize: 12, padding: '2px 8px' }}>
          {showHistory ? '只看待審核' : '查看全部歷史'}
        </button>
      </div>
      {loadError && <p style={{ color: '#A32D2D', fontSize: 12 }}>{loadError}</p>}
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: '#999' }}>目前沒有待審核的申請。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 4 }}>送出時間</th>
              <th style={{ textAlign: 'left', padding: 4 }}>資料表</th>
              <th style={{ textAlign: 'left', padding: 4 }}>動作</th>
              <th style={{ textAlign: 'left', padding: 4 }}>內容</th>
              <th style={{ textAlign: 'left', padding: 4 }}>狀態</th>
              <th style={{ textAlign: 'left', padding: 4 }}>備註/處理</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #ddd' }}>
                <td style={{ padding: 4 }}>{new Date(r.requested_at).toLocaleString()}</td>
                <td style={{ padding: 4 }}>{r.table_name}</td>
                <td style={{ padding: 4 }}>{OP_LABEL[r.operation] ?? r.operation}</td>
                <td style={{ padding: 4, maxWidth: 260, overflowWrap: 'break-word' }}>
                  <code style={{ fontSize: 11 }}>{JSON.stringify(r.payload)}</code>
                </td>
                <td style={{ padding: 4 }}>{r.status}</td>
                <td style={{ padding: 4 }}>
                  {r.status === '待審核' ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        placeholder="備註（選填）"
                        value={noteDraft[r.id] ?? ''}
                        onChange={(e) => setNoteDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        style={{ fontSize: 11, padding: 2, width: 100 }}
                      />
                      <button disabled={busyId === r.id} onClick={() => handleReview(r.id, true)} style={{ fontSize: 11, padding: '2px 6px' }}>
                        核准
                      </button>
                      <button disabled={busyId === r.id} onClick={() => handleReview(r.id, false)} style={{ fontSize: 11, padding: '2px 6px', color: '#A32D2D' }}>
                        駁回
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: '#999' }}>{r.review_note || '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
