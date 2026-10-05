'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// 「備份與還原」已經搬進「開發人員區」(/admin/dev-tools)，這裡保留一個自動跳轉，
// 避免有人書籤/收藏了舊網址時打不開。
export default function BackupsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/dev-tools');
  }, [router]);
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <p style={{ fontSize: 13, color: '#999' }}>「備份與還原」已經搬到「開發人員區」，正在為您跳轉…</p>
    </main>
  );
}
