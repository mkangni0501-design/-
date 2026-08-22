import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardDocument } from '@/lib/ReportCardDocument';
import { getReportCardResult, canAccessClass, getActiveReportCardStyle } from '@/lib/reportCard';

export async function GET(req: NextRequest, { params }: { params: { enrollmentId: string } }) {
  const enrollmentId = params.enrollmentId;

  // ---- 1. 驗證呼叫者身份與權限（只有該班導師與教務部門可以產出成績單） ----
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('classes(id)')
    .eq('id', enrollmentId)
    .single();
  if (!enrollment) return NextResponse.json({ error: '找不到學籍資料' }, { status: 404 });

  const classId = (enrollment as any).classes.id as string;
  const allowed = await canAccessClass(callerAuth.user.id, classId);
  if (!allowed) return NextResponse.json({ error: '沒有權限產出此成績單' }, { status: 403 });

  // ---- 2. 組資料（跟批次列印共用同一份邏輯，規則異動只要改 lib/reportCard.ts 一處） ----
  const result = await getReportCardResult(enrollmentId);
  // 用 'reason' in result 判斷、不要用 !result.ready：這個專案 tsconfig 的 strict:false
  // 會讓 TypeScript 對「用 boolean 欄位(ready)做判別」的 union type 沒辦法正確窄化型別
  // （這是 TS 在 strictNullChecks 關閉時的已知限制，不是這裡邏輯有錯），
  // 用屬性是否存在來判斷則不受影響，兩種寫法在執行期的行為是一樣的。
  if ('reason' in result) {
    return NextResponse.json(
      { error: '尚未能產出正式成績單', reason: result.reason },
      { status: 409 }
    );
  }

  const styleConfig = await getActiveReportCardStyle();
  const pdfBuffer = await renderToBuffer(<ReportCardDocument data={result.data} styleConfig={styleConfig} />);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="report-card-${result.studentNo}.pdf"`,
    },
  });
}
