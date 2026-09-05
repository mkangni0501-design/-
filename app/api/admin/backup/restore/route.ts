import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { restoreBackup, parseUploadedSnapshot, countsFromSnapshot, BackupSnapshot } from '@/lib/backupRestore';

// 還原本身（尤其上傳大檔案那條路徑：從 Storage 下載、parse、逐表刪除/插入）
// 可能需要比預設更久的執行時間。
export const maxDuration = 300;

// 還原備份會整批覆蓋校務資料（學生、班級、成績、出缺勤...等），影響範圍非常大，
// 所以只開放系統管理員S本人可以執行，而且要求前端先做過「輸入確認文字」那一關才會呼叫這支API。
//
// 支援兩種還原來源（前端二選一，一次只會帶其中一種）：
// 1. backupId：跟原本一樣，從 backups 表挑一筆現有紀錄來還原。
// 2. uploadPath：新增的「上傳檔案還原」，給沒有任何 backups 紀錄可以選的情境用
//    （例如換了全新的 Supabase 專案、或這個環境的 backups 表本身是空的，但手上
//    還留著先前用「下載」按鈕存下來的備份 JSON 檔）。前端會先把檔案直接上傳到
//    Storage 的 backup-uploads 這個 bucket（見 sql/79backup_timeout_and_upload_restore.sql），
//    這裡再用 service role 把檔案讀出來還原——不直接把檔案內容塞進這支 API 的
//    請求本文，是因為 Vercel Serverless Function 的請求本文大小上限是 4.5MB，
//    全校資料的備份檔很容易超過。
export async function POST(req: NextRequest) {
  let uploadPathToCleanUp: string | null = null;
  try {
    const body = (await req.json()) as { backupId?: string; uploadPath?: string };
    const { backupId, uploadPath } = body;
    if (!backupId && !uploadPath) {
      return NextResponse.json({ error: '缺少 backupId 或 uploadPath' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: '未登入' }, { status: 401 });
    }
    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) {
      return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
    }
    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (!callerProfile || callerProfile.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以執行還原' }, { status: 403 });
    }

    let snapshot: BackupSnapshot;
    let targetBackupId: string;

    if (uploadPath) {
      uploadPathToCleanUp = uploadPath;
      const { data: fileBlob, error: downloadErr } = await supabaseAdmin.storage.from('backup-uploads').download(uploadPath);
      if (downloadErr || !fileBlob) {
        return NextResponse.json({ error: '讀取上傳的檔案失敗：' + (downloadErr?.message ?? '未知錯誤') }, { status: 400 });
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(await fileBlob.text());
      } catch {
        return NextResponse.json({ error: '上傳的檔案不是有效的 JSON，請確認上傳的是「下載」按鈕匯出的備份檔' }, { status: 400 });
      }
      const parsed = parseUploadedSnapshot(parsedJson);
      if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      snapshot = parsed.snapshot;

      // 把上傳的內容存一份進 backups 表（kind = '上傳'）留稽核紀錄，也讓這份資料
      // 從此變成「這個系統裡有的第一筆備份紀錄」，之後可以直接在清單上看到/下載/
      // 再次還原，不用每次都重新上傳檔案。理由與寫入方式（拉長 statement_timeout）
      // 見 sql/79backup_timeout_and_upload_restore.sql。
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .rpc('admin_insert_backup', {
          p_kind: '上傳',
          p_created_by: callerAuth.user.id,
          p_tables: snapshot,
          p_table_counts: countsFromSnapshot(snapshot),
        })
        .single();
      if (insertErr || !inserted) {
        return NextResponse.json({ error: '上傳檔案已讀取，但存成備份紀錄失敗：' + (insertErr?.message ?? '未知錯誤') }, { status: 500 });
      }
      targetBackupId = inserted.id;
    } else {
      const { data: backupRow, error: backupErr } = await supabaseAdmin.from('backups').select('tables').eq('id', backupId).single();
      if (backupErr || !backupRow) {
        return NextResponse.json({ error: '找不到這筆備份' }, { status: 404 });
      }
      snapshot = backupRow.tables as BackupSnapshot;
      targetBackupId = backupId as string;
    }

    const result = await restoreBackup(supabaseAdmin, snapshot);

    await supabaseAdmin
      .from('backups')
      .update({ restored_at: new Date().toISOString(), restored_by: callerAuth.user.id })
      .eq('id', targetBackupId);

    return NextResponse.json({ success: result.errors.length === 0, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  } finally {
    // 上傳的檔案內容已經存進 backups 表（或還原失敗，反正這份暫存檔都不再需要），
    // 不管成功失敗都從 Storage 刪掉，避免佔用空間、也避免留著一份完整校務資料
    // 在 Storage 裡沒人管。
    if (uploadPathToCleanUp) {
      await supabaseAdmin.storage.from('backup-uploads').remove([uploadPathToCleanUp]);
    }
  }
}
