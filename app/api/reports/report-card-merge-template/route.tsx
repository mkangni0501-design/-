import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadDefaultXlsxTemplateBuffer, validateXlsxTemplate } from '@/lib/reportCardXlsxTemplate';

// 成績單「直接套用 Excel 範本」的下載／上傳／還原預設。跟
// app/api/reports/report-card-merge-template/route.tsx（Word 範本）是同一套
// 邏輯，複製過來改成 .xlsx／report_card_xlsx_template 表——這裡故意獨立成
// 一支新的 API，不是想辦法讓舊的 Word 範本上傳也收 .xlsx（兩種檔案格式的
// 驗證方式不一樣，混在一起更難維護，也是這次「上傳 xlsx 被擋下來」問題的
// 根源：舊功能本來就只認 .docx）。
//   GET    ：下載目前生效中的範本，任何已登入者都能下載。
//   POST   ：上傳新範本（multipart/form-data，欄位名稱 file），只有管理員能上傳。
//   DELETE ：還原成系統內建預設範本，只有管理員能操作。

async function requireAdmin(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
  if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
    return NextResponse.json({ error: '只有管理員能管理成績單 Excel 範本' }, { status: 403 });
  }
  return { userId: callerAuth.user.id };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });
  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  const { data } = await supabaseAdmin
    .from('report_card_xlsx_template')
    .select('file_name, file_data')
    .eq('is_active', true)
    .maybeSingle();

  let buffer: Buffer;
  let fileName: string;
  if (data?.file_data) {
    const hex = (data.file_data as string).replace(/^\\x/, '');
    buffer = Buffer.from(hex, 'hex');
    fileName = data.file_name || '成績單Excel範本.xlsx';
  } else {
    buffer = loadDefaultXlsxTemplateBuffer();
    fileName = '成績單Excel範本(預設).xlsx';
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'X-Is-Custom-Template': data?.file_data ? 'true' : 'false',
    },
  });
}

export async function POST(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const formData = await req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: '請上傳一個 .xlsx 檔案' }, { status: 400 });
  }
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const validation = await validateXlsxTemplate(buffer);
  if ('error' in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  // 整個學校同時只有一份生效中的自訂範本（跟 Word 範本／report_card_style 做法一樣）。
  await supabaseAdmin.from('report_card_xlsx_template').update({ is_active: false }).eq('is_active', true);
  const { error } = await supabaseAdmin.from('report_card_xlsx_template').insert({
    file_name: (file as File).name || '成績單Excel範本.xlsx',
    file_data: '\\x' + buffer.toString('hex'),
    is_active: true,
    updated_by: null,
  });
  if (error) return NextResponse.json({ error: '儲存失敗：' + error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  await supabaseAdmin.from('report_card_xlsx_template').update({ is_active: false }).eq('is_active', true);
  return NextResponse.json({ ok: true });
}
