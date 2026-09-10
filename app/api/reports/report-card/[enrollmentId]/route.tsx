import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ReportCardDocument } from '@/lib/ReportCardDocument';
import { getReportCardResult, canAccessClass, getActiveReportCardStyle } from '@/lib/reportCard';
import { getActiveTemplateBuffer, mergeReportCardDocx } from '@/lib/reportCardDocxTemplate';
import { getActiveXlsxTemplateBuffer, fillReportCardXlsx } from '@/lib/reportCardXlsxTemplate';

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

  // 【本輪新增】反映事項「休學/轉學/退學的學生，只能在管理者視角下看到，
  // 其他視角皆無法顯示」——canAccessClass() 檢查的是「有沒有權限管這個班」
  // （導師／教務／管理員），沒有另外檢查「這位學生本人是不是已經是隱藏名單」。
  // 已休學/轉學/退學的學生，enrollments 紀錄本身會保留（座號不釋放，見
  // sql/61 的說明），所以他最後所屬班級的導師，理論上還是能透過這支 API
  // 印出他個人的成績單——這裡另外擋一次：非真管理員身分時，如果這位學生已經
  // 是隱藏名單，直接回絕。
  const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).maybeSingle();
  const isTrueAdmin = !!callerProfile && ['admin_a', 'admin_b', 'system_admin_s'].includes(callerProfile.role);
  if (!isTrueAdmin) {
    const { data: studentNoRow } = await supabaseAdmin.from('enrollments').select('student_no').eq('id', enrollmentId).maybeSingle();
    if (studentNoRow) {
      const { data: hiddenCheck } = await supabaseAdmin.rpc('student_is_hidden', { p_student_no: studentNoRow.student_no });
      if (hiddenCheck) return NextResponse.json({ error: '這位學生的學籍狀態已異動，只有管理員能產出其成績單' }, { status: 403 });
    }
  }

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

  // ---- 3. 輸出格式：預設是原本的 PDF（react-pdf），加上 ?format=docx 改成「Word
  // 合併列印」，?format=xlsx 改成「直接套用學校 Excel 範本」——用管理員上傳的
  // 範本（沒上傳過就用內建預設範本，就是學校提供的那份 Excel 檔案）。三種格式
  // 資料來源完全一樣，只是排版引擎不同，PDF 那條路徑完全沒被動到。----
  const format = req.nextUrl.searchParams.get('format');
  if (format === 'xlsx') {
    const templateBuffer = await getActiveXlsxTemplateBuffer();
    let xlsxBuffer: Buffer;
    try {
      xlsxBuffer = await fillReportCardXlsx(templateBuffer, result.data);
    } catch (err: any) {
      return NextResponse.json({ error: '套用 Excel 範本失敗：' + (err?.message ?? String(err)) }, { status: 500 });
    }
    return new NextResponse(new Uint8Array(xlsxBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="report-card-${result.studentNo}.xlsx"`,
      },
    });
  }
  if (format === 'docx') {
    const templateBuffer = await getActiveTemplateBuffer();
    let docxBuffer: Buffer;
    try {
      docxBuffer = mergeReportCardDocx(templateBuffer, result.data);
    } catch (err: any) {
      return NextResponse.json({ error: '合併列印範本套用失敗：' + (err?.message ?? String(err)) }, { status: 500 });
    }
    return new NextResponse(new Uint8Array(docxBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="report-card-${result.studentNo}.docx"`,
      },
    });
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
