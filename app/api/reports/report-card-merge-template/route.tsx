import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadDefaultTemplateBuffer, validateDocxTemplate } from '@/lib/reportCardDocxTemplate';

// 成績單「合併列印（Word）」範本的下載／上傳／還原預設。
//   GET    ：下載目前生效中的範本（還沒上傳過自訂範本的話，下載到系統內建預設範本）。
//            任何已登入者都能下載（跟看到成績單本身的權限不綁在一起，範本檔案內容不含
//            任何學生資料，只是空白版面），方便管理員先確認「現在用的到底是哪一份」。
//   POST   ：上傳新範本（multipart/form-data，欄位名稱 file），只有管理員能上傳。
//   DELETE ：還原成系統內建預設範本（把資料庫裡的自訂範本都設成非生效中），只有管理員能操作。
//
// bytea 欄位在 supabase-js／PostgREST 讀出來是 "\x48656c6c6f..." 這種十六進位字串
// （開頭 \x），寫入時也要用同樣格式的字串（不能直接塞 Buffer 物件），下面 hex 轉換
// 都是為了這個。

async function requireAdmin(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const { data: callerAuth } = await supabaseAdmin.auth.getUser(token);
  if (!callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

  const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
  if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
    return NextResponse.json({ error: '只有管理員能管理成績單合併列印範本' }, { status: 403 });
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
    .from('report_card_merge_template')
    .select('file_name, file_data')
    .eq('is_active', true)
    .maybeSingle();

  let buffer: Buffer;
  let fileName: string;
  if (data?.file_data) {
    const hex = (data.file_data as string).replace(/^\\x/, '');
    buffer = Buffer.from(hex, 'hex');
    fileName = data.file_name || '成績單合併列印範本.docx';
  } else {
    buffer = loadDefaultTemplateBuffer();
    fileName = '成績單合併列印範本(預設).docx';
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
    return NextResponse.json({ error: '請上傳一個 .docx 檔案' }, { status: 400 });
  }
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 這個專案 tsconfig 的 strict:false 會讓 TypeScript 對「用 boolean 欄位(ok)做判別」
  // 的 union type 沒辦法正確窄化型別（跟 lib/reportCard.ts 的 ReportCardResult 是
  // 同一種已知限制，不是這裡邏輯有錯），用屬性是否存在來判斷則不受影響。
  const validation = validateDocxTemplate(buffer);
  if ('error' in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  // 整個學校同時只有一份生效中的自訂範本（跟 report_card_style 的做法一樣）。
  await supabaseAdmin.from('report_card_merge_template').update({ is_active: false }).eq('is_active', true);
  const { error } = await supabaseAdmin.from('report_card_merge_template').insert({
    file_name: (file as File).name || '成績單合併列印範本.docx',
    // 存「修補過」的版本（見 lib/reportCardDocxTemplate.ts 的 repairTemplateBuffer
    // 說明：修好 Word 編輯時把合併欄位標籤無聲拆散的常見問題），不是存使用者原始
    // 上傳的那份，這樣以後每次列印都不用再重複修補一次。
    file_data: '\\x' + validation.repairedBuffer.toString('hex'),
    is_active: true,
    updated_by: null, // teachers.id 跟 app_users.id 不是同一組 id，這裡沒有現成對照，先留空不影響功能
  });
  if (error) return NextResponse.json({ error: '儲存失敗：' + error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  await supabaseAdmin.from('report_card_merge_template').update({ is_active: false }).eq('is_active', true);
  return NextResponse.json({ ok: true });
}
