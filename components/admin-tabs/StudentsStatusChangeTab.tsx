'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const STATUS_OPTIONS = ['入學', '休學', '退學', '畢業', '肄業', '復學'] as const;

const TEMPLATE_FILES: Record<string, string> = {
  入學: '/templates/入學申請書.docx',
  休學: '/templates/休學申請書.docx',
  退學: '/templates/退學申請書.docx',
  畢業: '/templates/畢業離校確認書.docx',
  肄業: '/templates/肄業證明申請書.docx',
  復學: '/templates/復學申請書.docx',
};

export default function StatusChangePage() {
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState<string | null>(null);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>('休學');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [saving, setSaving] = useState(false);

  async function lookupStudent() {
    const { data } = await supabase.from('students').select('name').eq('student_no', studentNo).maybeSingle();
    setStudentName(data?.name ?? null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentName) {
      alert('請先查詢確認學號正確');
      return;
    }
    setSaving(true);

    const { data: statusRow, error } = await supabase
      .from('student_status_changes')
      .insert({ student_no: studentNo, status, effective_date: effectiveDate, reason })
      .select('id')
      .single();

    if (error || !statusRow) {
      alert('儲存失敗：' + error?.message);
      setSaving(false);
      return;
    }

    // 上傳佐證資料（若有選擇檔案）
    if (files && files.length > 0) {
      for (const file of Array.from(files)) {
        const path = `status-changes/${statusRow.id}/${file.name}`;
        const { error: uploadError } = await supabase.storage.from('student-documents').upload(path, file);
        if (uploadError) {
          alert(`檔案「${file.name}」上傳失敗：${uploadError.message}`);
          continue;
        }
        await supabase.from('status_change_attachments').insert({
          status_change_id: statusRow.id,
          file_url: path,
          file_name: file.name,
        });
      }
    }

    alert('已記錄學籍狀態變化');
    setSaving(false);
    setReason('');
    setFiles(null);
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學籍狀態變更</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        休學／退學／畢業／肄業／復學，直接記錄狀態變化即可，不需要審核流程。可附加佐證資料（例如休學證明、家長申請書掃描檔）。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          placeholder="輸入學號"
          value={studentNo}
          onChange={(e) => {
            setStudentNo(e.target.value);
            setStudentName(null);
          }}
          style={{ padding: 8, flex: 1 }}
        />
        <button type="button" onClick={lookupStudent} style={{ padding: '8px 16px' }}>
          查詢
        </button>
      </div>
      {studentName && <p style={{ fontSize: 13, marginBottom: 16 }}>學生：{studentName}</p>}

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ fontSize: 13 }}>
          狀態
          <select value={status} onChange={(e) => setStatus(e.target.value as any)} style={{ display: 'block', padding: 8, width: '100%', marginTop: 4 }}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <a href={TEMPLATE_FILES[status]} download style={{ fontSize: 13, color: '#2C6E9E' }}>
          ↓ 下載「{status}」申請書範本（Word），給家長/學生簽名後掃描成PDF再上傳
        </a>

        <label style={{ fontSize: 13 }}>
          生效日期
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            style={{ display: 'block', padding: 8, width: '100%', marginTop: 4 }}
          />
        </label>

        <label style={{ fontSize: 13 }}>
          原因（選填）
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ display: 'block', padding: 8, width: '100%', marginTop: 4 }} rows={3} />
        </label>

        <label style={{ fontSize: 13 }}>
          佐證資料上傳（例如簽名掃描後的申請書PDF，選填，可多選）
          <input type="file" multiple accept="application/pdf" onChange={(e) => setFiles(e.target.files)} style={{ display: 'block', marginTop: 4 }} />
        </label>

        <button
          type="submit"
          disabled={saving}
          style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8, marginTop: 8 }}
        >
          {saving ? '儲存中…' : '儲存'}
        </button>
      </form>
    </div>
  );
}
