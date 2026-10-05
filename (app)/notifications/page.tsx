'use client';

import { useEffect, useState } from 'react';
import { supabase, getCurrentAppUser, getCurrentTeacherId } from '@/lib/supabaseClient';

type NotificationRow = {
  id: string;
  category: string;
  message: string;
  student_no: string | null;
  created_at: string;
  read_at: string | null;
};

// 導師的站內通知：家長送出基本資料/監護人修改申請、以及出缺勤示警相關訊息會出現在這裡。
// 目前系統沒有串接外部寄信服務，這裡是「校內系統內」的通知；若之後要改成真的寄 email，
// 只要在對應的觸發點（例如 notify_homeroom_on_profile_edit_request 這個資料庫觸發器）
// 另外呼叫寄信 API 即可，不影響這裡的畫面。
//
// 【2026-08-11 修正】根因：原本查詢沒有加 teacher_id 篩選，完全依賴資料庫 RLS 政策幫忙
// 擋——但 RLS 政策裡系統管理員／訓導部門本來就刻意放寬「可以看到全校所有教師的通知」
// （方便審核/監督用），導致這些帳號打開這頁看到的是全校通知混在一起，變成「大家共用
// 同一份」而不是「個人專屬」。改成明確查自己的 teacher_id，只抓屬於自己的通知。
export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasTeacherProfile, setHasTeacherProfile] = useState(true);

  async function load() {
    setLoading(true);
    const appUser = await getCurrentAppUser();
    if (!appUser) {
      setLoading(false);
      return;
    }
    const teacherId = await getCurrentTeacherId();
    if (!teacherId) {
      // 這個帳號沒有連結教師資料（例如純管理帳號），代表沒有「屬於自己」的個人通知——
      // 不要因此顯示全校通知，那樣又會回到「共用」的問題。
      setHasTeacherProfile(false);
      setNotifications([]);
      setLoading(false);
      return;
    }
    setHasTeacherProfile(true);
    const { data, error } = await supabase
      .from('staff_notifications')
      .select('id, category, message, student_no, created_at, read_at')
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false });
    if (error) {
      setLoadError('讀取通知失敗：' + error.message);
      setLoading(false);
      return;
    }
    setNotifications((data ?? []) as NotificationRow[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(id: string) {
    const { error } = await supabase.from('staff_notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    if (!error) {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    }
  }

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 16, marginBottom: 4 }}>通知{unreadCount > 0 ? `（${unreadCount} 則未讀）` : ''}</h1>
      <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
        家長／學生送出基本資料修改申請、以及出缺勤相關訊息會顯示在這裡。
      </p>

      {loadError && <p style={{ fontSize: 13, color: '#A32D2D', marginBottom: 12 }}>{loadError}</p>}
      {loading ? (
        <p style={{ fontSize: 13, color: '#999' }}>載入中…</p>
      ) : !hasTeacherProfile ? (
        <p style={{ fontSize: 13, color: '#999' }}>這個帳號沒有連結教師資料，沒有屬於自己的個人通知。</p>
      ) : notifications.length === 0 ? (
        <p style={{ fontSize: 13, color: '#999' }}>目前沒有通知。</p>
      ) : (
        notifications.map((n) => (
          <div
            key={n.id}
            style={{
              padding: 12,
              border: '1px solid #eee',
              borderRadius: 8,
              marginBottom: 8,
              background: n.read_at ? '#fff' : '#FBEFE9',
            }}
          >
            <p style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
              {n.category}｜{new Date(n.created_at).toLocaleString('zh-TW')}
            </p>
            <p style={{ fontSize: 13, marginBottom: n.read_at ? 0 : 8 }}>{n.message}</p>
            {!n.read_at && (
              <button onClick={() => markRead(n.id)} style={{ fontSize: 12, padding: '2px 10px' }}>
                標記已讀
              </button>
            )}
          </div>
        ))
      )}
    </main>
  );
}
