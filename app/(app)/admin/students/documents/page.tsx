'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

type StatusChange = {
  id: string;
  status: string;
  effective_date: string;
  reason: string | null;
  attachments: { id: string; file_name: string | null; file_url: string }[];
};

// 這頁把「入學/休學/退學/畢業/肄業/復學」每一筆狀態變化，跟當時上傳的PDF放在一起顯示，
// 等於是這位學生的完整歸檔文件庫，不用另外去找檔案存在哪裡。
export default function StudentDocumentsPage() {
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState<string | null>(null);
  const [records, setRecords] = useState<StatusChange[]>([]);

  async function handleSearch() {
    const { data: student } = await supabase.from('students').select('name').eq('student_no', studentNo).maybeSingle();
    setStudentName(student?.name ?? null);

    const { data: statusRows } = await supabase
      .from('student_status_changes')
      .select('id, status, effective_date, reason')
      .eq('student_no', studentNo)
      .order('effective_date');

    const results: StatusChange[] = [];
    for (const s of statusRows ?? []) {
      const { data: attachRows } = await supabase
        .from('status_change_attachments')
        .select('id, file_name, file_url')
        .eq('status_change_id', s.id);
      results.push({ ...(s as any), attachments: attachRows ?? [] });
    }
    setRecords(results);
  }

  async function handleDownload(fileUrl: string, fileName: string | null) {
    const { data, error } = await supabase.storage.from('student-documents').createSignedUrl(fileUrl, 60);
    if (error || !data) {
      alert('無法產生下載連結：' + error?.message);
      return;
    }
    window.open(data.signedUrl, '_blank');
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 16 }}>學生歸檔文件</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input placeholder="輸入學號" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} style={{ padding: 8, flex: 1 }} />
        <button onClick={handleSearch} style={{ padding: '8px 16px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6 }}>
          查詢
        </button>
      </div>

      {studentName && <p style={{ fontSize: 14, marginBottom: 12 }}>{studentName}（學號 {studentNo}）</p>}

      {records.map((r) => (
        <div key={r.id} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 700 }}>
            {r.status}　<span style={{ fontWeight: 400, color: '#666' }}>{r.effective_date}</span>
          </p>
          {r.reason && <p style={{ fontSize: 12, color: '#666' }}>{r.reason}</p>}
          {r.attachments.length > 0 ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {r.attachments.map((a) => (
                <li key={a.id} style={{ fontSize: 13 }}>
                  <button onClick={() => handleDownload(a.file_url, a.file_name)} style={{ color: '#2C6E9E', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {a.file_name ?? '下載檔案'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 12, color: '#999' }}>（無上傳檔案）</p>
          )}
        </div>
      ))}
    </main>
  );
}
