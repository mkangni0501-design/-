'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { downloadMultiClassScoreExcel, type ClassScoreExcelParams } from '@/lib/excelTemplates';

type ClassOption = { id: string; label: string; grade_level: string; department: string };

// 教務部門用的「多班／全校」批次列印成績單畫面。
// 導師版的「批次列印全班成績單」按鈕放在 ClassSummaryTab.tsx（見該檔案），
// 這裡是給教務部門一次選多班、或整個年級／全校的畫面。
export default function BatchReportCardTab() {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);

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

  // 對應反映事項「增加批次列印各班成績表(總分、期中、期末、平時)，現在只能一個班
  // 一個班按」——這裡是「班級成績表 Excel」（不是成績單PDF），一次選好幾個班，
  // 每個班變成活頁簿裡的一個分頁，一次下載一個檔案；資料查詢邏輯照抄
  // ClassSummaryTab.tsx 單一班級版本，只是外面多包一層「每個選到的班都跑一次」。
  async function handleBatchExportExcel(classIds: string[]) {
    if (classIds.length === 0) {
      alert('請至少選擇一個班級');
      return;
    }
    setExportingExcel(true);
    try {
      const sheets: (ClassScoreExcelParams & { sheetName: string })[] = [];
      for (const classId of classIds) {
        const classInfo = classes.find((c) => c.id === classId);
        const { data: enrollRows } = await supabase
          .from('enrollments')
          .select('id, seat_no, student_no, term, students(name)')
          .eq('class_id', classId)
          .order('seat_no');
        if (!enrollRows || enrollRows.length === 0) continue;
        const term = (enrollRows[0] as any).term;
        const enrollIds = enrollRows.map((e: any) => e.id);

        const { data: classRow } = await supabase.from('classes').select('academic_year, grade_level, class_name').eq('id', classId).maybeSingle();

        const { data: subjectRows } = await supabase
          .from('subject_weighted_scores')
          .select('enrollment_id, subject, midterm, final, daily')
          .in('enrollment_id', enrollIds);
        const subjSet = new Set<string>();
        const subjMap: Record<string, Record<string, { midterm: number | null; final: number | null; daily: number | null }>> = {};
        (subjectRows ?? []).forEach((r: any) => {
          subjSet.add(r.subject);
          subjMap[r.enrollment_id] = subjMap[r.enrollment_id] ?? {};
          subjMap[r.enrollment_id][r.subject] = r;
        });

        const { data: curriculumRows } = await supabase
          .from('curriculum')
          .select('subject, weight')
          .eq('academic_year', classRow?.academic_year)
          .eq('term', term)
          .eq('grade_level', classRow?.grade_level);
        const weightMap: Record<string, number> = {};
        (curriculumRows ?? []).forEach((r: any) => (weightMap[r.subject] = Number(r.weight)));
        const sortedSubjects = Array.from(subjSet)
          .filter((s) => weightMap[s] !== 0)
          .sort((a, b) => (weightMap[b] ?? -1) - (weightMap[a] ?? -1));

        const { data: rankRows } = await supabase.rpc('class_rankings_for_class', { p_class_id: classId, p_term: term });
        const classRank: ClassScoreExcelParams['classRank'] = {};
        (rankRows ?? []).forEach((r: any) => (classRank[r.enrollment_id] = r));

        const { data: gradeRows } = await supabase.rpc('grade_rankings_for_class', { p_class_id: classId, p_term: term });
        const gradeRank: ClassScoreExcelParams['gradeRank'] = {};
        (gradeRows ?? []).forEach((r: any) => (gradeRank[r.enrollment_id] = r));

        const { data: attRows } = await supabase.rpc('class_attendance_adjustment_batch', { p_class_id: classId, p_term: term });
        const attendanceAdjustments: Record<string, number> = {};
        (attRows ?? []).forEach((r: any) => (attendanceAdjustments[r.enrollment_id] = Number(r.attendance_score)));

        sheets.push({
          className: classInfo?.label ?? '班級',
          sheetName: classInfo?.label ?? classId,
          academicYear: classRow?.academic_year ?? '',
          term: term ?? '',
          viewMode: 'all',
          subjects: sortedSubjects,
          examTypes: ['期中考', '期末考', '平時分'],
          students: enrollRows.map((e: any) => ({ enrollment_id: e.id, seat_no: e.seat_no, name: e.students?.name ?? e.student_no })),
          subjectScores: subjMap,
          attendanceAdjustments,
          classRank,
          gradeRank,
        });
      }
      if (sheets.length === 0) {
        alert('選取的班級都沒有查到學生資料');
        return;
      }
      await downloadMultiClassScoreExcel(sheets);
    } catch (err: any) {
      alert('匯出失敗：' + (err?.message ?? String(err)));
    } finally {
      setExportingExcel(false);
    }
  }

  async function handleBatchPrint(classIds: string[], skipIncomplete = false, format: 'pdf' | 'docx' = 'pdf') {
    if (classIds.length === 0) {
      alert('請至少選擇一個班級');
      return;
    }
    // 【2026-08-19 修正】「按了沒反應」的根因：window.open() 原本寫在 fetch/blob 轉換
    // 之後（await 過網路請求才呼叫），瀏覽器的彈出視窗封鎖機制只認「使用者點擊當下、
    // 還沒有任何 await 的那個瞬間」算是「使用者主動開新分頁」，一旦中間經過 await
    // （批次列印通常要等比較久，好幾個班級一起產生PDF），瀏覽器就會把之後的
    // window.open() 當成「網頁自己偷開視窗」直接靜靜擋掉，不會跳出任何錯誤訊息，
    // 畫面上就是「按了沒反應」。改成「點擊當下先同步開一個空白分頁」，等 PDF 真的
    // 產生好了，再把那個已經開好的分頁導向到 PDF 內容，就不會被封鎖。
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('瀏覽器擋下了新分頁（彈出視窗封鎖），請到瀏覽器網址列允許本網站開啟彈出視窗後再試一次。');
      return;
    }
    printWindow.document.write(`<p style="font-family:sans-serif;padding:24px">正在產生成績單${format === 'docx' ? '（Word 合併列印）' : ' PDF'}，請稍候…（多個班級一起列印可能需要一些時間）</p>`);
    setPrinting(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const params = new URLSearchParams();
      if (skipIncomplete) params.set('skipIncomplete', 'true');
      if (format === 'docx') params.set('format', 'docx');
      const url = `/api/reports/report-card/batch${params.toString() ? '?' + params.toString() : ''}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classIds }),
      });

      if (res.status === 409) {
        printWindow.close();
        const body = await res.json();
        const names = (body.notReady ?? []).map((s: any) => `${s.studentName}(${s.reason})`).join('、');
        const confirmSkip = confirm(`以下學生尚未能產出成績單：\n${names}\n\n要跳過這些人、先列印其餘已完成的嗎？`);
        if (confirmSkip) return handleBatchPrint(classIds, true, format);
        return;
      }

      if (!res.ok) {
        printWindow.close();
        const body = await res.json().catch(() => ({}));
        alert(`列印失敗，狀態碼 ${res.status}${body.error ? '：' + body.error : ''}，請稍後再試`);
        return;
      }

      const skipped = res.headers.get('X-Skipped-Students');
      if (skipped) {
        const list = JSON.parse(decodeURIComponent(skipped));
        alert(`已跳過 ${list.length} 位尚未鎖定的學生：${list.map((s: any) => s.studentName).join('、')}`);
      }

      const blob = await res.blob();
      if (format === 'docx') {
        printWindow.close();
        const a = document.createElement('a');
        const dUrl = URL.createObjectURL(blob);
        a.href = dUrl;
        a.download = 'report-cards-batch.docx';
        a.click();
        URL.revokeObjectURL(dUrl);
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      printWindow.location.href = blobUrl;
    } catch (err: any) {
      printWindow.close();
      alert('批次列印發生錯誤：' + (err?.message ?? String(err)));
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
        {printing ? '產出中…' : '批次列印所選班級成績單（個人成績單PDF）'}
      </button>

      <button
        onClick={() => handleBatchPrint(Array.from(selected), false, 'docx')}
        disabled={printing || selected.size === 0}
        style={{
          marginLeft: 8,
          padding: '8px 20px',
          background: printing ? '#ccc' : '#2C6E9E',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          fontSize: 13,
          cursor: printing ? 'default' : 'pointer',
        }}
      >
        {printing ? '產出中…' : '批次列印所選班級成績單（Word 合併列印）'}
      </button>

      <button
        onClick={() => handleBatchExportExcel(Array.from(selected))}
        disabled={exportingExcel || selected.size === 0}
        style={{
          marginLeft: 8,
          padding: '8px 20px',
          background: exportingExcel ? '#ccc' : '#6B5B3A',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          fontSize: 13,
          cursor: exportingExcel ? 'default' : 'pointer',
        }}
      >
        {exportingExcel ? '匯出中…' : '📊 批次下載班級成績表（Excel，總分/期中/期末/平時）'}
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
