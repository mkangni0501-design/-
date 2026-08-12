'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import { downloadStudentsImportTemplate } from '@/lib/excelTemplates';
import { fetchCurrentStudentsSheet } from '@/lib/currentDataSheets';
import { uploadStudentsImportSheet, upsertEnrollment } from '@/lib/bulkHandlers';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = { id: string; label: string };
type EnrolledStudent = {
  id: string;
  student_no: string;
  seat_no: number | null;
  term: string;
  name: string;
  classLabel: string;
};

const emptyForm = { student_no: '', name: '', gender: '', class_id: '', seat_no: '', term: '上學期' };

// 精簡版：既有學生（轉學生、舊系統匯入）快速建檔，只填必要欄位。
// 直接寫入現有的 students / enrollments 表，跟完整版新生註冊共用同一份資料，不會產生重複資料。
export default function ImportStudentPage() {
  const [form, setForm] = useState(emptyForm);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [students, setStudents] = useState<EnrolledStudent[]>([]);
  const [filterClassId, setFilterClassId] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [armedAction, setArmedAction] = useState<'delete' | 'fullDelete' | 'edit' | null>(null);
  const [batchClassId, setBatchClassId] = useState('');
  const [batchSeatNo, setBatchSeatNo] = useState('');

  // 「下載既有學生快速建檔範本」原本永遠下載空白範本（只有2列示範資料），
  // 就算系統裡已經有學生資料，下載出來的還是看不出目前現況、要重新對照著填。
  // 改成：先查「這個學年度/學期目前的在學學生」，有資料就直接下載現況（可以直接拿來對照/修改後重新上傳），
  // 沒有資料（全新系統，或年度/學期真的還沒有學生）才退回原本的範本，維持格式教學的功能。
  const [downloadYear, setDownloadYear] = useState<number>(new Date().getFullYear());
  const [downloadTerm, setDownloadTerm] = useState<'上學期' | '下學期'>('上學期');
  const [downloading, setDownloading] = useState(false);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === students.length ? new Set() : new Set(students.map((s) => s.id))));
  }

  async function loadClasses() {
    const { data } = await supabase.from('classes').select('id, academic_year, department, grade_level, class_name');
    setClasses(
      (data ?? []).map((c: any) => ({
        id: c.id,
        label: `${c.academic_year} ${c.department} ${c.grade_level}${c.class_name}`,
      }))
    );
  }

  async function loadStudents() {
    // 注意：這裡刻意不用 students(name)/classes(...) 這種自動關聯embed查詢——在這個資料庫上這類查詢會不穩定、
    // 整批失敗又不一定會回報明確錯誤，導致學生名單完全出不來。改成分開查、用 Map 手動兜資料
    // （跟「學生成績登錄」「學生出缺席登錄」頁的作法一致）。
    let query = supabase
      .from('enrollments')
      .select('id, student_no, seat_no, term, class_id')
      .eq('is_current', true)
      .order('seat_no');
    if (filterClassId) query = query.eq('class_id', filterClassId);
    const { data: enrollRows, error: enrollErr } = await query;
    if (enrollErr) {
      setLoadError('讀取學生名冊失敗：' + enrollErr.message);
      setStudents([]);
      return;
    }

    const studentNos = (enrollRows ?? []).map((r: any) => r.student_no);
    const { data: studentRows, error: studentErr } = await supabase
      .from('students')
      .select('student_no, name')
      .in('student_no', studentNos.length > 0 ? studentNos : ['__none__']);
    if (studentErr) {
      setLoadError('讀取學生姓名失敗：' + studentErr.message);
      return;
    }
    const nameByStudentNo = new Map((studentRows ?? []).map((s: any) => [s.student_no, s.name]));

    const classIds = Array.from(new Set((enrollRows ?? []).map((r: any) => r.class_id)));
    const { data: classRows, error: classErr } = await supabase
      .from('classes')
      .select('id, academic_year, department, grade_level, class_name')
      .in('id', classIds.length > 0 ? classIds : ['__none__']);
    if (classErr) {
      setLoadError('讀取班級資料失敗：' + classErr.message);
      return;
    }
    const classLabelById = new Map(
      (classRows ?? []).map((c: any) => [c.id, `${c.academic_year} ${c.grade_level}${c.class_name}`])
    );

    setLoadError(null);
    setStudents(
      (enrollRows ?? []).map((r: any) => ({
        id: r.id,
        student_no: r.student_no,
        seat_no: r.seat_no,
        term: r.term,
        name: nameByStudentNo.get(r.student_no) ?? '（找不到姓名）',
        classLabel: classLabelById.get(r.class_id) ?? '—',
      }))
    );
  }

  async function handleBatchDelete() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    // 「刪除」指移除這筆學籍（enrollments），不會動到學生本人的基本資料，
    // 避免其他學期/班級的歷史紀錄跟著壞掉；學生本人資料要刪除請用「完全刪除」。
    // 這筆學籍底下如果已經有成績／導師評語，資料庫的外鍵限制會擋住 enrollments 的刪除
    // （刪不掉、也不會有清楚的錯誤訊息，看起來就像「刪除功能沒用」），所以要先清掉這些關聯資料。
    const { error: scoreErr } = await supabase.from('scores').delete().in('enrollment_id', ids);
    if (scoreErr) {
      alert('批次刪除失敗（清除關聯成績時發生錯誤）：' + scoreErr.message);
      return;
    }
    const { error: remarkErr } = await supabase.from('student_remarks').delete().in('enrollment_id', ids);
    if (remarkErr) {
      alert('批次刪除失敗（清除關聯導師評語時發生錯誤）：' + remarkErr.message);
      return;
    }
    const { error } = await supabase.from('enrollments').delete().in('id', ids);
    setArmedAction(null);
    if (error) {
      alert('批次刪除失敗：' + error.message);
      return;
    }
    setSelected(new Set());
    loadStudents();
  }

  // 「完全刪除」：連學生本人的基本資料（students 表）都一起刪掉，專門處理「打錯字建了一筆根本不存在
  // 的學生」這種狀況。為了不小心刪掉真正有歷史紀錄的學生，這裡會先逐一檢查：
  // 這個學號除了這次選取的學籍之外還有沒有其他學籍／出缺勤／獎懲紀錄，只要「乾淨」的學號才會真的
  // 連 students 都刪掉；有殘留資料的學號只會刪掉學籍（跟批次刪除一樣），並且會列出來讓你知道為什麼。
  async function handleFullyDelete() {
    if (selected.size === 0) return;
    const selectedRows = students.filter((s) => selected.has(s.id));
    const studentNos = Array.from(new Set(selectedRows.map((s) => s.student_no)));

    const { data: allEnrollForNos, error: enrollCheckErr } = await supabase
      .from('enrollments')
      .select('id, student_no')
      .in('student_no', studentNos);
    if (enrollCheckErr) {
      alert('完全刪除失敗（檢查學籍時發生錯誤）：' + enrollCheckErr.message);
      return;
    }
    const { data: attendanceForNos, error: attErr } = await supabase.from('attendance').select('student_no').in('student_no', studentNos);
    if (attErr) {
      alert('完全刪除失敗（檢查出缺勤時發生錯誤）：' + attErr.message);
      return;
    }
    const { data: conductForNos, error: conductErr } = await supabase.from('conduct_events').select('student_no').in('student_no', studentNos);
    if (conductErr) {
      alert('完全刪除失敗（檢查獎懲紀錄時發生錯誤）：' + conductErr.message);
      return;
    }
    const attendanceNos = new Set((attendanceForNos ?? []).map((a: any) => a.student_no));
    const conductNos = new Set((conductForNos ?? []).map((c: any) => c.student_no));
    const enrollCountByNo = new Map<string, number>();
    (allEnrollForNos ?? []).forEach((e: any) => enrollCountByNo.set(e.student_no, (enrollCountByNo.get(e.student_no) ?? 0) + 1));
    const selectedCountByNo = new Map<string, number>();
    selectedRows.forEach((s) => selectedCountByNo.set(s.student_no, (selectedCountByNo.get(s.student_no) ?? 0) + 1));

    const cleanNos = studentNos.filter(
      (no) => (enrollCountByNo.get(no) ?? 0) === (selectedCountByNo.get(no) ?? 0) && !attendanceNos.has(no) && !conductNos.has(no)
    );
    const skippedNos = studentNos.filter((no) => !cleanNos.includes(no));

    const ids = selectedRows.map((s) => s.id);
    const { error: scoreErr } = await supabase.from('scores').delete().in('enrollment_id', ids);
    if (scoreErr) {
      alert('完全刪除失敗（清除關聯成績時發生錯誤）：' + scoreErr.message);
      return;
    }
    const { error: remarkErr } = await supabase.from('student_remarks').delete().in('enrollment_id', ids);
    if (remarkErr) {
      alert('完全刪除失敗（清除關聯導師評語時發生錯誤）：' + remarkErr.message);
      return;
    }
    const { error: enrollErr } = await supabase.from('enrollments').delete().in('id', ids);
    if (enrollErr) {
      alert('完全刪除失敗（刪除學籍時發生錯誤）：' + enrollErr.message);
      return;
    }
    if (cleanNos.length > 0) {
      const { error: studentErr } = await supabase.from('students').delete().in('student_no', cleanNos);
      if (studentErr) {
        alert('學籍已刪除，但刪除學生本人資料時發生錯誤：' + studentErr.message);
      }
    }
    setArmedAction(null);
    setSelected(new Set());
    loadStudents();
    if (skippedNos.length > 0) {
      alert(
        `已完全刪除 ${cleanNos.length} 位。另外 ${skippedNos.length} 位（學號：${skippedNos.join('、')}）` +
        '因為還有其他學籍／出缺勤／獎懲紀錄，為了不誤刪歷史資料，只移除了這次選到的學籍，學生本人資料保留。'
      );
    }
  }

  async function handleBatchEdit() {
    if (selected.size === 0) return;
    const patch: Record<string, any> = {};
    if (batchClassId) patch.class_id = batchClassId;
    if (batchSeatNo) patch.seat_no = Number(batchSeatNo);
    if (Object.keys(patch).length === 0) {
      alert('請至少選擇要修改的班級或填寫座號');
      return;
    }
    const { error } = await supabase.from('enrollments').update(patch).in('id', Array.from(selected));
    setArmedAction(null);
    if (error) {
      alert('批次修改失敗：' + error.message + '（座號在同一班級同一學期不能重複）');
      return;
    }
    setSelected(new Set());
    setBatchClassId('');
    setBatchSeatNo('');
    loadStudents();
  }

  useEffect(() => {
    loadClasses();
    (async () => {
      const { data } = await supabase.rpc('current_academic_term');
      const term = Array.isArray(data) ? data[0] : data;
      if (term) {
        setDownloadYear(term.academic_year);
        setDownloadTerm(term.term);
      }
    })();
  }, []);

  async function handleDownloadCurrentOrTemplate() {
    setDownloading(true);
    try {
      const sheet = await fetchCurrentStudentsSheet(downloadYear, downloadTerm);
      const hasData = sheet.aoa.length > 1 && sheet.aoa[0]?.[0] === '學年度';
      if (!hasData) {
        // 查不到現況資料（或讀取失敗）：退回原本的空白範本，至少讓使用者看得懂格式
        await downloadStudentsImportTemplate();
        return;
      }
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.name);
      XLSX.writeFile(wb, `既有學生名冊_${downloadYear}_${downloadTerm}.xlsx`);
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    loadStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterClassId]);

  // 解析「既有學生快速建檔（精簡版）」格式：
  // 年度,學期,年級,班級,學號,姓名,座號,導師評語,曠課...大過,操行
  // 出缺勤次數/操行等彙總欄位不會匯入（跟granular的出缺勤紀錄格式不同，只用來建立學籍名冊本身）。
  async function handleUploadFile(file: File) {
    const buf = await file.arrayBuffer();
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames.includes('既有學生快速建檔（精簡版）') ? '既有學生快速建檔（精簡版）' : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rowsRaw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    const result = await uploadStudentsImportSheet(rowsRaw);
    loadClasses();
    loadStudents();
    return result;
  }


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // 學生不存在才新增，已存在（例如同校轉班）就直接沿用
    const { data: existing } = await supabase.from('students').select('student_no').eq('student_no', form.student_no).maybeSingle();
    if (!existing) {
      const { error: studentError } = await supabase.from('students').insert({
        student_no: form.student_no,
        name: form.name,
        gender: form.gender || null,
      });
      if (studentError) {
        alert('建立學生資料失敗：' + studentError.message);
        return;
      }
    }

    // 若該學號原本就有現行學籍（例如轉學生從其他班轉入），先標記為非現行，避免同時有兩筆現行紀錄
    try {
      await upsertEnrollment(form.student_no, form.class_id, form.term, Number(form.seat_no));
    } catch (enrollError: any) {
      alert('建立學籍失敗：' + enrollError.message);
      return;
    }

    alert('已完成建檔／編班');
    setForm({ ...emptyForm, class_id: form.class_id, term: form.term });
    loadStudents();
  }

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>既有學生快速建檔（精簡版）</h1>
      <ErrorBanner message={loadError} />
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        給轉學生或舊資料匯入使用，只填必要欄位。若要登記完整入學資料（家庭資料、原校資料等），請改用「新生入學登記」。
      </p>

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>批次上傳（格式同「既有學生快速建檔（精簡版）」工作表）</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input
          type="number"
          value={downloadYear}
          onChange={(e) => setDownloadYear(Number(e.target.value))}
          style={{ width: 90, padding: 6 }}
        />
        <select value={downloadTerm} onChange={(e) => setDownloadTerm(e.target.value as '上學期' | '下學期')} style={{ padding: 6 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
      </div>
      <TemplateDownloadButton
        label={downloading ? '準備中…' : '下載學生名冊（有現況資料就下載現況，沒有才用範本）'}
        onClick={handleDownloadCurrentOrTemplate}
      />
      <ExcelUploadButton onFile={handleUploadFile} />

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>手動新增單一學生</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input placeholder="學號" value={form.student_no} onChange={(e) => setForm({ ...form, student_no: e.target.value })} style={{ padding: 8 }} required />
        <input placeholder="姓名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ padding: 8 }} required />
        <input placeholder="性別（選填）" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} style={{ padding: 8 }} />
        <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })} style={{ padding: 8 }} required>
          <option value="">選擇編入班級</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} style={{ padding: 8 }}>
          <option value="上學期">上學期</option>
          <option value="下學期">下學期</option>
        </select>
        <input
          type="number"
          placeholder="座號"
          value={form.seat_no}
          onChange={(e) => setForm({ ...form, seat_no: e.target.value })}
          style={{ padding: 8 }}
          required
        />
        <button type="submit" style={{ padding: 12, background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 8 }}>
          建檔並編班
        </button>
      </form>

      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 8, marginTop: 24 }}>目前已建檔學生（確認上傳/新增結果）</h2>
      <select value={filterClassId} onChange={(e) => setFilterClassId(e.target.value)} style={{ padding: 6, marginBottom: 10, width: '100%' }}>
        <option value="">全部班級</option>
        {classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
          <span style={{ fontSize: 12, color: '#666' }}>已選取 {selected.size} 筆</span>
          {armedAction === null && (
            <>
              <select value={batchClassId} onChange={(e) => setBatchClassId(e.target.value)} style={{ padding: 4, fontSize: 12 }}>
                <option value="">（不改班級）</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    改到：{c.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="改座號"
                value={batchSeatNo}
                onChange={(e) => setBatchSeatNo(e.target.value)}
                style={{ width: 80, padding: 4, fontSize: 12 }}
              />
              <button onClick={() => setArmedAction('edit')} style={{ fontSize: 12, padding: '4px 10px' }}>
                批次修改
              </button>
              <button onClick={() => setArmedAction('delete')} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                批次刪除學籍
              </button>
              <button onClick={() => setArmedAction('fullDelete')} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D', fontWeight: 600 }}>
                完全刪除（含學生資料）
              </button>
              <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消選取
              </button>
            </>
          )}
          {armedAction === 'edit' && (
            <>
              <span style={{ fontSize: 12 }}>
                確定要把這 {selected.size} 筆
                {batchClassId ? `改到「${classes.find((c) => c.id === batchClassId)?.label}」` : ''}
                {batchSeatNo ? `、座號改成 ${batchSeatNo}` : ''}
                嗎？
              </span>
              <button onClick={handleBatchEdit} style={{ fontSize: 12, padding: '4px 10px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
          {armedAction === 'delete' && (
            <>
              <span style={{ fontSize: 12, color: '#A32D2D' }}>
                確定要刪除這 {selected.size} 筆學籍嗎？只會移除這筆「班級／學期」的名冊資料（連同這筆學籍下的成績／導師評語），
                不會刪除學生本人的基本資料。此動作無法復原。
              </span>
              <button onClick={handleBatchDelete} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定刪除
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
          {armedAction === 'fullDelete' && (
            <>
              <span style={{ fontSize: 12, color: '#A32D2D' }}>
                確定要完全刪除這 {selected.size} 筆嗎？學號如果沒有其他學籍／出缺勤／獎懲紀錄，會連學生本人資料都一併刪除
                （適合用來清掉打錯字建立的學生）；如果還有其他紀錄，系統會為了保護歷史資料，只刪除學籍、保留學生本人資料，並告訴你是哪幾位。此動作無法復原。
              </span>
              <button onClick={handleFullyDelete} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                確定完全刪除
              </button>
              <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                取消
              </button>
            </>
          )}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ padding: 6 }}>
              <input type="checkbox" checked={students.length > 0 && selected.size === students.length} onChange={toggleSelectAll} />
            </th>
            <th style={{ textAlign: 'left', padding: 6 }}>學號</th>
            <th style={{ textAlign: 'left', padding: 6 }}>姓名</th>
            <th style={{ textAlign: 'left', padding: 6 }}>班級</th>
            <th style={{ textAlign: 'right', padding: 6 }}>座號</th>
            <th style={{ textAlign: 'left', padding: 6 }}>學期</th>
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} />
              </td>
              <td style={{ padding: 6 }}>{s.student_no}</td>
              <td style={{ padding: 6 }}>{s.name}</td>
              <td style={{ padding: 6 }}>{s.classLabel}</td>
              <td style={{ padding: 6, textAlign: 'right' }}>{s.seat_no ?? '—'}</td>
              <td style={{ padding: 6 }}>{s.term}</td>
            </tr>
          ))}
          {students.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                目前沒有資料。若剛上傳完看到這裡是空的，代表上傳很可能沒有實際寫入成功，請往上看批次上傳結果訊息裡有沒有錯誤。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
