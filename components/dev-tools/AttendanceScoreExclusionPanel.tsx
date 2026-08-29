'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員區增加一勾選功能【出缺席成績不含蓋在期中、期末、平時個別
// 三部分分數】」：
// 勾選時，【成績相關設定及查詢】>【班級成績總表】的期中／期末／平時三部分的成績
// 不會受出缺席狀態影響分數及排名（等於把「全勤／出缺席」這個科目暫時排除在這
// 三欄之外）；但三大表（期中考／期末考／平時分）完成並鎖定以後，總成績及成績單
// 依然會顯示、統計包含出缺席的真實成績——這個開關只影響「期中/期末/平時個別
// 三欄」的顯示與排名，不影響總成績（見 sql/66attendance_excluded_from_partial_scores_toggle.sql、
// scoped_student_totals()）。
export default function AttendanceScoreExclusionPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('attendance_score_display_settings')
        .select('exclude_attendance_from_partial_scores')
        .eq('id', true)
        .maybeSingle();
      if (error) {
        setError('讀取設定失敗：' + error.message);
        return;
      }
      setEnabled(data?.exclude_attendance_from_partial_scores ?? false);
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
      .from('attendance_score_display_settings')
      .update({
        exclude_attendance_from_partial_scores: next,
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
        出缺席成績不含蓋在期中、期末、平時個別三部分分數
      </label>
      <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        開啟後，【成績相關設定及查詢】{'>'} 【班級成績總表】的期中／期末／平時三部分成績及排名，
        不會再受出缺席狀態影響（全勤／出缺席這個科目會從這三欄暫時排除）。但三大表（期中考／
        期末考／平時分）完成並鎖定以後，總成績及成績單仍然會顯示、統計包含出缺席的真實成績，
        不受這個開關影響。
      </p>
    </div>
  );
}
