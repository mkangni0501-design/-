'use client';

import { useEffect, useState } from 'react';
import { fetchMyPendingChanges, PendingChangeRow } from '@/lib/pendingChanges';

const OP_LABEL: Record<string, string> = { insert: '新增', update: '修改', delete: '刪除' };
const STATUS_COLOR: Record<string, string> = { 待審核: '#A36A00', 已核准: '#2C7A3D', 已駁回: '#A32D2D' };

/** 給 staff（部門承辦人員）看：自己在這張表送出過的申請目前處理到哪。放在表單下方即可。 */
export default function MyPendingChangesList({ userId, tableName }: { userId: string; tableName: string }) {
  const [rows, setRows] = useState<PendingChangeRow[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await fetchMyPendingChanges(userId);
      setRows(data.filter((r) => r.table_name === tableName));
    })();
  }, [userId, tableName]);

  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 12, marginBottom: 20, fontSize: 12 }}>
      <p style={{ color: '#666', marginBottom: 4 }}>我送出的申請（最近的在最上面）：</p>
      <ul style={{ paddingLeft: 18, margin: 0 }}>
        {rows.slice(0, 10).map((r) => (
          <li key={r.id} style={{ marginBottom: 2 }}>
            {new Date(r.requested_at).toLocaleString()}　{OP_LABEL[r.operation] ?? r.operation}　
            <span style={{ color: STATUS_COLOR[r.status] ?? '#666', fontWeight: 'bold' }}>{r.status}</span>
            {r.status === '已駁回' && r.review_note && <span style={{ color: '#A32D2D' }}>（原因：{r.review_note}）</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
