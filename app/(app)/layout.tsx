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
