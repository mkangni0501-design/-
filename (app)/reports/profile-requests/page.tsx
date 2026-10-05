'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type RequestRow = {
  id: string;
  student_no: string;
  field_name: string;
  target_table: string;
  old_value: string | null;
  new_value: string;
  requested_at: string;
  students?: { name: string };
};

const FIELD_LABEL: Record<string, string> = { address: '現居地址', phone: '聯絡電話', name: '姓名' };

export default function ProfileRequestsPage() {
  const [requests, setRequests] = useState<RequestRow[]>([]);

  async function load() {
    const { data } = await supabase
      .from('profile_edit_requests')
      .select('id, student_no, field_name, target_table, old_value, new_value, requested_at, students(name)')
      .eq('status', '待審核')
      .order('requested_at');
    setRequests((data ?? []) as any);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDecision(requestId: string, decision: '核准' | '駁回') {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      alert('請重新登入');
      return;
    }
    const res = await fetch('/api/portal/approve-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId, decision }),
    });
    const body = await res.json();
    if (!res.ok) {
      alert(body.error ?? '處理失敗');
      return;
    }
    load();
  }

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>家長基本資料修改申請</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        核准後才會真的更新到學生資料，並會記錄核准時間；駁回則維持原本的資料不變。
      </p>

      {requests.length === 0 && <p style={{ fontSize: 13, color: '#666' }}>目前沒有待審核的申請。</p>}

      {requests.map((r) => (
        <div key={r.id} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
          <p style={{ fontSize: 13 }}>
            {r.students?.name ?? r.student_no}（學號 {r.student_no}）— {r.target_table === 'guardians' ? '監護人' : ''}
            {FIELD_LABEL[r.field_name] ?? r.field_name}
          </p>
          <p style={{ fontSize: 13, color: '#666' }}>
            原本：{r.old_value || '（空）'} → 申請改為：<b>{r.new_value}</b>
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => handleDecision(r.id, '核准')} style={{ padding: '4px 12px', background: '#3B6D11', color: '#fff', border: 'none', borderRadius: 6 }}>
              核准
            </button>
            <button onClick={() => handleDecision(r.id, '駁回')} style={{ padding: '4px 12px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 6 }}>
              駁回
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}
