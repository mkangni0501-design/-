// 批次列印成績單。
//   導師：body 只能放自己帶的那一班 classIds（送別班會被擋下來）
//   教務部門：classIds 可以放多班，或整個學年年級／全校
//
// 用法：POST，body 帶 { "classIds": ["班級id1", "班級id2", ...] }
//   可加 query string ?skipIncomplete=true
//     - 不加：只要班上有任何一個學生還沒三項都鎖定，整批都不產出，回傳 409 + 名單
//     - 加了：自動跳過還沒鎖定的學生，其餘照印，回應標頭會列出被跳過的名單
//
// 需要 npm install pdf-lib（用來把每個學生各自產生的 PDF 合併成一份，見 package.json）

import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { PDFDocument } from 'pdf-lib';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardDocument } from '@/lib/ReportCardDocument';
import { getReportCardResult, canAccessClass } from '@/lib/reportCard';

export async function POST(req: NextRequest) {
  const { classIds } = await req.json();
  if (!Array.isArray(classIds) || classIds.length === 0) {
    return NextResponse.json({ error: '請至少指定一個班級' }, { status: 400 });
  }

  const skipIncomplete = req.nextUrl.searchParams.get('skipIncomplete') === 'true';

  // ---- 1. 驗證身分 ----
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  // ---- 2. 逐班檢查權限（導師只能印自己班，教務部門不限） ----
  for (const classId of classIds) {
    const allowed = await canAccessClass(callerAuth.user.id, classId);
    if (!allowed) {
      return NextResponse.json({ error: `沒有權限列印班級 ${classId} 的成績單` }, { status: 403 });
    }
  }

  // ---- 3. 撈出這些班級、依班級→座號排序的所有學生 ----
  const { data: enrollments } = await supabaseAdmin
    .from('enrollments')
    .select('id, seat_no, class_id')
    .in('class_id', classIds)
    .order('class_id', { ascending: true })
    .order('seat_no', { ascending: true });

  if (!enrollments || enrollments.length === 0) {
    return NextResponse.json({ error: '這些班級目前沒有在籍學生' }, { status: 404 });
  }

  // ---- 4. 逐一組資料，區分「可以印」跟「還沒鎖定不能印」 ----
  const notReady: { studentNo: string; studentName: string; reason: string }[] = [];
  const readyList: { enrollmentId: string; studentNo: string; studentName: string }[] = [];

  for (const en of enrollments) {
    const result = await getReportCardResult(en.id);
    // 用 'reason' in result 判斷、不要用 !result.ready：見上方 [enrollmentId]/route.tsx 的說明
    // （這個專案 tsconfig 的 strict:false 會讓 boolean 欄位當判別式的窄化失效）。
    if ('reason' in result) {
      notReady.push({ studentNo: result.studentNo, studentName: result.studentName, reason: result.reason });
    } else {
      readyList.push({ enrollmentId: en.id, studentNo: result.studentNo, studentName: result.studentName });
    }
  }

  if (notReady.length > 0 && !skipIncomplete) {
    return NextResponse.json(
      {
        error: '有學生的期中/期末/平時分尚未三項都鎖定，尚不能產出正式成績單',
        notReady,
        hint: '確認可以先出「已完成」的部分，可在網址加上 ?skipIncomplete=true',
      },
      { status: 409 }
    );
  }

  if (readyList.length === 0) {
    return NextResponse.json({ error: '目前沒有任何學生可以產出成績單', notReady }, { status: 409 });
  }

  // ---- 5. 逐一產生 PDF，再合併成一份 ----
  const mergedPdf = await PDFDocument.create();

  for (const item of readyList) {
    const result = await getReportCardResult(item.enrollmentId);
    if ('reason' in result) continue; // 理論上不會發生，防呆用
    const pdfBuffer = await renderToBuffer(<ReportCardDocument data={result.data} />);
    const singlePdf = await PDFDocument.load(pdfBuffer);
    const copiedPages = await mergedPdf.copyPages(singlePdf, singlePdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  const mergedBytes = await mergedPdf.save();

  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="report-cards-batch.pdf"`,
    'X-Total-Printed': String(readyList.length),
  };
  if (notReady.length > 0) {
    // 跳過的名單放在標頭裡，前端可以讀出來顯示提醒（例如「王小明等3人尚未鎖定，未列入」）
    headers['X-Skipped-Students'] = encodeURIComponent(JSON.stringify(notReady));
  }

  return new NextResponse(new Uint8Array(mergedBytes), { headers });
}
