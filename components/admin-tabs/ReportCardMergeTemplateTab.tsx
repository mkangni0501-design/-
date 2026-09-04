'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// 成績單「合併列印（Word）」範本管理頁：對應反映事項「把成績單系統的顯示改成用
// EXCEL/WORD合併列印的方式，讓我上傳提供樣本修改」。
//
// 用法：
//   1. 先按「下載目前範本」拿到一份 .docx（第一次還沒上傳過自訂範本時，拿到的是
//      系統內建的預設範本，版面照著「成績單正反.xlsx」樣本重排過）。
//   2. 在 Word 裡自由調整版面、字體、顏色、要放哪些欄位——範本裡的 {{...}} 就是
//      「合併欄位」，代表列印時會被換成真正資料的地方（完整清單見下面「可用合併
//      欄位」）；千萬不要把 {{ }} 這對符號拆開或打錯字，不然上傳時會被擋下來。
//   3. 改好存檔後，按「上傳自訂範本」選剛剛存的 .docx，系統會先檢查格式沒問題
//      （合併欄位/迴圈都有正確成對）才會生效。
//   4. 之後在【班級成績總表】／【批次列印成績單】頁按「Word 合併列印」，就會套用
//      這份範本。
// PDF 列印（原本的功能）完全不受影響，這是新增的第二種輸出方式，兩種並存、
// 使用者列印時自己選。
export default function ReportCardMergeTemplateTab() {
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
      const res = await fetch('/api/reports/report-card-merge-template', { headers: await authHeader() });
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
      a.download = isCustom ? '成績單合併列印範本.docx' : '成績單合併列印範本(系統預設).docx';
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
    if (!file.name.toLowerCase().endsWith('.docx')) {
      alert('請上傳 .docx 格式的 Word 檔案（不是 .doc 舊格式，也不是 .xlsx）');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/reports/report-card-merge-template', {
        method: 'POST',
        headers: await authHeader(),
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('上傳失敗：' + (body.error ?? res.status));
        return;
      }
      alert('已上傳並生效，之後的「Word 合併列印」會套用這份範本。');
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
      const res = await fetch('/api/reports/report-card-merge-template', { method: 'DELETE', headers: await authHeader() });
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
        「Word 合併列印」是成績單的第二種輸出方式（原本的 PDF 列印不受影響，兩種並存）。
        版面完全由您在 Word 裡自己設計，系統只負責把每位學生的資料套進範本裡的合併欄位。
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{ padding: '8px 16px', fontSize: 13, border: '1px solid #2C6E9E', background: '#fff', color: '#2C6E9E', borderRadius: 6 }}
        >
          {downloading ? '下載中…' : '↓ 下載目前範本（.docx）'}
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
          {uploading ? '上傳中…' : '↑ 上傳自訂範本（.docx）'}
          <input type="file" accept=".docx" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
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
        <li>按「下載目前範本」，用 Microsoft Word 打開。</li>
        <li>
          自由調整版面、字體、顏色、要放哪些欄位——範本裡的 <code>{'{{...}}'}</code> 就是「合併欄位」，
          代表列印時會被換成真正資料的地方，完整清單見下方表格。可以移動位置、改字型/顏色/表格樣式，
          但 <code>{'{{'}</code> 跟 <code>{'}}'}</code> 這對符號本身、以及裡面的欄位名稱不要打錯字或拆開，
          否則系統會看不懂而擋下上傳。
        </li>
        <li>存檔後，按「上傳自訂範本」選剛剛存的 .docx。系統會先檢查格式，有問題會直接告訴您哪裡需要修正。</li>
        <li>之後到【班級成績總表】或【批次列印成績單】頁，就會多一個「Word 合併列印」按鈕可以使用。</li>
      </ol>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>常見問題：上傳失敗，出現「格式有誤」</h3>
      <div style={{ fontSize: 12.5, color: '#444', lineHeight: 1.9, marginBottom: 20, background: '#FBF6EC', border: '1px solid #E8D9B5', borderRadius: 8, padding: '10px 14px' }}>
        <p style={{ marginBottom: 6 }}>
          上傳失敗時，錯誤訊息裡會直接告訴您可以怎麼處理；以下是兩種最常見的原因：
        </p>
        <p style={{ marginBottom: 6 }}>
          <strong>1. 「Unbalanced loop tags」（兩組迴圈標籤沒辦法確定範圍）：</strong>
          通常是因為兩個表格（例如「出席記錄」跟「懲獎記錄」）被<strong>並排</strong>放在同一列（左右兩欄），
          之後又在 Word 裡調整過附近的表格。請改成<strong>上下堆疊</strong>放（一個表格接著下一個表格，不要放在同一列），
          系統目前的預設範本已經是這種排法，最快的方式是重新下載一次最新的範本，再把您要的調整貼進去。
        </p>
        <p style={{ marginBottom: 0 }}>
          <strong>2. 標籤被拆散（系統通常會自動修好）：</strong>
          在合併欄位 <code>{'{{...}}'}</code> 附近打字、選字選一半時，Word 有時會把同一段文字悄悄拆成好幾段，
          系統上傳時會先自動嘗試修補；如果修補後仍然失敗，代表拆得比較嚴重，請把整個 <code>{'{{...}}'}</code> 標籤刪掉重新輸入
          （中途不要暫停、不要用注音/拼音選字選一半）。
        </p>
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 8 }}>可用合併欄位</h3>
      <p style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
        不需要每個欄位都用到，範本裡沒放的欄位就不會出現在成績單上。
      </p>

      <TagTable
        title="基本資料（單一欄位）"
        rows={[
          ['{{學校}}', '學校名稱'],
          ['{{學年度}}', '例如 2862'],
          ['{{學期}}', '上學期／下學期'],
          ['{{年級}}', '例如 高三'],
          ['{{班級}}', '例如 忠班'],
          ['{{學號}}', ''],
          ['{{姓名}}', ''],
          ['{{座號}}', ''],
          ['{{列印日期}}', ''],
          ['{{導師評語}}', ''],
          ['{{升留級}}', '升級／留級／空白（只有下學期成績單才會判斷）'],
          ['{{上學期全勤}}／{{下學期全勤}}', '是／空白'],
          ['{{上學期班級人數}}／{{下學期班級人數}}', ''],
          ['{{上學期班級名次}}／{{下學期班級名次}}', ''],
          ['{{上學期操行等第}}／{{下學期操行等第}}', '優／甲／乙／丙／丁'],
        ]}
      />

      <TagTable
        title="科目成績表格（迴圈：{{#科目}}…{{/科目}}）"
        rows={[
          ['{{科目名稱}}', ''],
          ['{{比重}}', ''],
          ['{{上期中}}／{{上期末}}／{{上平時}}／{{上總分}}', '上學期各項分數'],
          ['{{下期中}}／{{下期末}}／{{下平時}}／{{下總分}}', '下學期各項分數'],
          ['{{全年平均}}', ''],
        ]}
      />

      <TagTable
        title="學業平均（獨立欄位，不是迴圈——系統已經依各科比重加權平均算好，直接對應下面這幾個欄位即可）"
        rows={[
          ['{{學業平均上期中}}／{{學業平均上期末}}／{{學業平均上平時}}／{{學業平均上總分}}', '上學期'],
          ['{{學業平均下期中}}／{{學業平均下期末}}／{{學業平均下平時}}／{{學業平均下總分}}', '下學期'],
          ['{{學業平均全年平均}}', ''],
        ]}
      />

      <TagTable
        title="出席記錄／懲獎記錄表格（迴圈：{{#出席記錄}}…{{/出席記錄}}、{{#懲獎記錄}}…{{/懲獎記錄}}）"
        rows={[
          ['{{項目}}', '曠課/遲到/病假/事假/公假，或 嘉獎/小功/大功/警告/小過/大過'],
          ['{{上學期數}}／{{下學期數}}／{{合計}}', ''],
        ]}
      />

      <TagTable
        title="操行成績表格（迴圈：{{#操行成績}}…{{/操行成績}}——含「獎懲加扣分」「操行總分」，操行總分＝禮貌/衣著/服務/紀律平均＋獎懲加扣分）"
        rows={[
          ['{{項目}}', '禮貌/衣著/服務/紀律/獎懲加扣分/操行總分'],
          ['{{上學期分數}}／{{下學期分數}}／{{全學年分數}}', ''],
        ]}
      />

      <TagTable
        title="外頁政策說明（單一欄位，資料來自後台目前設定，會自動更新）"
        rows={[
          ['{{期中比重}}／{{期末比重}}／{{平時比重}}／{{出缺席佔比}}', ''],
          ['{{嘉獎加分}}／{{警告扣分}}／{{小功加分}}／{{小過扣分}}／{{大功加分}}／{{大過扣分}}', ''],
        ]}
      />
      <TagTable
        title="出缺席加扣分規則表格（迴圈：{{#出缺席規則}}…{{/出缺席規則}}）"
        rows={[
          ['{{項目}}', '全勤/曠課/遲到/事假/病假/公假'],
          ['{{原始分數}}／{{佔總分比例}}', ''],
        ]}
      />
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
              <td style={{ border: '1px solid #eee', padding: '4px 8px', width: '45%', fontFamily: 'monospace', color: '#2C6E9E' }}>{tag}</td>
              <td style={{ border: '1px solid #eee', padding: '4px 8px', color: '#666' }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
