'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 對應反映事項「開發人員區增加一勾選功能【出缺席成績不含蓋在期中、期末、平時個別
// 三部分分數】」：
// 勾選時，【成績相關設定及查詢】>【班級成績總表】的期中／期末／平時三部分成績及
// 排名不會受出缺席狀態影響（全勤／出缺席這個科目從這三部分排除）——不管期中考／
// 期末考／平時分三大表有沒有送出、鎖定都一樣。【家長／學生查詢入口】歷年成績裡的
// 期中／期末／平時三欄（用的是同一套計算）也跟著不含出缺席。
// 但這個班級的「總分」／排名（成績總表本身，以及正式成績單），一律不受這個開關
// 影響，永遠繼續把出缺席3%算進去——這點跟「期中/期末/平時三部分」是分開的兩件事。
// 見 sql/68scoped_totals_restore_total_always_includes_attendance.sql（取代 sql/67
// 讓 total_score 也一起排除的錯誤行為，退回 sql/66 一開始「只排除三部分、不排除
// 總分」的設計）與 scoped_student_totals()。
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
        不會再受出缺席狀態影響（全勤／出缺席這個科目會從這三部分排除），不管期中考／期末考／
        平時分三大表有沒有送出、鎖定都一樣；家長／學生查詢入口歷年成績裡的期中／期末／平時
        三欄也是。這個班級的「總分」／排名（成績總表本身），以及正式成績單，不受這個開關影響，
        永遠繼續把出缺席算進去。
      </p>
    </div>
  );
}

