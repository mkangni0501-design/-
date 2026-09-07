'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 成績單「直接套用 Excel 範本」管理頁：對應反映事項「請用EXCEL表，如果要做成
// WORD請一樣用EXCEL的格式去完成」——這個輸出方式不是「照著 Excel 重畫一份像的
// 版面」，是直接拿您上傳的這份 .xlsx 當範本，把資料填進去，範本裡原本的格式、
// 顏色、框線、公式完全不動，保證長得跟您在 Excel 裡看到的一模一樣。
//
// 跟「Word 合併列印」（ReportCardMergeTemplateTab）不一樣的地方：Word 那邊是用
// {{欄位}} 這種標籤、標籤放在範本裡的哪個位置都可以，比較自由；這裡是直接指定
// 「儲存格座標」（例如 C6 是第一個科目的期中考分數），所以如果要自己調整這份
// Excel 範本的版面，儲存格的「相對位置」不能大幅更動（例如整欄搬到別的地方），
// 不然系統會填錯地方。如果只是調整顏色、框線、字型、加註解文字，不影響。
export default function ReportCardXlsxTemplateTab() {
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reverting, setReverting] = useState(false);

  async function authHeader() {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    return { Authorization: `Bearer ${token}` };
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch('/api/reports/report-card-xlsx-template', { headers: await authHeader() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert('下載失敗：' + (body.error ?? res.status));
        return;
      }
      const isCustom = res.headers.get('X-Is-Custom-Template') === 'true';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = isCustom ? '成績單Excel範本.xlsx' : '成績單Excel範本(系統預設).xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('下載發生錯誤：' + (err?.message ?? String(err)));
    } finally {
      setDownloading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      alert('請上傳 .xlsx 格式的 Excel 檔案（不是 .xls 舊格式，也不是 .docx）');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/reports/report-card-xlsx-template', {
        method: 'POST',
        headers: await authHeader(),
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('上傳失敗：' + (body.error ?? res.status));
        return;
      }
      alert('已上傳並生效，之後的「Excel 範本」成績單會套用這份範本。');
    } catch (err: any) {
      alert('上傳發生錯誤：' + (err?.message ?? String(err)));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleRevert() {
    if (!confirm('確定要還原成系統內建的預設範本嗎？目前上傳的自訂範本會停用（不會被刪除歷史紀錄，但列印會改用預設範本）。')) return;
    setReverting(true);
    try {
      const res = await fetch('/api/reports/report-card-xlsx-template', { method: 'DELETE', headers: await authHeader() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('還原失敗：' + (body.error ?? res.status));
        return;
      }
      alert('已還原成系統內建預設範本。');
    } catch (err: any) {
      alert('還原發生錯誤：' + (err?.message ?? String(err)));
    } finally {
      setReverting(false);
    }
  }

  return (
    <div style={{ maxWidth: 780 }}>
      <h2 style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
        「Excel 範本」是成績單的第三種輸出方式（原本的 PDF、Word 合併列印都不受影響，三種並存）。
        跟 Word 合併列印不同：這裡不是重畫版面，是<strong>直接把資料填進您上傳的這份 Excel 檔案</strong>，
        版面、顏色、框線、公式完全保留原樣，下載回來的檔案打開就跟您在 Excel 裡看到的一模一樣。
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{ padding: '8px 16px', fontSize: 13, border: '1px solid #2C6E9E', background: '#fff', color: '#2C6E9E', borderRadius: 6 }}
        >
          {downloading ? '下載中…' : '↓ 下載目前範本（.xlsx）'}
        </button>
        <label
          style={{
            padding: '8px 16px',
            fontSize: 13,
            border: '1px solid #2C6E9E',
            background: uploading ? '#eee' : '#fff',
            color: '#2C6E9E',
            borderRadius: 6,
            cursor: uploading ? 'default' : 'pointer',
          }}
        >
          {uploading ? '上傳中…' : '↑ 上傳自訂範本（.xlsx）'}
          <input type="file" accept=".xlsx" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
        </label>
        <button
          onClick={handleRevert}
          disabled={reverting}
          style={{ padding: '8px 16px', fontSize: 13, border: '1px solid #999', background: '#fff', color: '#666', borderRadius: 6 }}
        >
          {reverting ? '還原中…' : '還原成系統預設範本'}
        </button>
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>操作步驟</h3>
      <ol style={{ fontSize: 12.5, color: '#444', lineHeight: 1.9, paddingLeft: 20, marginBottom: 20 }}>
        <li>按「下載目前範本」，用 Excel（或 Google 試算表、LibreOffice Calc）打開。</li>
        <li>
          可以自由調整顏色、框線、字型、加註解、調整公式——但<strong>請盡量不要搬動下方表格裡列出的
          那些儲存格的相對位置</strong>（例如整欄插入/刪除、把科目成績表搬到別的地方），系統是照「固定
          座標」把資料填進去，版面大搬風的話系統會找不到正確位置。單純改顏色、字體、加寬欄位、改文字說明都不受影響。
        </li>
        <li>存檔後，按「上傳自訂範本」選剛剛存的 .xlsx。系統會先確認檔案裡有「成績外」「成績內」這兩個分頁才會生效。</li>
        <li>之後到【班級成績總表】或【批次列印成績單】頁，就會多一個「Excel 範本」按鈕可以使用。</li>
      </ol>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>系統會自動算好、填進去的資料</h3>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
        範本裡「輸入類」的儲存格（科目名稱/分數、出缺勤次數、懲獎次數、操行分數、班級人數/名次、
        導師評語、學生基本資料）系統會覆蓋成真正的資料；範本裡其他的公式儲存格（例如學業平均、
        操行等第、升留級判斷、全勤判斷）完全不會動，開啟檔案時會自動依照新填入的資料重新計算。
      </p>

      <TagTable
        title="外頁（成績外分頁）"
        rows={[
          ['B7', '年級＋班級，例如「高三忠班」'],
          ['B8', '學生姓名'],
          ['B9', '座號'],
          ['B10', '學號'],
        ]}
      />
      <TagTable
        title="內頁抬頭（成績內分頁）"
        rows={[
          ['K1 / N1', '學年度 / 學期'],
          ['C2 / N2', '學號 / 姓名'],
          ['P2 / Q2 / R2', '年級 / 班級 / 座號'],
          ['U6', '列印日期'],
        ]}
      />
      <TagTable
        title="科目成績（第6~15列，固定10列，科目不夠的班級後面留空白；第16列固定是「出缺席」）"
        rows={[
          ['A欄 / B欄', '科目名稱 / 比重'],
          ['C~E欄（上學期）、G~I欄（下學期）', '期中 / 期末 / 平時'],
          ['第17列', '學業平均（範本公式自動算）'],
        ]}
      />
      <TagTable
        title="操行成績（第19~22列）"
        rows={[
          ['C欄（上學期）、G欄（下學期）', '禮貌／衣著／服務／紀律'],
          ['第18列 E欄／I欄', '操行等第（優/甲/乙/丙/丁，系統算好直接填入文字）'],
        ]}
      />
      <TagTable
        title="出席記錄／懲獎記錄（第5~10列）、班級人數/名次（第11~12列）"
        rows={[
          ['N欄（上學期）、O欄（下學期）', '出席記錄次數：曠課/遲到/病假/事假/公假'],
          ['R欄（上學期）、S欄（下學期）', '懲獎記錄次數：嘉獎/小功/大功/警告/小過/大過'],
          ['P11 / P12', '班級人數：上學期 / 下學期'],
          ['T11 / T12', '班級名次：上學期 / 下學期'],
        ]}
      />
      <TagTable title="導師評語" rows={[['C23', '導師評語文字']]} />
    </div>
  );
}

function TagTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{title}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {rows.map(([tag, desc]) => (
            <tr key={tag}>
              <td style={{ border: '1px solid #eee', padding: '4px 8px', width: '35%', fontFamily: 'monospace', color: '#2C6E9E' }}>{tag}</td>
              <td style={{ border: '1px solid #eee', padding: '4px 8px', color: '#666' }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
