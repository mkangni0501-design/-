import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { CertificateDocument, AppointmentDocument } from '@/lib/TeacherLetterPdfDocuments';
import { CertificateContent, AppointmentContent } from '@/lib/teacherLetterContent';

// 【2026-08-19 新增】原本「在職證明／自聘教師聘書／當年教師聘書」的 PDF 都是在瀏覽器端
// 直接呼叫 `pdf(<CertificateDocument .../>).toBlob()` 產生的（見
// components/dev-tools/TeacherLettersPanel.tsx）——問題是 lib/pdfFonts.ts 的中文字型
// 註冊用的是 Node.js 專用的 `path.join(process.cwd(), 'public', 'fonts', ...)`，這段
// 程式碼在瀏覽器裡執行時，`process.cwd()`／檔案系統路徑完全不是同一回事，react-pdf
// 拿到的字型來源會是一個瀏覽器抓不到正確二進位內容的來源，fontkit 解析失敗，就是
// 「Unknown font format」這個錯誤的根因。
// 成績單的 PDF（lib/ReportCardDocument.tsx）本來就是走伺服器端 API Route
// （app/api/reports/report-card/[enrollmentId]/route.tsx）用 renderToBuffer 產生，
// 完全沒有這個問題（這輪已經實際測試驗證過）——這裡讓聘書/證明信也改成同一套
// 「伺服器端產生 PDF」的作法，順便解決「沒有直接列印功能」（原本永遠是強制下載
// 一個檔案，不會在瀏覽器分頁裡開啟可以直接列印的PDF預覽）。
//
// 權限判斷比照 app/(app)/admin/dev-tools/page.tsx 頁面本身的判斷方式（只有系統管理員
// 或「開發人員」部門的帳號能用這個功能）。

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  const { data: appUser } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).maybeSingle();
  const isSystemAdmin = appUser?.role === 'system_admin_s';
  const { data: deptRow } = await supabaseAdmin
    .from('app_user_departments')
    .select('department')
    .eq('app_user_id', callerAuth.user.id)
    .eq('department', 'dev')
    .maybeSingle();
  if (!isSystemAdmin && !deptRow) {
    return NextResponse.json({ error: '沒有權限使用這個功能' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || (body.kind !== 'certificate' && body.kind !== 'appointment')) {
    return NextResponse.json({ error: '缺少或格式錯誤的請求內容' }, { status: 400 });
  }

  try {
    const buffer =
      body.kind === 'certificate'
        ? await renderToBuffer(<CertificateDocument data={body.content as CertificateContent} />)
        : await renderToBuffer(<AppointmentDocument data={body.content as AppointmentContent} />);
    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(body.fileBase ?? 'document')}.pdf"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'PDF 產生失敗：' + (err?.message ?? String(err)) }, { status: 500 });
  }
}
