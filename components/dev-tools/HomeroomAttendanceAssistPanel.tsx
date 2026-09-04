'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員區增加一勾選功能【同意由導師協助任課教師點名】，此功能
// 可開放導師把【出席】同學修正為【事假】、【病假】、【公假】」。
// 見 sql/77homeroom_attendance_assist_toggle.sql：資料庫層級導師本來就有完整寫入
// 權限，這個開關只是「學生出缺席登錄（一週）」頁面前端要不要多開放「出席→事假／
// 病假／公假」這個選項的旗標（非任教節次原本只開放「曠課→事假／病假／公假」）。
export default function HomeroomAttendanceAssistPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('homeroom_attendance_assist_settings')
        .select('allow_present_to_leave')
        .eq('id', true)
        .maybeSingle();
      if (error) {
        setError('讀取設定失敗：' + error.message);
        return;
      }
      setEnabled(data?.allow_present_to_leave ?? false);
    })();
  }, []);

  async function handleToggle() {
    if (enabled === null) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from('homeroom_attendance_assist_settings')
      .update({
        allow_present_to_leave: next,
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', true);
    setSaving(false);
    if (error) {
      setError('更新失敗：' + error.message);
      return;
    }
    setEnabled(next);
  }

  if (enabled === null && !error) return <p style={{ fontSize: 12, color: '#999' }}>載入中…</p>;

  return (
    <div>
      {error && <p style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>{error}</p>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!enabled} onChange={handleToggle} disabled={saving} />
        同意由導師協助任課教師點名
      </label>
      <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        開啟後，導師在「學生出缺席登錄（一週）」頁面，即使該節不是自己任教的科目，也可以把顯示
        「出席」的學生修正為「事假」／「病假」／「公假」（例如任課教師點名時還不知道學生已經
        請假，家長事後才告知或補請假單，由導師協助更正）。關閉時維持原本規則：非任教節次只能把
        「曠課」改成事假／病假／公假，「出席」一律唯讀，需請該科任課教師本人修改。導師對自己班級
        任教科目、以及管理員，皆不受此設定影響。
      </p>
    </div>
  );
}
