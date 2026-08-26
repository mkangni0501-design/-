'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase, getCurrentAppUser, getCurrentTeacherId, ROLE_LABEL, UserRole } from '@/lib/supabaseClient';
import { useFontScale, FontScale } from '@/lib/useFontScale';
import { isSoundMuted, setSoundMuted } from '@/lib/clickSound';
import BackgroundMusicPlayer from '@/components/BackgroundMusicPlayer';

const ADMIN_ROLES: UserRole[] = ['system_admin_s', 'admin_a', 'admin_b'];

export default function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isPortal = pathname?.startsWith('/portal');
  const homeHref = isPortal ? '/portal' : '/admin';
  const loginHref = isPortal ? '/portal/login' : '/';
  const [me, setMe] = useState<{ name: string; role: UserRole } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [switching, setSwitching] = useState(false);
  // 「目前視角」：只有具管理帳號（S/A/B）的人才有「身分切換」，其他人固定只有一種身分不需要顯示。
  // 之前這裡完全沒有顯示目前是哪個視角，使用者切換身分之後很難確認「有沒有切成功、現在到底是哪一個」，
  // 只能靠畫面上功能清單有沒有變少去猜。改成在每一頁最上方（TopNav 全站共用）都明確標示出來。
  const [viewMode, setViewMode] = useState<'admin' | 'teacher'>('admin');
  const { scale, setScale } = useFontScale();
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(isSoundMuted());
  }, []);

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    setSoundMuted(next);
  }

  useEffect(() => {
    if (isPortal) return; // 家長/學生入口有自己的識別方式，這裡只顯示教職員身分
    (async () => {
      const appUser = await getCurrentAppUser();
      if (appUser) setMe({ name: appUser.name, role: appUser.role });
      // 【2026-08-11 修正】原本沒有依 teacher_id 篩選，完全依賴 RLS 政策幫忙擋——但系統
      // 管理員／訓導部門的 RLS 政策本來就刻意放寬可以看到全校教師的通知（審核用），會讓
      // 這些帳號的未讀角標變成「全校未讀總數」而不是「自己的未讀數」。改成明確查自己的
      // teacher_id；沒有連結教師資料的帳號（純管理帳號）就沒有個人通知，角標維持 0。
      const teacherId = await getCurrentTeacherId();
      if (teacherId) {
        const { count } = await supabase
          .from('staff_notifications')
          .select('id', { count: 'exact', head: true })
          .eq('teacher_id', teacherId)
          .is('read_at', null);
        setUnreadCount(count ?? 0);
      } else {
        setUnreadCount(0);
      }
    })();
    syncViewModeLabel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function syncViewModeLabel() {
    if (typeof window === 'undefined') return;
    setViewMode(sessionStorage.getItem('viewMode') === 'teacher' ? 'teacher' : 'admin');
  }

  // 跟 /admin 頁一樣的道理：切換身分當下如果人還在原本那一頁（沒有導頁），
  // 一定要監聽同一個自訂事件才會即時反應，不然「目前視角」標示會停在切換前的狀態。
  useEffect(() => {
    if (isPortal) return;
    syncViewModeLabel();
    window.addEventListener('viewmode-change', syncViewModeLabel);
    return () => window.removeEventListener('viewmode-change', syncViewModeLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPortal]);

  async function handleLogout() {
    await supabase.auth.signOut();
    if (typeof window !== 'undefined') sessionStorage.removeItem('viewMode');
    router.push(loginHref);
  }

  // 具管理帳號（S/A/B）的人，本來就同時是「管理者」也能用「教師」視角操作（減少畫面干擾）。
  // 之前只有登入當下選卡片能決定身分，現在讓已登入的人也能隨時切換，不用登出重登。
  //
  // 之前這裡只用 router.push('/admin') + router.refresh()：如果使用者當下就已經
  // 在 /admin 這一頁，push 到同一個路徑不會觸發重新掛載，/admin 頁面讀取 viewMode 的
  // useEffect（只在掛載時跑一次）就不會重新執行，畫面停在切換前的視角，要手動整頁
  // 重新整理才會生效。改成先 dispatch 一個自訂事件讓「已經掛載」的 /admin 頁面
  // 立刻同步 viewMode；如果人在其他頁面，再導回 /admin（此時是重新掛載，一開始就會
  // 讀到剛剛存好的 sessionStorage，同樣正確）。
  function handleSwitchIdentity(target: 'admin' | 'teacher') {
    if (typeof window !== 'undefined') {
      if (target === 'teacher') sessionStorage.setItem('viewMode', 'teacher');
      else sessionStorage.removeItem('viewMode');
      window.dispatchEvent(new Event('viewmode-change'));
    }
    setViewMode(target);
    setSwitching(false);
    if (pathname !== '/admin') {
      router.push('/admin');
    }
  }

  const canSwitchIdentity = !isPortal && me && ADMIN_ROLES.includes(me.role);

  return (
    <nav
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '10px 16px',
        borderBottom: '1px solid #eee',
        background: '#fff',
        fontSize: 13,
        position: 'relative',
      }}
    >
      <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => router.push(homeHref)}
          style={{ background: 'none', border: 'none', color: '#2C2C2A', cursor: 'pointer', padding: 0, font: 'inherit' }}
        >
          {/* 原本是 router.back()「返回上頁」，瀏覽器上一頁常常不是本系統的頁面（例如從外部連結
              進來、或分頁瀏覽紀錄被清過），按了會跳出系統或沒反應。改成固定回到主選單
              （教職員是 /admin，家長/學生入口是 /portal），行為固定、好預期。 */}
          ← 回主選單
        </button>
        <span style={{ color: '#666' }}>{me ? `${me.name}｜${ROLE_LABEL[me.role]}` : ''}</span>
        {canSwitchIdentity && (
          <span
            title="目前視角：用「切換身分」可以隨時改變，不用登出重登"
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: viewMode === 'teacher' ? '#EAF3EC' : '#F1EEE6',
              color: viewMode === 'teacher' ? '#3B6D11' : '#8A5A00',
              border: `1px solid ${viewMode === 'teacher' ? '#BFE0C6' : '#E4D5A8'}`,
            }}
          >
            目前視角：{viewMode === 'teacher' ? '教師視角' : '管理者視角'}
          </span>
        )}
      </span>
      <span style={{ display: 'flex', gap: 16, alignItems: 'center', position: 'relative' }}>
        {!isPortal && me && (
          <>
            {/* 字級 大/中/小：中是預設，套用到整個畫面（含按鈕、留白），不只是文字。 */}
            <span style={{ display: 'flex', gap: 2, alignItems: 'center', fontSize: 11 }} title="字級">
              {(['small', 'medium', 'large'] as FontScale[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  style={{
                    padding: '2px 6px',
                    border: '1px solid ' + (scale === s ? '#2C2C2A' : '#ccc'),
                    background: scale === s ? '#2C2C2A' : '#fff',
                    color: scale === s ? '#fff' : '#666',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  {s === 'small' ? '小' : s === 'medium' ? '中' : '大'}
                </button>
              ))}
            </span>
            <button
              onClick={toggleMuted}
              title={muted ? '點選音效：已關閉' : '點選音效：已開啟'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}
            >
              {muted ? '🔕' : '🔔'}
            </button>
            <BackgroundMusicPlayer />
          </>
        )}
        {!isPortal && me && (
          <Link href="/notifications" style={{ color: '#2C2C2A' }}>
            通知{unreadCount > 0 ? `（${unreadCount}）` : ''}
          </Link>
        )}
        {canSwitchIdentity ? (
          <span style={{ position: 'relative' }}>
            <button
              onClick={() => setSwitching((v) => !v)}
              style={{ background: 'none', border: 'none', color: '#2C2C2A', cursor: 'pointer', padding: 0, font: 'inherit' }}
            >
              切換身分 ▾
            </button>
            {switching && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 8,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  minWidth: 140,
                  zIndex: 10,
                }}
              >
                <button
                  onClick={() => handleSwitchIdentity('admin')}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
                >
                  管理者視角
                </button>
                <button
                  onClick={() => handleSwitchIdentity('teacher')}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
                >
                  教師視角
                </button>
              </div>
            )}
          </span>
        ) : (
          <Link href={homeHref} style={{ color: '#2C2C2A' }}>
            回首頁
          </Link>
        )}
        <button
          onClick={handleLogout}
          style={{ background: 'none', border: 'none', color: '#2C2C2A', cursor: 'pointer', padding: 0, font: 'inherit' }}
        >
          登出
        </button>
      </span>
    </nav>
  );
}
