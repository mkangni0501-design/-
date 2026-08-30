'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員區增加一勾選功能【出缺席成績不含蓋在期中、期末、平時個別
// 三部分分數】」：
// 勾選時，【成績相關設定及查詢】>【班級成績總表】這個頁面（期中／期末／平時三部分
// ＋它自己的總分／排名）都不會受出缺席狀態影響——不管期中考／期末考／平時分三大表
// 有沒有送出、鎖定都一樣。【家長／學生查詢入口】的歷年成績（用的是同一套排名計算）
// 也跟著不含出缺席。
// 唯一不受這個開關影響、永遠顯示「含出缺席真實成績」的，是正式的成績單（列印/下載
// 的那份文件）——那是完全獨立的另一套計算，這裡的開關動不到它。
// 見 sql/67scoped_totals_exclude_attendance_correction.sql（取代 sql/66 讓「總分」
// 一律含出缺席的舊行為）與 scoped_student_totals()。
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
        開啟後，【成績相關設定及查詢】{'>'} 【班級成績總表】的期中／期末／平時三部分成績及排名、
        以及它自己的總分／排名，都不會再受出缺席狀態影響（全勤／出缺席這個科目會從這裡的計算中
        排除），不管期中考／期末考／平時分三大表有沒有送出、鎖定都一樣；家長／學生查詢入口的
        歷年成績也是。唯一不受影響、永遠顯示含出缺席真實成績的，是正式的成績單。
      </p>
    </div>
  );
}

