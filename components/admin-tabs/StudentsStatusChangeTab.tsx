'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const STATUS_OPTIONS = ['入學', '休學', '轉學', '退學', '畢業', '肄業', '復學'] as const;
const HIDDEN_STATUSES = ['休學', '轉學', '退學', '畢業', '肄業'] as const;

const TEMPLATE_FILES: Record<string, string> = {
  入學: '/templates/入學申請書.docx',
  休學: '/templates/休學申請書.docx',
  轉學: '/templates/轉學申請書.docx',
  退學: '/templates/退學申請書.docx',
  畢業: '/templates/畢業離校確認書.docx',
  肄業: '/templates/肄業證明申請書.docx',
  復學: '/templates/復學申請書.docx',
};

type HiddenStudentRow = { student_no: string; name: string; status: string; effective_date: string };

export default function StatusChangePage() {
  const [studentNo, setStudentNo] = useState('');
  const [studentName, setStudentName] = useState<string | null>(null);
  // 【本輪新增】反映事項「高二忠班 馬成孝已休學但成績上仍可以看到他且排名為
  // 第一，點名表上他也還存在。請再確認休學、轉學、退學的設定，同時把所有有
  // 學籍更動的學生都修正好」：查詢學號時，順便把系統目前記錄到的「最新狀態」
  // 也顯示出來——如果查到的最新狀態不是「休學」，代表系統裡根本沒有這筆
  // 休學紀錄（可能是當初儲存失敗、或用了別的方式登記），這種情況不是「隱藏
  // 名單的規則沒生效」，是「這筆狀態變更根本沒被記錄到」，需要重新在下面
  // 表單登記一次。
  const [currentStatus, setCurrentStatus] = useState<{ status: string; effective_date: string } | null | undefined>(undefined);
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>('休學');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [saving, setSaving] = useState(false);

  const [hiddenList, setHiddenList] = useState<HiddenStudentRow[] | null>(null);
  const [hiddenListError, setHiddenListError] = useState<string | null>(null);
  const [loadingHiddenList, setLoadingHiddenList] = useState(false);

  async function loadHiddenList() {
    setLoadingHiddenList(true);
    setHiddenListError(null);
    // 【本輪新增】直接把「系統目前判定為應該隱藏」的學生名單列出來，給管理員
    // 對照——每個學生只看最新一筆狀態紀錄（跟 student_is_hidden() 用的邏輯
    // 一致：按 effective_date、created_at 排序取最新一筆）。如果名單裡沒看到
    // 某位學生（例如馬成孝），代表系統裡根本沒有他的休學紀錄，需要重新登記。
    const { data, error } = await supabase
      .from('student_status_changes')
      .select('student_no, status, effective_date, created_at, students(name)')
      .order('student_no')
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false });
    setLoadingHiddenList(false);
    if (error) {
      setHiddenListError('讀取失敗：' + error.message);
      return;
    }
    // 每個學生只留「最新一筆」（資料已經照 student_no, effective_date desc, created_at desc 排序，
    // 同一學號第一次出現的就是最新那筆）。
    const latestByStudent = new Map<string, HiddenStudentRow>();
    (data ?? []).forEach((r: any) => {
      if (!latestByStudent.has(r.student_no)) {
        latestByStudent.set(r.student_no, {
          student_no: r.student_no,
          name: r.students?.name ?? r.student_no,
          status: r.status,
          effective_date: r.effective_date,
        });
      }
    });
    const hidden = Array.from(latestByStudent.values()).filter((r) => (HIDDEN_STATUSES as readonly string[]).includes(r.status));
    setHiddenList(hidden);
  }

  async function lookupStudent() {
    const { data } = await supabase.from('students').select('name').eq('student_no', studentNo).maybeSingle();
    setStudentName(data?.name ?? null);
    if (!data) {
      setCurrentStatus(undefined);
      return;
    }
    const { data: latest } = await supabase
      .from('student_status_changes')
      .select('status, effective_date')
      .eq('student_no', studentNo)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setCurrentStatus(latest ?? null);
  }

  useEffect(() => {
    loadHiddenList();
  }, []);

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
    setCurrentStatus({ status, effective_date: effectiveDate });
    loadHiddenList();
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>學籍狀態變更</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        休學／轉學／退學／畢業／肄業／復學，直接記錄狀態變化即可，不需要審核流程。可附加佐證資料（例如休學證明、家長申請書掃描檔）。
        休學／轉學／退學／畢業／肄業這五種狀態記錄後，這位學生的出缺勤／成績等資料會自動從一般查詢畫面（成績登錄、出缺勤登錄、學生名冊等）隱藏，只有管理員查得到；
        座號仍會保留（不會釋放給別人），復學時請另外到「學籍設定及查詢」把學生重新加入班級，資料才會恢復正常顯示。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          placeholder="輸入學號"
          value={studentNo}
          onChange={(e) => {
            setStudentNo(e.target.value);
            setStudentName(null);
            setCurrentStatus(undefined);
          }}
          style={{ padding: 8, flex: 1 }}
        />
        <button type="button" onClick={lookupStudent} style={{ padding: '8px 16px' }}>
          查詢
        </button>
      </div>
      {studentName && (
        <p style={{ fontSize: 13, marginBottom: 16 }}>
          學生：{studentName}
          {currentStatus === undefined ? null : currentStatus === null ? (
            <span style={{ color: '#1E7B45' }}>（系統目前沒有任何學籍狀態變更紀錄，視為在學中）</span>
          ) : (
            <span style={{ color: (HIDDEN_STATUSES as readonly string[]).includes(currentStatus.status) ? '#A32D2D' : '#1E7B45' }}>
              （系統目前記錄的最新狀態：{currentStatus.status}，生效日 {currentStatus.effective_date}）
            </span>
          )}
        </p>
      )}

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

      {/* 【本輪新增】反映事項「請再確認休學、轉學、退學的設定，同時把所有有學籍
          更動的學生都修正好」——直接把系統目前判定「應該被隱藏」的學生名單列出來，
          方便對照：如果某位已經辦好休學/轉學/退學的學生沒有出現在這份名單裡，
          代表系統裡根本沒有記錄到這筆狀態變更，需要用上面的表單重新登記一次
          （而不是隱藏規則本身有問題）。 */}
      <div style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid #eee' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h2 style={{ fontSize: 14 }}>目前系統判定「應隱藏」的學生名單</h2>
          <button type="button" onClick={loadHiddenList} disabled={loadingHiddenList} style={{ fontSize: 12, padding: '2px 10px' }}>
            {loadingHiddenList ? '讀取中…' : '重新整理'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          休學／轉學／退學／畢業／肄業狀態的學生，一般教師查成績、出缺勤、學生名冊時應該都看不到他們。這份名單就是系統實際依照這個規則判定出來的結果——
          如果某位學生明明已經辦好離校手續、卻沒有出現在下面，代表系統裡沒有他的狀態變更紀錄，用上面的表單補登記即可。
        </p>
        {hiddenListError && <p style={{ fontSize: 12, color: '#A32D2D' }}>{hiddenListError}</p>}
        {hiddenList && hiddenList.length === 0 && !hiddenListError && (
          <p style={{ fontSize: 12, color: '#999' }}>目前沒有任何學生被系統判定為應隱藏。</p>
        )}
        {hiddenList && hiddenList.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: '4px 8px' }}>學號</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: '4px 8px' }}>姓名</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: '4px 8px' }}>最新狀態</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: '4px 8px' }}>生效日</th>
              </tr>
            </thead>
            <tbody>
              {hiddenList.map((r) => (
                <tr key={r.student_no}>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #f5f5f5' }}>{r.student_no}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #f5f5f5' }}>{r.name}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #f5f5f5' }}>{r.status}</td>
                  <td style={{ padding: '4px 8px', borderBottom: '1px solid #f5f5f5' }}>{r.effective_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
