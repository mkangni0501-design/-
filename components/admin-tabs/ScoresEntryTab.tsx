'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase, getCurrentAppUser, isAdminInCurrentView } from '@/lib/supabaseClient';
import { useIsMobile } from '@/lib/useIsMobile';
import { getSiteContentMap } from '@/lib/siteContent';
import { departmentForGrade } from '@/lib/gradeMapping';
import { readWorkbook, parseSheetHeader, parseStudentRows, findScoreBlocks } from '@/lib/scoreAttendanceSheetParser';
import ExcelUploadButton from '@/components/ExcelUploadButton';
import TemplateDownloadButton from '@/components/TemplateDownloadButton';
import { downloadScoreAttendanceTemplate } from '@/lib/excelTemplates';
import ErrorBanner from '@/components/ErrorBanner';

type ClassOption = { id: string; label: string; academic_year: number; grade_level: string };
type StudentScoreRow = { enrollment_id: string; seat_no: number; name: string; score: string };

const EXAM_TYPES = ['期中考', '期末考', '平時分'] as const;
const CUSTOM_SUBJECT_VALUE = '__custom__';

export default function ScoreEntryPage() {
  const isMobile = useIsMobile();
  const [siteContent, setSiteContent] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [homeroomClassId, setHomeroomClassId] = useState<string | null>(null);
  const [ownSubjectsByClass, setOwnSubjectsByClass] = useState<Record<string, string[]>>({});
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);

  const [classId, setClassId] = useState('');
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const [examType, setExamType] = useState<(typeof EXAM_TYPES)[number] | ''>('');

  const [rows, setRows] = useState<StudentScoreRow[]>([]);
  const [locked, setLocked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [armedAction, setArmedAction] = useState<'delete' | 'edit' | null>(null);
  const [batchScoreValue, setBatchScoreValue] = useState('');
  const [showEntered, setShowEntered] = useState(false);

  // 用來記錄每一列分數輸入框的 DOM 元素，讓按 ENTER 可以跳到下一位學生。
  const scoreInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  function focusNextScoreInput(currentEnrollmentId: string) {
    const idx = rows.findIndex((r) => r.enrollment_id === currentEnrollmentId);
    if (idx === -1) return;
    for (let i = idx + 1; i < rows.length; i++) {
      const el = scoreInputRefs.current[rows[i].enrollment_id];
      if (el) {
        el.focus();
        el.select();
        return;
      }
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.enrollment_id))));
  }

  const canPickAnySubject = isAdmin;
  const effectiveSubject = subject === CUSTOM_SUBJECT_VALUE ? customSubject.trim() : subject;
  const classLabel = classOptions.find((c) => c.id === classId)?.label ?? '';

  // ---------- 1) 依身分決定「可以選哪些班級」----------
  // 管理員(S/A/B)：所有班級。導師：自己導的班級 + 自己有排課的班級。單純任課教師：只有自己有排課的班級。
  useEffect(() => {
    getSiteContentMap().then(setSiteContent);
  }, []);

  useEffect(() => {
    (async () => {
      const appUser = await getCurrentAppUser();
      if (!appUser) return;
      const admin = isAdminInCurrentView(appUser.role);
      setIsAdmin(admin);

      if (admin) {
        const { data, error } = await supabase
          .from('classes')
          .select('id, academic_year, grade_level, class_name')
          .order('academic_year', { ascending: false })
          .order('grade_level');
        if (error) {
          setLoadError('讀取班級清單失敗：' + error.message);
          return;
        }
        setClassOptions(
          (data ?? []).map((c: any) => ({
            id: c.id,
            label: `${c.academic_year} ${c.grade_level}${c.class_name}`,
            academic_year: c.academic_year,
            grade_level: c.grade_level,
          }))
        );
        return;
      }

      const { data: teacherRow, error: teacherErr } = await supabase
        .from('teachers')
        .select('id')
        .eq('app_user_id', appUser.id)
        .maybeSingle();
      if (teacherErr) {
        setLoadError('讀取教師資料失敗：' + teacherErr.message);
        return;
      }
      if (!teacherRow) {
        setLoadError(
          `找不到您的教師資料（目前登入帳號：${appUser.email ?? '（無電子郵件）'}，讀到的角色是「${appUser.role}」）。` +
          '如果您預期自己現在是管理員，請確認登入的是「已經被改成管理員角色」的那個帳號，而不是另一個舊的導師/任課教師帳號；' +
          '也請到「帳號管理」頁確認這個信箱對應的角色設定是否正確。'
        );
        return;
      }

      const { data: homeroomClass } = await supabase
        .from('classes')
        .select('id')
        .eq('homeroom_teacher_id', teacherRow.id)
        .maybeSingle();
      let resolvedHomeroomClassId: string | null = homeroomClass?.id ?? null;

      // 保險機制：用 teacher_id 找不到自己導的班級時，改用姓名比對一次
      // （避免同一位老師被系統記成兩筆不同的 teachers 資料，導致完全找不到自己導的班）。
      if (!resolvedHomeroomClassId) {
        const { data: allHomeroomClasses } = await supabase
          .from('classes')
          .select('id, homeroom_teacher_id')
          .not('homeroom_teacher_id', 'is', null);
        const teacherIds = Array.from(new Set((allHomeroomClasses ?? []).map((c: any) => c.homeroom_teacher_id)));
        if (teacherIds.length > 0) {
          const { data: teacherNameRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          const nameById = new Map((teacherNameRows ?? []).map((t: any) => [t.id, t.name]));
          const match = (allHomeroomClasses ?? []).find((c: any) => nameById.get(c.homeroom_teacher_id) === appUser.name);
          if (match) resolvedHomeroomClassId = match.id;
        }
      }
      if (resolvedHomeroomClassId) setHomeroomClassId(resolvedHomeroomClassId);

      const { data: scheduleRows, error: schedErr } = await supabase
        .from('class_schedule')
        .select('class_id, subject')
        .eq('teacher_id', teacherRow.id);
      if (schedErr) {
        setLoadError('讀取任課班級失敗：' + schedErr.message);
        return;
      }

      const ownMap: Record<string, string[]> = {};
      (scheduleRows ?? []).forEach((r: any) => {
        if (!ownMap[r.class_id]) ownMap[r.class_id] = [];
        if (!ownMap[r.class_id].includes(r.subject)) ownMap[r.class_id].push(r.subject);
      });

      // 保險機制：如果用 teacher_id 完全比對不到任何班級（例如帳號建立順序問題，導致
      // class_schedule 裡的任課教師紀錄和目前登入帳號各自對應到不同的 teachers 資料列），
      // 改用「姓名」比對一次，避免任課教師登入後完全看不到自己的班級。
      if (Object.keys(ownMap).length === 0) {
        const { data: allSchedule } = await supabase.from('class_schedule').select('class_id, subject, teacher_id');
        const teacherIds = Array.from(new Set((allSchedule ?? []).map((r: any) => r.teacher_id).filter(Boolean)));
        if (teacherIds.length > 0) {
          const { data: teacherNameRows } = await supabase.from('teachers').select('id, name').in('id', teacherIds);
          const nameById = new Map((teacherNameRows ?? []).map((t: any) => [t.id, t.name]));
          (allSchedule ?? []).forEach((r: any) => {
            if (nameById.get(r.teacher_id) === appUser.name) {
              if (!ownMap[r.class_id]) ownMap[r.class_id] = [];
              if (!ownMap[r.class_id].includes(r.subject)) ownMap[r.class_id].push(r.subject);
            }
          });
        }
      }
      setOwnSubjectsByClass(ownMap);

      const classIds = Array.from(new Set([...(resolvedHomeroomClassId ? [resolvedHomeroomClassId] : []), ...Object.keys(ownMap)]));
      if (classIds.length === 0) {
        setClassOptions([]);
        return;
      }
      const { data: classRows } = await supabase
        .from('classes')
        .select('id, academic_year, grade_level, class_name')
        .in('id', classIds);
      setClassOptions(
        (classRows ?? []).map((c: any) => ({
          id: c.id,
          label: `${c.grade_level}${c.class_name}`,
          academic_year: c.academic_year,
          grade_level: c.grade_level,
        }))
      );
    })();
  }, []);

  // ---------- 2) 選好班級之後，決定可以選哪些科目 ----------
  // 管理員／導師（自己導的班）：這個班級所有任課教師教過的科目都能選（也能自行輸入新科目）。
  // 單純任課教師：只能選自己被指派教這個班級的科目（跟資料庫的授權規則一致）。
  useEffect(() => {
    setSubject('');
    setCustomSubject('');
    if (!classId) {
      setSubjectOptions([]);
      return;
    }
    const admin = isAdmin;
    if (admin) {
      (async () => {
        const { data: schedData, error: schedError } = await supabase
          .from('class_schedule')
          .select('subject')
          .eq('class_id', classId);
        if (schedError) {
          setLoadError('讀取這個班級的科目清單失敗：' + schedError.message);
          return;
        }
        const fromSchedule = (schedData ?? []).map((r: any) => r.subject).filter(Boolean);

        // 除了「任課教師設定」已經指定的科目，也把「科目與比重設定」（curriculum）裡
        // 這個年級已經設定好的科目一起列出來，這樣就算還沒做任課教師設定，科目也能自動出現。
        const classInfo = classOptions.find((c) => c.id === classId);
        let fromCurriculum: string[] = [];
        if (classInfo) {
          const { data: curriData } = await supabase
            .from('curriculum')
            .select('subject')
            .eq('academic_year', classInfo.academic_year)
            .eq('grade_level', classInfo.grade_level);
          fromCurriculum = (curriData ?? []).map((r: any) => r.subject).filter(Boolean);
        }

        setSubjectOptions(Array.from(new Set([...fromSchedule, ...fromCurriculum])));
      })();
    } else {
      // 導師與任課教師一律只能「輸入」自己實際被指派教的科目——就算是自己導的班，
      // 也不能直接改別科老師的分數；要看全班（所有科目）成績請到「班級成績總覽」報表頁，
      // 那邊本來就是唯讀、給導師看全班用的，跟這裡的「輸入」頁功能分開。
      setSubjectOptions(ownSubjectsByClass[classId] ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, isAdmin, classOptions]);

  // ---------- 3) 班級 + 科目 + 考試類型都選好才載入學生名單與分數 ----------
  useEffect(() => {
    if (!classId || !effectiveSubject || !examType) {
      setRows([]);
      setSelected(new Set());
      return;
    }
    (async () => {
      // 注意：這裡刻意不用 students(name) 這種自動關聯embed查詢——在這個資料庫上這類查詢會不穩定、
      // 整批失敗又不一定會回報明確錯誤，導致學生名單完全出不來。改成分開查、用 Map 手動兜資料。
      const { data: enrollRows, error: enrollErr } = await supabase
        .from('enrollments')
        .select('id, seat_no, student_no')
        .eq('class_id', classId)
        .order('seat_no');
      if (enrollErr) {
        setLoadError('讀取學生名單失敗：' + enrollErr.message);
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

      const enrollIds = (enrollRows ?? []).map((r: any) => r.id);
      const { data: scoreRows } = await supabase
        .from('scores')
        .select('enrollment_id, score')
        .in('enrollment_id', enrollIds.length > 0 ? enrollIds : ['00000000-0000-0000-0000-000000000000'])
        .eq('exam_type', examType)
        .eq('subject', effectiveSubject);

      const scoreMap = new Map((scoreRows ?? []).map((r: any) => [r.enrollment_id, r.score]));
      setRows(
        (enrollRows ?? []).map((r: any) => ({
          enrollment_id: r.id,
          seat_no: r.seat_no,
          name: nameByStudentNo.get(r.student_no) ?? '（找不到姓名）',
          score: scoreMap.get(r.id)?.toString() ?? '',
        }))
      );

      const { data: windowRow } = await supabase
        .from('submission_windows')
        .select('is_locked')
        .eq('data_type', examType)
        .eq('scope', '班級')
        .eq('scope_ref', classId)
        .maybeSingle();
      setLocked(!!windowRow?.is_locked && !isAdmin);
    })();
  }, [classId, effectiveSubject, examType, isAdmin]);

  function updateScore(enrollmentId: string, value: string) {
    setRows((prev) => prev.map((r) => (r.enrollment_id === enrollmentId ? { ...r, score: value } : r)));
  }

  // 批次刪除：直接刪掉資料庫裡「目前這個科目＋考試類型」下，選取學生的成績列。
  async function handleBatchDeleteScores() {
    if (selected.size === 0 || !effectiveSubject || !examType) return;
    const { error } = await supabase
      .from('scores')
      .delete()
      .eq('exam_type', examType)
      .eq('subject', effectiveSubject)
      .in('enrollment_id', Array.from(selected));
    setArmedAction(null);
    if (error) {
      alert('批次刪除失敗：' + error.message);
      return;
    }
    setRows((prev) => prev.map((r) => (selected.has(r.enrollment_id) ? { ...r, score: '' } : r)));
    setSelected(new Set());
  }

  // 批次修改：把選取學生的分數都直接寫成同一個值（直接存進資料庫，跟批次刪除一樣不用另外按「儲存」）。
  async function handleBatchSetScore() {
    if (selected.size === 0 || !effectiveSubject || !examType) return;
    const value = Number(batchScoreValue);
    if (batchScoreValue === '' || Number.isNaN(value) || value < 0 || value > 100) {
      alert('請輸入 0–100 之間的分數');
      return;
    }
    const payload = Array.from(selected).map((enrollmentId) => ({
      enrollment_id: enrollmentId,
      exam_type: examType,
      subject: effectiveSubject,
      score: value,
    }));
    const { error } = await supabase.from('scores').upsert(payload, { onConflict: 'enrollment_id,exam_type,subject' });
    setArmedAction(null);
    if (error) {
      alert('批次修改失敗：' + error.message);
      return;
    }
    setRows((prev) => prev.map((r) => (selected.has(r.enrollment_id) ? { ...r, score: String(value) } : r)));
    setSelected(new Set());
    setBatchScoreValue('');
  }

  async function handleSave() {
    if (!classId || !effectiveSubject || !examType) return;
    const payload = rows
      .filter((r) => r.score !== '')
      .map((r) => ({
        enrollment_id: r.enrollment_id,
        exam_type: examType,
        subject: effectiveSubject,
        score: Number(r.score),
      }));
    const { error } = await supabase.from('scores').upsert(payload, { onConflict: 'enrollment_id,exam_type,subject' });
    if (error) {
      alert('儲存失敗：' + error.message);
      return;
    }
    alert('已儲存');
    // 儲存成功後，回到登錄頁初始狀態，方便老師接著填下一個班級或科目。
    setClassId('');
    setSubject('');
    setCustomSubject('');
    setExamType('');
    setRows([]);
    setSelected(new Set());
    setArmedAction(null);
    setBatchScoreValue('');
    setShowEntered(false);
  }

  // 解析「成績、出缺輸入表」格式，把期中考/期末考/平時分三個區塊裡每一科的分數都匯入。
  async function handleUploadFile(file: File) {
    const rowsRaw = await readWorkbook(file);
    const header = parseSheetHeader(rowsRaw);
    if (!header.academicYear || !header.term || !header.gradeLevel || !header.className) {
      return { successCount: 0, errors: ['讀不到年度/學期/年級/班級，請確認檔案格式'] };
    }

    const { data: classRow } = await supabase
      .from('classes')
      .select('id')
      .eq('academic_year', header.academicYear)
      .eq('department', departmentForGrade(header.gradeLevel))
      .eq('grade_level', header.gradeLevel)
      .eq('class_name', header.className)
      .maybeSingle();
    if (!classRow) {
      return { successCount: 0, errors: [`找不到對應班級：${header.academicYear} ${header.gradeLevel}${header.className}，請先在「班級與導師設定」建立`] };
    }

    const { data: enrollRows } = await supabase
      .from('enrollments')
      .select('id, student_no')
      .eq('class_id', classRow.id)
      .eq('term', header.term);
    const enrollByStudentNo = new Map((enrollRows ?? []).map((e: any) => [e.student_no, e.id]));

    const students = parseStudentRows(rowsRaw);
    const blocks = findScoreBlocks(rowsRaw);

    let successCount = 0;
    const errors: string[] = [];

    for (const block of blocks) {
      for (const s of students) {
        const enrollmentId = enrollByStudentNo.get(s.studentNo);
        if (!enrollmentId) {
          errors.push(`${s.name}（${s.studentNo}）在這個班級/學期查無學籍，已略過`);
          continue;
        }
        const row = rowsRaw[s.rowIndex];
        for (const subj of block.subjects) {
          const score = row[subj.index];
          if (score == null || score === '') continue;
          const { error } = await supabase.from('scores').upsert(
            { enrollment_id: enrollmentId, exam_type: block.examType, subject: subj.subject, score: Number(score) },
            { onConflict: 'enrollment_id,exam_type,subject' }
          );
          if (error) errors.push(`${s.name} ${block.examType} ${subj.subject}：${error.message}`);
          else successCount++;
        }
      }
    }
    return { successCount, errors };
  }

  const filledCount = rows.filter((r) => r.score !== '').length;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: isMobile ? '16px 12px' : 16 }}>
      <h1 style={{ fontSize: isMobile ? 18 : 16, marginBottom: 4 }}>成績登錄</h1>
      <ErrorBanner message={loadError} />

      {classOptions.length === 0 && !loadError && (
        <p style={{ fontSize: 13, color: '#999', marginBottom: 12 }}>
          目前沒有可登錄成績的班級，請聯絡管理員在「任課教師設定」／「班級與導師設定」頁確認配課。
        </p>
      )}

      {isMobile ? (
        // 手機版：批次上傳（要選檔案、通常在桌機用試算表準備好資料再傳）預設收合，
        // 平常用手機一列一列輸入分數的情境不會被這塊佔掉版面；點「批次上傳」才展開。
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 13, color: '#666', cursor: 'pointer' }}>
            {siteContent['page_hint.scores_entry'] ?? '批次上傳'}
          </summary>
          <div style={{ marginTop: 8 }}>
            <TemplateDownloadButton label="下載成績輸入範本" onClick={downloadScoreAttendanceTemplate} />
            <ExcelUploadButton onFile={handleUploadFile} />
          </div>
        </details>
      ) : (
        <>
          <h2 style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{siteContent['page_hint.scores_entry'] ?? '批次上傳（格式同「成績、出缺輸入表」工作表）'}</h2>
          <TemplateDownloadButton label="下載成績輸入範本" onClick={downloadScoreAttendanceTemplate} />
          <ExcelUploadButton onFile={handleUploadFile} />
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ padding: isMobile ? 10 : 6, fontSize: isMobile ? 15 : 13 }}>
          <option value="">請選擇班級</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
              {c.id === homeroomClassId ? '（導師班）' : ''}
            </option>
          ))}
        </select>

        {classId && (
          <select value={subject} onChange={(e) => setSubject(e.target.value)} style={{ padding: isMobile ? 10 : 6, fontSize: isMobile ? 15 : 13 }}>
            <option value="">請選擇科目</option>
            {subjectOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            {canPickAnySubject && <option value={CUSTOM_SUBJECT_VALUE}>其他（自行輸入科目名稱）</option>}
          </select>
        )}

        {subject === CUSTOM_SUBJECT_VALUE && (
          <input
            placeholder="輸入科目名稱"
            value={customSubject}
            onChange={(e) => setCustomSubject(e.target.value)}
            style={{ padding: isMobile ? 10 : 6, fontSize: isMobile ? 15 : 13 }}
          />
        )}

        <select value={examType} onChange={(e) => setExamType(e.target.value as any)} style={{ padding: isMobile ? 10 : 6, fontSize: isMobile ? 15 : 13 }}>
          <option value="">請選擇考試類型</option>
          {EXAM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {classId && subjectOptions.length === 0 && !canPickAnySubject && (
        <p style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>您目前沒有被指派這個班級的任何科目。</p>
      )}
      {classId && subjectOptions.length === 0 && canPickAnySubject && subject !== CUSTOM_SUBJECT_VALUE && (
        <p style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>
          {classLabel} 目前還沒有任課教師/科目資料，可以選「其他（自行輸入科目名稱）」直接登錄。
        </p>
      )}
      {classId && effectiveSubject && !examType && (
        <p style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>請選擇「期中考」「期末考」或「平時分」後開始輸入分數。</p>
      )}

      {classId && effectiveSubject && examType && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666', marginBottom: 8 }}>
            <span>已填 {filledCount} / {rows.length}</span>
            <span>分數範圍 0–100</span>
          </div>

          {locked && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 8 }}>此考試類型目前已鎖定，需申請修正。</p>}

          {!locked && selected.size > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: 8, background: '#F5F5F3', borderRadius: 6 }}>
              <span style={{ fontSize: 12, color: '#666' }}>已選取 {selected.size} 位</span>
              {armedAction === null && (
                <>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="統一改成"
                    value={batchScoreValue}
                    onChange={(e) => setBatchScoreValue(e.target.value)}
                    style={{ width: 80, padding: 4, fontSize: 12 }}
                  />
                  <button onClick={() => setArmedAction('edit')} style={{ fontSize: 12, padding: '4px 10px' }}>
                    批次改分數
                  </button>
                  <button onClick={() => setArmedAction('delete')} style={{ fontSize: 12, padding: '4px 10px', color: '#A32D2D' }}>
                    批次清除分數
                  </button>
                  <button onClick={() => setSelected(new Set())} style={{ fontSize: 12, padding: '4px 10px' }}>
                    取消選取
                  </button>
                </>
              )}
              {armedAction === 'edit' && (
                <>
                  <span style={{ fontSize: 12 }}>確定要把這 {selected.size} 位的分數都改成 {batchScoreValue} 嗎？</span>
                  <button onClick={handleBatchSetScore} style={{ fontSize: 12, padding: '4px 10px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 4 }}>
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
                    確定要清除這 {selected.size} 位在「{effectiveSubject}／{examType}」的分數嗎？此動作無法復原。
                  </span>
                  <button onClick={handleBatchDeleteScores} style={{ fontSize: 12, padding: '4px 10px', background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 4 }}>
                    確定清除
                  </button>
                  <button onClick={() => setArmedAction(null)} style={{ fontSize: 12, padding: '4px 10px' }}>
                    取消
                  </button>
                </>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666', padding: '4px 0' }}>
              <input type="checkbox" checked={selected.size === rows.length} onChange={toggleSelectAll} />
              全選
            </label>
          )}

          {rows.map((r) => (
            <div
              key={r.enrollment_id}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: isMobile ? '12px 0' : '8px 0', borderBottom: '1px solid #eee' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: isMobile ? 16 : 14 }}>
                <input
                  type="checkbox"
                  checked={selected.has(r.enrollment_id)}
                  onChange={() => toggleSelect(r.enrollment_id)}
                  disabled={locked}
                />
                <span style={{ color: '#999', marginRight: 6 }}>{r.seat_no}</span>
                {r.name}
              </span>
              <input
                ref={(el) => {
                  scoreInputRefs.current[r.enrollment_id] = el;
                }}
                type="number"
                min={0}
                max={100}
                disabled={locked}
                value={r.score}
                onChange={(e) => updateScore(r.enrollment_id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    focusNextScoreInput(r.enrollment_id);
                  }
                }}
                style={{ width: isMobile ? 76 : 64, textAlign: 'center', padding: isMobile ? 10 : 4, fontSize: isMobile ? 16 : 14 }}
              />
            </div>
          ))}

          {rows.length === 0 && <p style={{ fontSize: 13, color: '#999' }}>這個班級目前沒有在學學生。</p>}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              onClick={() => setShowEntered(true)}
              disabled={rows.length === 0}
              style={{ flex: 1, padding: isMobile ? 16 : 12, fontSize: isMobile ? 16 : 14, borderRadius: 8, background: '#fff', color: '#2C2C2A', border: '1px solid #2C2C2A' }}
            >
              查看已輸入成績
            </button>
            <button
              onClick={handleSave}
              disabled={locked || rows.length === 0}
              style={{ flex: 1, padding: isMobile ? 16 : 12, fontSize: isMobile ? 16 : 14, borderRadius: 8, background: '#2C2C2A', color: '#fff', border: 'none' }}
            >
              儲存
            </button>
          </div>
        </>
      )}

      {showEntered && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={() => setShowEntered(false)}
        >
          <div
            style={{ background: '#fff', borderRadius: 8, padding: 24, width: 420, maxHeight: '80vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: 15, marginBottom: 4 }}>已輸入成績</h2>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
              {classLabel}｜{effectiveSubject}｜{examType}（共 {rows.filter((r) => r.score !== '').length} 位已填）
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 4 }}>座號</th>
                  <th style={{ textAlign: 'left', padding: 4 }}>姓名</th>
                  <th style={{ textAlign: 'right', padding: 4 }}>分數</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.score !== '')
                  .map((r) => (
                    <tr key={r.enrollment_id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ padding: 4 }}>{r.seat_no}</td>
                      <td style={{ padding: 4 }}>{r.name}</td>
                      <td style={{ padding: 4, textAlign: 'right' }}>{r.score}</td>
                    </tr>
                  ))}
                {rows.filter((r) => r.score !== '').length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ padding: 12, textAlign: 'center', color: '#999' }}>
                      目前還沒有任何已輸入的分數
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <button
              onClick={() => setShowEntered(false)}
              style={{ width: '100%', marginTop: 16, padding: 10, background: '#eee', border: 'none', borderRadius: 6 }}
            >
              關閉
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
