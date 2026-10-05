'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopNav from '@/components/TopNav';
import ClickSoundListener from '@/components/ClickSoundListener';
import { supabase } from '@/lib/supabaseClient';

// 這個路由群組（管理後台、出缺勤、通知…等所有教職員頁面）統一在這裡檔一次「有沒有登入」，
// 避免像過去那樣，直接打網址（例如 /admin 或大小寫變化的 /ADMIN）就能在沒登入的情況下
// 看到頁面上的功能清單／連結。個別頁面/元件仍然會各自用 Supabase RLS 決定「看不看得到實際資料」，
// 這裡只負責「沒登入就整個踢回登入頁」這一層。
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<'checking' | 'allowed'>('checking');

  useEffect(() => {
    let active = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (!data.session) {
        router.replace('/');
        return;
      }
      // 反映事項「開發人員區增加【第一次登入強制更改密碼】功能」：教職員（app_users）
      // 帳號如果還沒完成「第一次登入強制改密碼」，這裡整層擋下來、導去 /change-password，
      // 不管想打開哪個頁面都一樣先擋在這裡（不是只在登入當下判斷一次），避免直接輸入
      // 網址跳過這一步。家長/學生（portal_accounts）帳號在 app_users 裡本來就查不到
      // 任何資料，這裡的檢查對他們自然不會有作用，不影響家長/學生登入。
      const { data: profile } = await supabase.from('app_users').select('must_change_password').eq('id', data.session.user.id).maybeSingle();
      if (!active) return;
      if (profile?.must_change_password) {
        router.replace('/change-password');
        return;
      }
      setStatus('allowed');
    })();

    // 使用中如果登出（例如 token 過期、另一個分頁按了登出），也立刻踢回登入頁
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace('/');
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [router]);

  if (status === 'checking') {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      </main>
    );
  }

  return (
    <>
      <ClickSoundListener />
      <TopNav />
      {children}
    </>
  );
}
