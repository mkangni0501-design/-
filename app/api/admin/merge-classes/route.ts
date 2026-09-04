import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 同一個班如果被系統記成兩筆不同的 classes 資料（例如「高三」「忠班」其實是同一班，
// 分別從排課系統匯入跟一鍵上傳/手動新增各自建出一筆），會導致學生名單、課表、成績分散在
// 兩個不同的 classes.id 上。這支 API 把「要合併掉的那幾筆」所有參照都改指到「要保留的那一筆」，
// 再把多餘的資料刪掉。跟 merge-teachers 是同一套做法。
//
// ⚠️ 這份清單必須涵蓋「資料庫裡所有外鍵參照到 classes(id) 的欄位」，一個都不能漏——
// 只要漏掉一個，最後一步刪除多餘班級資料時就會因為還有資料表參照著它而被資料庫擋下來
// （外鍵限制），出現「合併時跳出錯誤提示」的狀況（跟 merge-teachers.ts 開頭註解記錄過的
// 同一種問題）。目前資料庫裡只有 enrollments/class_schedule/substitute_assignments
// 這3張表有外鍵參照 classes(id)，日後新增資料表如果也參照 classes(id)，記得也要加進來。
//
// 2026-08-08 修正：「合併班級功能出現錯誤提示」——問題不是漏了表，是「改指到保留那一筆」這
// 一步本身會撞到 unique 限制：兩個要合併的班級通常各自有一份完整的學生名單/課表，座號、
// 上課節次幾乎一定會重複（例如兩邊都有座號1號、星期一第1節），過去撞到 unique 限制的那幾筆
// 會被跳過、不改指，最後刪除多餘班級時，這幾筆「還沒改指成功」的資料仍然參照著要刪除的班級，
// 違反外鍵限制、整個刪除失敗，於是每次合併幾乎都會出現錯誤提示。
// 修正後改成：
//   - enrollments（座號撞到）：不放棄，自動改配到保留那個班級（該學期）目前最大座號之後的
//     下一個座號，學生資料不會遺失，只是座號變動，之後可以再手動調整。
//   - class_schedule／substitute_assignments（節次/代課撞到）：保留那個班級本來就已經有
//     同一個時段的資料了，代表要合併掉那筆是重複資料，直接刪除多餘那筆即可（不會遺失保留
//     那筆的資料）。
// 這樣處理完，要合併掉的班級底下就不會再有任何資料表參照著它，最後的刪除就能順利成功。
const REPOINT_TARGETS: Array<{ table: string; column: string }> = [
  { table: 'enrollments', column: 'class_id' },
  { table: 'class_schedule', column: 'class_id' },
  { table: 'substitute_assignments', column: 'class_id' },
];

export async function POST(req: NextRequest) {
  try {
    const { keepId, mergeIds } = (await req.json()) as { keepId: string; mergeIds: string[] };
    if (!keepId || !mergeIds || mergeIds.length === 0) {
      return NextResponse.json({ error: '缺少 keepId 或 mergeIds' }, { status: 400 });
    }
    if (mergeIds.includes(keepId)) {
      return NextResponse.json({ error: '要保留的那一筆不能同時出現在要合併掉的清單裡' }, { status: 400 });
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
    if (!callerProfile || !['system_admin_s', 'admin_a', 'admin_b'].includes(callerProfile.role)) {
      return NextResponse.json({ error: '沒有權限執行合併' }, { status: 403 });
    }

    const { data: keepRow, error: keepErr } = await supabaseAdmin
      .from('classes')
      .select('id, academic_year, grade_level, class_name, homeroom_teacher_id')
      .eq('id', keepId)
      .single();
    if (keepErr || !keepRow) {
      return NextResponse.json({ error: '找不到要保留的班級資料' }, { status: 404 });
    }
    const { data: mergeRows } = await supabaseAdmin
      .from('classes')
      .select('id, homeroom_teacher_id')
      .in('id', mergeIds);

    // 如果要保留的那筆還沒設定導師，但要合併掉的其中一筆有設定，就把導師轉移過去。
    if (!keepRow.homeroom_teacher_id) {
      const withHomeroom = (mergeRows ?? []).find((r: any) => r.homeroom_teacher_id);
      if (withHomeroom) {
        await supabaseAdmin.from('classes').update({ homeroom_teacher_id: withHomeroom.homeroom_teacher_id }).eq('id', keepId);
      }
    }

    const repointed: Record<string, number> = {};
    const renumbered: Record<string, number> = {};
    const skippedDuplicates: Record<string, number> = {};
    const errors: string[] = [];

    for (const { table, column } of REPOINT_TARGETS) {
      const { data: toMove, error: fetchErr } = await supabaseAdmin.from(table).select('*').in(column, mergeIds);
      if (fetchErr) {
        // 42P01＝資料表不存在：代表該功能對應的 SQL migration 還沒在這個環境執行過，
        // 不算合併失敗，安靜略過即可，不用嚇到使用者說「合併出錯」。
        if ((fetchErr as any).code !== '42P01') errors.push(`讀取 ${table} 失敗：${fetchErr.message}`);
        continue;
      }
      let moved = 0;
      let fixed = 0;
      let skipped = 0;
      for (const row of toMove ?? []) {
        const rowAny = row as any;
        const { error } = await supabaseAdmin.from(table).update({ [column]: keepId }).eq('id', rowAny.id);
        if (!error) {
          moved++;
          continue;
        }
        // 23505＝unique 限制衝突：代表保留那個班級同一個時段/座號已經有資料了。
        if ((error as any).code !== '23505') {
          errors.push(`${table} 一筆資料改指失敗：${error.message}`);
          continue;
        }
        if (table === 'enrollments') {
          // 座號撞到：改配到保留班級同一學期目前最大座號之後的下一號，資料不遺失。
          const { data: maxRow } = await supabaseAdmin
            .from('enrollments')
            .select('seat_no')
            .eq('class_id', keepId)
            .eq('term', rowAny.term)
            .order('seat_no', { ascending: false })
            .limit(1)
            .maybeSingle();
          const nextSeatNo = ((maxRow as any)?.seat_no ?? 0) + 1;
          const { error: retryErr } = await supabaseAdmin
            .from(table)
            .update({ [column]: keepId, seat_no: nextSeatNo })
            .eq('id', rowAny.id);
          if (retryErr) {
            errors.push(`${table} 一筆資料改指失敗（座號 ${rowAny.seat_no} 衝突，改配 ${nextSeatNo} 號後仍失敗）：${retryErr.message}`);
          } else {
            fixed++;
          }
        } else {
          // 課表／代課時段撞到：保留那個班級同一個時段本來就已經有資料了，代表這筆是
          // 重複資料，直接刪除多餘那筆（不影響保留那筆的資料）。
          const { error: delErr } = await supabaseAdmin.from(table).delete().eq('id', rowAny.id);
          if (delErr) {
            errors.push(`${table} 一筆重複資料刪除失敗：${delErr.message}`);
          } else {
            skipped++;
          }
        }
      }
      if (moved) repointed[table] = moved;
      if (fixed) renumbered[table] = fixed;
      if (skipped) skippedDuplicates[table] = skipped;
    }

    const { error: deleteErr } = await supabaseAdmin.from('classes').delete().in('id', mergeIds);
    if (deleteErr) {
      errors.push('刪除多餘的班級資料失敗（可能還有其他資料表參照到，需要人工檢查）：' + deleteErr.message);
    }

    return NextResponse.json({
      success: errors.length === 0,
      keptLabel: `${keepRow.academic_year}學年度 ${keepRow.grade_level}${keepRow.class_name}`,
      repointed,
      renumbered,
      skippedDuplicates,
      errors,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
