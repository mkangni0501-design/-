'use client';

import { useRef, useState } from 'react';

export default function ExcelUploadButton({
  label = '上傳 Excel',
  onFile,
}: {
  label?: string;
  onFile: (file: File) => Promise<{ successCount: number; errors: string[]; updatedCount?: number }>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ successCount: number; errors: string[]; updatedCount?: number } | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await onFile(file);
      setResult(r);
    } catch (err: any) {
      setResult({ successCount: 0, errors: [err.message ?? '解析失敗'] });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <input ref={inputRef} type="file" accept=".xlsx" onChange={handleChange} disabled={busy} style={{ fontSize: 13 }} />
      {busy && <p style={{ fontSize: 12, color: '#666' }}>處理中，資料量大時可能要等一下…</p>}
      {result && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          <p style={{ color: '#3B6D11' }}>
            成功匯入 {result.successCount} 筆
            {!!result.updatedCount && `，並更新（修正）已存在的 ${result.updatedCount} 筆`}
          </p>
          {result.errors.length > 0 && (
            <ul style={{ color: '#A32D2D', paddingLeft: 18 }}>
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {result.errors.length > 20 && <li>…還有 {result.errors.length - 20} 筆錯誤</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
