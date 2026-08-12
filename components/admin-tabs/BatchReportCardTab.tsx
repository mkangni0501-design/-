'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ClassOption = { id: string; label: string; grade_level: string; department: string };

// 教務部門用的「多班／全校」批次列印成績單畫面。
// 導師版的「批次列印全班成績單」按鈕放在 ClassSummaryTab.tsx（見該檔案），
// 這裡是給教務部門一次選多班、或整個年級／全校的畫面。
export default function BatchReportCardTab() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('classes')
        .select('id, class_name, grade_level, department')
        .order('department')
        .order('grade_level')
        .order('class_name');
      setClasses(
        (data ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.department} ${c.grade_level}${c.class_name}`,
          grade_level: c.grade_level,
          department: c.department,
        }))
      );
      setLoading(false);
    })();
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(classes.map((c) => c.id)));
  }

  function selectGrade(gradeLevel: string) {
    setSelected(new Set(classes.filter((c) => c.grade_level === gradeLevel).map((c) => c.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleBatchPrint(classIds: string[], skipIncomplete = false) {
    if (classIds.length === 0) {
      alert('請至少選擇一個班級');
      return;
    }
    setPrinting(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const url = `/api/reports/report-card/batch${skipIncomplete ? '?skipIncomplete=true' : ''}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classIds }),
      });

      if (res.status === 409) {
        const body = await res.json();
        const names = (body.notReady ?? []).map((s: any) => `${s.studentName}(${s.reason})`).join('、');
        const confirmSkip = confirm(`以下學生尚未能產出成績單：\n${names}\n\n要跳過這些人、先列印其餘已完成的嗎？`);
        if (confirmSkip) return handleBatchPrint(classIds, true);
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error ?? '列印失敗，請稍後再試');
        return;
      }

      const skipped = res.headers.get('X-Skipped-Students');
      if (skipped) {
        const list = JSON.parse(decodeURIComponent(skipped));
        alert(`已跳過 ${list.length} 位尚未鎖定的學生：${list.map((s: any) => s.studentName).join('、')}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
    } finally {
      setPrinting(false);
    }
  }

  const gradeLevels = Array.from(new Set(classes.map((c) => c.grade_level)));

  if (loading) {
    return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
        選擇要批次列印的班級（可複選），或用下面的快速選取。還沒三項（期中/期末/平時分）都鎖定的學生不會被列入，
        列印前會先提示名單，可選擇先印其餘已完成的。
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={selectAll} style={btnStyle}>
          全校
        </button>
        {gradeLevels.map((g) => (
          <button key={g} onClick={() => selectGrade(g)} style={btnStyle}>
            {g} 全部
          </button>
        ))}
        <button onClick={clearSelection} style={{ ...btnStyle, color: '#999' }}>
          清除選取
        </button>
      </div>

      <div
        style={{
          maxHeight: 320,
          overflowY: 'auto',
          border: '1px solid #eee',
          borderRadius: 4,
          padding: 8,
          marginBottom: 16,
        }}
      >
        {classes.map((c) => (
          <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
            {c.label}
          </label>
        ))}
      </div>

      <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>已選擇 {selected.size} 個班級</p>

      <button
        onClick={() => handleBatchPrint(Array.from(selected))}
        disabled={printing || selected.size === 0}
        style={{
          padding: '8px 20px',
          background: printing ? '#ccc' : '#2C2C2A',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          fontSize: 13,
          cursor: printing ? 'default' : 'pointer',
        }}
      >
        {printing ? '產出中…' : '批次列印所選班級成績單'}
      </button>
    </div>
  );
}

const btnStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  border: '1px solid #ddd',
  borderRadius: 4,
  background: '#fafafa',
  cursor: 'pointer',
};
