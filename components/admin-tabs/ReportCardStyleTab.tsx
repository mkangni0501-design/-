'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { DEFAULT_REPORT_CARD_STYLE, ReportCardStyleConfig } from '@/lib/ReportCardDocument';

// 管理員可以下載/上傳成績單樣式：只能改顏色、字級、邊框粗細、文字標籤，
// 不會動到「資料從哪裡來」這件事（那部分寫死在 lib/ReportCardDocument.tsx 的程式
// 邏輯裡，這個設定檔改不到）。下載目前生效中的設定成一份 JSON，改完再上傳回來，
// 或者也可以直接在下面的表單裡調整。

const COLOR_FIELDS: { key: keyof ReportCardStyleConfig['colors']; label: string }[] = [
  { key: 'yearBoxBg', label: '學年度色塊' },
  { key: 'termBoxBg', label: '學期色塊' },
  { key: 'infoValueBg', label: '學號/姓名色塊' },
  { key: 'infoValueGreenBg', label: '座號色塊' },
  { key: 'sectionTitleBg', label: '區塊標題底色' },
  { key: 'cellLeftLabelBg', label: '科目/項目欄底色' },
  { key: 'borderColor', label: '邊框顏色' },
];

const LABEL_FIELDS: { key: keyof ReportCardStyleConfig['labels']; label: string }[] = [
  { key: 'title', label: '標題（成績通知書）' },
  { key: 'academicYearSuffix', label: '學年度後綴' },
  { key: 'subject', label: '科目欄標題' },
  { key: 'weight', label: '比重欄標題' },
  { key: 'annualTotal', label: '學年成績欄標題' },
  { key: 'academicAverage', label: '學業平均列標題' },
  { key: 'attendanceSubject', label: '出缺席列標題' },
  { key: 'conductOverall', label: '操行成績列標題' },
  { key: 'conductPoliteness', label: '禮貌列標題' },
  { key: 'conductDress', label: '衣著列標題' },
  { key: 'conductService', label: '服務列標題' },
  { key: 'conductDiscipline', label: '紀律列標題' },
  { key: 'attendanceRecordTitle', label: '出席記錄標題' },
  { key: 'disciplineRecordTitle', label: '懲獎記錄標題' },
  { key: 'perfectAttendance', label: '全勤列標題' },
  { key: 'classSize', label: '全班人數標題' },
  { key: 'classRank', label: '全班名次標題' },
  { key: 'promotionStatus', label: '升留級標題' },
  { key: 'parentSignature', label: '家長簽章及建議標題' },
  { key: 'homeroomSign', label: '導師簽章標題' },
  { key: 'disciplineSign', label: '訓導簽章標題' },
  { key: 'academicSign', label: '教務簽章標題' },
  { key: 'principalSign', label: '校長簽章標題' },
  { key: 'remark', label: '導師評語標題' },
];

export default function ReportCardStyleTab() {
  const [config, setConfig] = useState<ReportCardStyleConfig>(DEFAULT_REPORT_CARD_STYLE);
  const [styleId, setStyleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState<'logoUrl' | 'campusPhotoUrl' | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('report_card_style').select('id, config').eq('is_active', true).maybeSingle();
      if (data) {
        setStyleId(data.id);
        setConfig({
          colors: { ...DEFAULT_REPORT_CARD_STYLE.colors, ...(data.config as any)?.colors },
          sizes: { ...DEFAULT_REPORT_CARD_STYLE.sizes, ...(data.config as any)?.sizes },
          labels: { ...DEFAULT_REPORT_CARD_STYLE.labels, ...(data.config as any)?.labels },
          layout: { ...DEFAULT_REPORT_CARD_STYLE.layout, ...(data.config as any)?.layout },
        });
      }
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    // 先把其他設定都設成非生效中，再把這筆（新增或更新）設成生效中——整個學校同時只有
    //一份生效中的樣式。
    await supabase.from('report_card_style').update({ is_active: false }).eq('is_active', true);
    if (styleId) {
      const { error } = await supabase
        .from('report_card_style')
        .update({ config, is_active: true, updated_at: new Date().toISOString() })
        .eq('id', styleId);
      setSaving(false);
      if (error) return alert('儲存失敗：' + error.message);
    } else {
      const { data, error } = await supabase.from('report_card_style').insert({ name: '自訂樣式', config, is_active: true }).select('id').single();
      setSaving(false);
      if (error) return alert('儲存失敗：' + error.message);
      setStyleId(data.id);
    }
    alert('已儲存，之後產出的成績單會套用這份樣式。');
  }

  function handleDownload() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '成績單樣式.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const uploaded = JSON.parse(String(reader.result));
        // 只接受顏色/字級/標籤這三類欄位，其餘（萬一檔案裡混進其他東西）一律忽略，
        // 確保不會有辦法透過上傳的檔案改到資料綁定邏輯。
        setConfig({
          colors: { ...DEFAULT_REPORT_CARD_STYLE.colors, ...uploaded.colors },
          sizes: { ...DEFAULT_REPORT_CARD_STYLE.sizes, ...uploaded.sizes },
          labels: { ...DEFAULT_REPORT_CARD_STYLE.labels, ...uploaded.labels },
          layout: { ...DEFAULT_REPORT_CARD_STYLE.layout, ...uploaded.layout },
        });
        alert('已讀入檔案內容，確認沒問題後記得按「儲存」才會生效。');
      } catch {
        alert('這個檔案不是有效的 JSON，讀取失敗。');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function resetToDefault() {
    if (!confirm('確定要還原成系統內建的預設樣式嗎？（要按「儲存」才會真的生效）')) return;
    setConfig(DEFAULT_REPORT_CARD_STYLE);
  }

  // 校徽／校園照片上傳：存到 site-assets 這個公開讀取的儲存空間（跟背景音樂共用
  // 同一個 bucket），存好後把公開網址寫進 config.layout，成績單 PDF 直接用這個網址
  // 讀圖（伺服器端產生 PDF 時用 fetch 抓，不需要另外處理權限）。
  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>, field: 'logoUrl' | 'campusPhotoUrl') {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(field);
    const ext = file.name.split('.').pop();
    const path = `report-card/${field}-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('site-assets').upload(path, file, { upsert: true });
    setUploadingImage(null);
    if (uploadError) {
      alert('上傳失敗：' + uploadError.message);
      return;
    }
    const { data: urlData } = supabase.storage.from('site-assets').getPublicUrl(path);
    setConfig((prev) => ({ ...prev, layout: { ...prev.layout, [field]: urlData.publicUrl } }));
    e.target.value = '';
  }

  if (loading) return <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>;

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>
        成績單樣式設定——只能調整顏色、字級、邊框、文字標籤，不會影響成績單顯示的資料內容或計算方式。
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={handleDownload} style={{ padding: '6px 14px', fontSize: 13, border: '1px solid #2C6E9E', background: '#fff', color: '#2C6E9E', borderRadius: 6 }}>
          ↓ 下載目前樣式（JSON）
        </button>
        <label style={{ padding: '6px 14px', fontSize: 13, border: '1px solid #2C6E9E', background: '#fff', color: '#2C6E9E', borderRadius: 6, cursor: 'pointer' }}>
          ↑ 上傳樣式（JSON）
          <input type="file" accept="application/json" onChange={handleUpload} style={{ display: 'none' }} />
        </label>
        <button onClick={resetToDefault} style={{ padding: '6px 14px', fontSize: 13, border: '1px solid #999', background: '#fff', color: '#666', borderRadius: 6 }}>
          還原成預設樣式
        </button>
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>顏色</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {COLOR_FIELDS.map((f) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <label style={{ width: 120 }}>{f.label}</label>
            <input
              type="color"
              value={config.colors[f.key]}
              onChange={(e) => setConfig((prev) => ({ ...prev, colors: { ...prev.colors, [f.key]: e.target.value } }))}
            />
            <span style={{ color: '#999', fontSize: 12 }}>{config.colors[f.key]}</span>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>字級與邊框</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {(
          [
            { key: 'baseFontSize', label: '內文字級' },
            { key: 'headerFontSize', label: '標題列字級' },
            { key: 'titleFontSize', label: '大標題字級' },
            { key: 'borderWidth', label: '邊框粗細' },
          ] as const
        ).map((f) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <label style={{ width: 120 }}>{f.label}</label>
            <input
              type="number"
              step={0.1}
              value={config.sizes[f.key]}
              onChange={(e) => setConfig((prev) => ({ ...prev, sizes: { ...prev.sizes, [f.key]: Number(e.target.value) } }))}
              style={{ width: 80, padding: 4 }}
            />
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>版面配置</h3>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
        目前還沒有拖曳版面編輯器（那是一個獨立的大功能），這裡先開放幾個常見、風險較低的調整項目：校徽/校園照片、
        外頁要不要印、內頁幾個欄位的寬度。改完按「儲存並套用」，下一次列印就會套用，不用重新部署程式碼。
      </p>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={config.layout.showCoverPage}
            onChange={(e) => setConfig((prev) => ({ ...prev, layout: { ...prev.layout, showCoverPage: e.target.checked } }))}
          />
          列印外頁（封面說明頁：操行標準、獎懲加扣分、學業佔比、出缺席加扣分）
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>校徽圖片</label>
          {config.layout.logoUrl && <img src={config.layout.logoUrl} alt="校徽" style={{ width: 60, height: 60, objectFit: 'contain', marginBottom: 6, border: '1px solid #eee' }} />}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #999', borderRadius: 6, cursor: 'pointer' }}>
              {uploadingImage === 'logoUrl' ? '上傳中…' : config.layout.logoUrl ? '更換圖片' : '上傳圖片'}
              <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'logoUrl')} style={{ display: 'none' }} disabled={!!uploadingImage} />
            </label>
            {config.layout.logoUrl && (
              <button onClick={() => setConfig((prev) => ({ ...prev, layout: { ...prev.layout, logoUrl: '' } }))} style={{ fontSize: 12, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>
                移除
              </button>
            )}
          </div>
        </div>
        <div>
          <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>校園照片</label>
          {config.layout.campusPhotoUrl && <img src={config.layout.campusPhotoUrl} alt="校園照片" style={{ width: 120, height: 60, objectFit: 'cover', marginBottom: 6, border: '1px solid #eee' }} />}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ padding: '4px 12px', fontSize: 12, border: '1px solid #999', borderRadius: 6, cursor: 'pointer' }}>
              {uploadingImage === 'campusPhotoUrl' ? '上傳中…' : config.layout.campusPhotoUrl ? '更換圖片' : '上傳圖片'}
              <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'campusPhotoUrl')} style={{ display: 'none' }} disabled={!!uploadingImage} />
            </label>
            {config.layout.campusPhotoUrl && (
              <button onClick={() => setConfig((prev) => ({ ...prev, layout: { ...prev.layout, campusPhotoUrl: '' } }))} style={{ fontSize: 12, color: '#A32D2D', background: 'none', border: 'none', cursor: 'pointer' }}>
                移除
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 20 }}>
        {(
          [
            { key: 'subjectColWidthPercent', label: '內頁「科目」欄寬度(%)' },
            { key: 'weightColWidthPercent', label: '內頁「比重」欄寬度(%)' },
            { key: 'annualColWidthPercent', label: '內頁「學年成績」欄寬度(%)' },
          ] as const
        ).map((f) => (
          <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <label>{f.label}</label>
            <input
              type="number"
              step={0.5}
              min={0}
              max={40}
              value={config.layout[f.key]}
              onChange={(e) => setConfig((prev) => ({ ...prev, layout: { ...prev.layout, [f.key]: Number(e.target.value) } }))}
              style={{ padding: 4 }}
            />
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>文字標籤（不含科目名稱、分數等實際資料）</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        {LABEL_FIELDS.map((f) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <label style={{ width: 150, flexShrink: 0 }}>{f.label}</label>
            <input
              type="text"
              value={config.labels[f.key]}
              onChange={(e) => setConfig((prev) => ({ ...prev, labels: { ...prev.labels, [f.key]: e.target.value } }))}
              style={{ flex: 1, padding: 4, fontSize: 13 }}
            />
          </div>
        ))}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        style={{ padding: '10px 24px', background: '#2C2C2A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13 }}
      >
        {saving ? '儲存中…' : '儲存並套用'}
      </button>
    </div>
  );
}
