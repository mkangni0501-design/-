'use client';

import { useEffect, useState } from 'react';

/**
 * 手機斷點判斷：螢幕寬度 <= breakpointPx 時視為手機。
 * 用 matchMedia 而不是量一次 window.innerWidth，才能在使用者旋轉螢幕／調整瀏覽器
 * 視窗大小時即時反應，不用重新整理頁面。
 * 預設回傳 false（當桌機版排版），避免第一次掛載那一瞬間畫面跳動。
 *
 * 用在成績登錄、出缺勤登錄、管理後台首頁等「多數人用手機操作」的頁面，統一做：
 * 字級/留白依斷點放大、長說明文字用 <details> 收合、次要功能（例如批次上傳）預設收合。
 */
export function useIsMobile(breakpointPx = 640): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpointPx]);
  return isMobile;
}
