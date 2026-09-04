'use client';

import { useEffect } from 'react';
import { playConfirmSound, playCancelSound, playNeutralSound } from '@/lib/clickSound';

// 「確定」類關鍵字：儲存、確定、送出、新增、登入、登出、套用、通過、核准…這類讓事情發生的按鈕。
const CONFIRM_KEYWORDS = ['儲存', '確定', '確認', '送出', '新增', '登入', '登出', '套用', '通過', '核准', '同意', '下載', '上傳', '開放', '啟用'];
// 「取消」類關鍵字：取消、清除、刪除、關閉、退回、駁回、拒絕…這類讓事情停止/收回的按鈕。
const CANCEL_KEYWORDS = ['取消', '清除', '刪除', '關閉', '退回', '駁回', '拒絕', '停用', '移除'];

/**
 * 整個系統的按鈕點選音效：不用一個一個按鈕去改，改成在最外層（app/(app)/layout.tsx）掛一次，
 * 用事件委派監聽整個頁面的點擊，找到被點到的 <button>／有 role="button" 的元素，
 * 依按鈕文字判斷要放哪一種提示音（找不到符合關鍵字的就放中性的小聲提示音）。
 * 尊重使用者在 TopNav 那個小喇叭圖示關掉的「靜音」設定（存在 localStorage，見 lib/clickSound.ts）。
 */
export default function ClickSoundListener() {
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest('button, [role="button"]') as HTMLElement | null;
      if (!btn || btn.hasAttribute('disabled')) return;
      const text = (btn.textContent || '').trim();
      if (CANCEL_KEYWORDS.some((k) => text.includes(k))) {
        playCancelSound();
      } else if (CONFIRM_KEYWORDS.some((k) => text.includes(k))) {
        playConfirmSound();
      } else {
        playNeutralSound();
      }
    }
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  return null;
}
