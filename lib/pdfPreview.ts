// 共用工具：把「已經用 window.open('', '_blank') 開好的空白分頁」換成內嵌 PDF 的畫面。
//
// 【問題】原本各處都是 `printWindow.location.href = URL.createObjectURL(blob)`，
// 這樣做等於把整個分頁「導向」到 blob: 網址，瀏覽器網址列就會變成一長串
// `blob:https://.../7025b736-...` 這種內部識別碼，使用者每次列印成績單都會看到，
// 容易誤以為系統壞掉、網址跑掉了。
//
// 【修正】不要導向（navigate）分頁本身，而是在同一個分頁裡用 <iframe> 內嵌 blob 網址。
// 分頁本身的網址維持在開啟當下的 about:blank，不會被換成 blob:...，PDF 內容一樣
// 看得到、也一樣印得出來（瀏覽器的列印功能會印 iframe 裡的內容）。
export function showPdfInWindow(printWindow: Window, blob: Blob, title = '列印預覽') {
  const blobUrl = URL.createObjectURL(blob);
  printWindow.document.open();
  printWindow.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>html,body{margin:0;height:100%;overflow:hidden;}iframe{border:none;width:100%;height:100%;}</style>` +
      `</head><body><iframe src="${blobUrl}"></iframe></body></html>`
  );
  printWindow.document.close();
  // 這裡刻意不呼叫 URL.revokeObjectURL：iframe 還要用這個網址載入 PDF，
  // 太早釋放會讓 PDF 顯示失敗。分頁關閉後瀏覽器會自動回收，不用擔心洩漏。
}
