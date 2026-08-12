import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardDocument } from '@/lib/ReportCardDocument';
import { getReportCardResult, canAccessClass } from '@/lib/reportCard';

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
  if (!result.ready) {
    return NextResponse.json(
      { error: '尚未能產出正式成績單', reason: result.reason },
      { status: 409 }
    );
  }

  const pdfBuffer = await renderToBuffer(<ReportCardDocument data={result.data} />);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="report-card-${result.studentNo}.pdf"`,
    },
  });
}
