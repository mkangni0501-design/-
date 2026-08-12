import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { namesLikelySamePerson } from '@/lib/periodConfig';

type UserRole = 'system_admin_s' | 'admin_a' | 'admin_b' | 'homeroom_teacher' | 'subject_teacher';

// 誰可以邀請誰：
// - system_admin_s 可建立 admin_a / admin_b／另一位 system_admin_s，以及導師/任課教師
//   （原本限制「系統管理員S全系統限定1位、不可由此功能建立」，改成系統管理員S可以自行
//   再新增其他系統管理員S帳號，方便多人共同管理或交接時不用直接動資料庫）
// - admin_a 只能建立同角色的 admin_a，以及導師/任課教師
// - admin_b 只能建立同角色的 admin_b，以及導師/任課教師
const ALLOWED_TARGETS: Record<string, UserRole[]> = {
  system_admin_s: ['system_admin_s', 'admin_a', 'admin_b', 'homeroom_teacher', 'subject_teacher'],
  admin_a: ['admin_a', 'homeroom_teacher', 'subject_teacher'],
  admin_b: ['admin_b', 'homeroom_teacher', 'subject_teacher'],
};

const TEACHER_ROLES: UserRole[] = ['homeroom_teacher', 'subject_teacher'];

export async function POST(req: NextRequest) {
  try {
    const { email, name, role, password, bindTeacherId } = (await req.json()) as {
      email: string;
      name: string;
      role: UserRole;
      password?: string;
      bindTeacherId?: string;
    };

    if (!email || !name || !role) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }

    // ---- 1. 驗證呼叫者身份：從 Authorization header 拿到登入者的 access token ----
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: '未登入' }, { status: 401 });
    }

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) {
      return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });
    }

    const { data: callerProfile, error: callerProfileErr } = await supabaseAdmin
      .from('app_users')
      .select('role')
      .eq('id', callerAuth.user.id)
      .single();
    if (callerProfileErr || !callerProfile) {
      return NextResponse.json({ error: '找不到呼叫者角色資料' }, { status: 403 });
    }

    // ---- 2. 檢查呼叫者是否有權限建立這個角色 ----
    const allowed = ALLOWED_TARGETS[callerProfile.role] ?? [];
    if (!allowed.includes(role)) {
      return NextResponse.json({ error: '沒有權限建立此角色' }, { status: 403 });
    }

    // ---- 3. 建立登入帳號 ----
    // 有填密碼：直接用管理員權限建立帳號並設定密碼，帳號直接可以登入，不會寄任何信
    //（適合你手上已經有實際名單/密碼資料要直接建檔的情境，也不會受Supabase寄信頻率限制影響）。
    // 沒填密碼：走原本的「寄邀請信」流程，對方點信件連結後自行設定密碼。
    let userId: string;
    if (password) {
      if (password.length < 6) {
        return NextResponse.json({ error: '密碼至少要6個字元' }, { status: 400 });
      }
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // 直接視為已驗證信箱，不寄任何確認信
      });
      if (createErr) {
        if (/already registered|already exists/i.test(createErr.message)) {
          return NextResponse.json({ error: 'ALREADY_EXISTS：這個信箱已經有帳號了' }, { status: 409 });
        }
        return NextResponse.json({ error: createErr.message ?? '建立帳號失敗' }, { status: 500 });
      }
      if (!created.user) {
        return NextResponse.json({ error: '建立帳號失敗' }, { status: 500 });
      }
      userId = created.user.id;
    } else {
      const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
      if (inviteErr) {
        if (/already registered|already exists/i.test(inviteErr.message)) {
          return NextResponse.json({ error: 'ALREADY_EXISTS：這個信箱已經有帳號了' }, { status: 409 });
        }
        return NextResponse.json({ error: inviteErr.message ?? '邀請寄送失敗' }, { status: 500 });
      }
      if (!invited.user) {
        return NextResponse.json({ error: '邀請寄送失敗' }, { status: 500 });
      }
      userId = invited.user.id;
    }

    // ---- 4. 在 app_users 建立對應的角色資料 ----
    const { error: insertErr } = await supabaseAdmin.from('app_users').insert({
      id: userId,
      name,
      role,
    });
    if (insertErr) {
      // 重要：這裡如果失敗又不處理，剛剛第3步建立的登入帳號（auth.users）會變成「孤兒帳號」——
      // 這個信箱在 Supabase Auth 裡已經存在（下次新增會被擋「信箱已存在」），但因為 app_users
      // 沒有對應資料列，帳號管理頁面的清單（只讀 app_users）完全看不到它、也沒辦法重設密碼或刪除，
      // 等於「信箱帳號已存在，但完全無顯示」。這裡改成失敗時立刻把剛建立的登入帳號刪掉復原，
      // 讓這個信箱可以重新嘗試新增，不會卡死。
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
      return NextResponse.json({ error: '建立角色資料失敗，已自動復原剛建立的登入帳號，請重新嘗試：' + insertErr.message }, { status: 500 });
    }

    // ---- 5. 導師/任課教師：連結（或建立）teachers 資料列，之後才能用姓名比對出這位老師教哪些班級/科目 ----
    // 「班級與導師設定」「任課教師設定」「學校課表」的批次上傳都是用姓名直接建立 teachers 資料列（當時還沒有登入帳號）。
    // 建立帳號時：
    //   - 前端如果已經讓管理者手動勾選要綁定哪一筆既有教師資料（bindTeacherId，姓名沒完全對上、
    //     自動比對抓不到的情況，例如多一個空格、簡稱），優先用這個，不用再靠姓名猜。
    //   - 沒有手動指定，才退回原本「同名且還沒連結過帳號」的自動比對；
    //   - 都找不到才新建一筆（同時就帶入 app_user_id），避免變成兩筆同名但各自獨立的教師紀錄。
    if (TEACHER_ROLES.includes(role)) {
      let existingTeacherId: string | null = null;

      if (bindTeacherId) {
        const { data: picked, error: pickedErr } = await supabaseAdmin
          .from('teachers')
          .select('id, app_user_id')
          .eq('id', bindTeacherId)
          .maybeSingle();
        if (pickedErr || !picked) {
          return NextResponse.json({ error: '帳號已建立，但指定要綁定的教師資料找不到了，請重新整理後手動用「教師資料檢查／合併」處理' }, { status: 500 });
        }
        if (picked.app_user_id) {
          return NextResponse.json({ error: '帳號已建立，但這筆教師資料已經連結過其他帳號了，請重新整理後確認' }, { status: 500 });
        }
        existingTeacherId = picked.id;
      } else {
        // 前端沒有指定要綁定哪一筆（表示畫面上沒跳出提示卡，或使用者直接呼叫這支API跳過畫面），
        // 這裡改成用「正規化後很像」比對（多空格/簡稱/全形半形），不再要求完全同名一字不差，
        // 避免又建出一筆重複的教師資料；同時符合的話仍然一併找出來。
        const { data: candidates } = await supabaseAdmin.from('teachers').select('id, name').is('app_user_id', null);
        const existingTeacher = (candidates ?? []).find((t: any) => namesLikelySamePerson(t.name, name)) ?? null;
        existingTeacherId = existingTeacher?.id ?? null;
      }

      if (existingTeacherId) {
        const { error: linkErr } = await supabaseAdmin
          .from('teachers')
          .update({ app_user_id: userId })
          .eq('id', existingTeacherId);
        if (linkErr) {
          return NextResponse.json({ error: '帳號已建立，但連結既有教師資料失敗：' + linkErr.message }, { status: 500 });
        }
      } else {
        const { error: createErr } = await supabaseAdmin.from('teachers').insert({ name: name.trim(), app_user_id: userId });
        if (createErr) {
          return NextResponse.json({ error: '帳號已建立，但建立教師資料失敗：' + createErr.message }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
