import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { namesLikelySamePerson } from '@/lib/periodConfig';

type UserRole = 'system_admin_s' | 'admin_a' | 'admin_b' | 'homeroom_teacher' | 'subject_teacher';

// 誰可以把孤兒帳號補救成哪個角色，跟 /api/admin/invite-user 的規則一致。
const ALLOWED_TARGETS: Record<string, UserRole[]> = {
  system_admin_s: ['system_admin_s', 'admin_a', 'admin_b', 'homeroom_teacher', 'subject_teacher'],
  admin_a: ['admin_a', 'homeroom_teacher', 'subject_teacher'],
  admin_b: ['admin_b', 'homeroom_teacher', 'subject_teacher'],
};

const TEACHER_ROLES: UserRole[] = ['homeroom_teacher', 'subject_teacher'];

// 「編輯孤兒帳號」＝這個信箱在登入系統（auth.users）裡已經存在，只是缺 app_users 的角色資料，
// 直接幫它補上「姓名＋角色」讓帳號變成可以正常使用，不用刪除掉再重新邀請一次
// （重新邀請對方還要重新收信/重新設定密碼，如果對方其實已經能用這組帳密登入，補資料更省事）。
export async function POST(req: NextRequest) {
  try {
    const { targetAuthUserId, name, role, bindTeacherId } = (await req.json()) as {
      targetAuthUserId: string;
      name: string;
      role: UserRole;
      bindTeacherId?: string;
    };
    if (!targetAuthUserId || !name?.trim() || !role) {
      return NextResponse.json({ error: '缺少必要欄位' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(token);
    if (callerAuthErr || !callerAuth.user) return NextResponse.json({ error: '登入憑證無效' }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from('app_users').select('role').eq('id', callerAuth.user.id).single();
    if (callerProfile?.role !== 'system_admin_s') {
      return NextResponse.json({ error: '只有系統管理員S可以編輯孤兒帳號' }, { status: 403 });
    }

    const allowed = ALLOWED_TARGETS[callerProfile.role] ?? [];
    if (!allowed.includes(role)) {
      return NextResponse.json({ error: '沒有權限指派此角色' }, { status: 403 });
    }

    // 重新確認一次「真的還是孤兒」，避免跟同時間的操作打架
    const { data: stillThere } = await supabaseAdmin.from('app_users').select('id').eq('id', targetAuthUserId).maybeSingle();
    if (stillThere) {
      return NextResponse.json({ error: '這個帳號現在已經有角色資料了，不是孤兒帳號，請重新整理後確認' }, { status: 409 });
    }

    const { error: insertErr } = await supabaseAdmin.from('app_users').insert({ id: targetAuthUserId, name: name.trim(), role });
    if (insertErr) {
      return NextResponse.json({ error: '補上角色資料失敗：' + insertErr.message }, { status: 500 });
    }

    if (TEACHER_ROLES.includes(role)) {
      let existingTeacherId: string | null = null;
      if (bindTeacherId) {
        const { data: picked } = await supabaseAdmin.from('teachers').select('id, app_user_id').eq('id', bindTeacherId).maybeSingle();
        if (picked && !picked.app_user_id) existingTeacherId = picked.id;
      } else {
        const { data: candidates } = await supabaseAdmin.from('teachers').select('id, name').is('app_user_id', null);
        const found = (candidates ?? []).find((t: any) => namesLikelySamePerson(t.name, name));
        existingTeacherId = found?.id ?? null;
      }
      if (existingTeacherId) {
        await supabaseAdmin.from('teachers').update({ app_user_id: targetAuthUserId }).eq('id', existingTeacherId);
      } else {
        await supabaseAdmin.from('teachers').insert({ name: name.trim(), app_user_id: targetAuthUserId });
      }
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? '未知錯誤' }, { status: 500 });
  }
}
