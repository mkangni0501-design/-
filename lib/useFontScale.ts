'use client';

import { useEffect, useState } from 'react';

export type FontScale = 'small' | 'medium' | 'large';

const FONT_SCALE_KEY = 'app_font_scale';
const SCALE_VALUE: Record<FontScale, string> = {
  small: '0.9',
  medium: '1',
  large: '1.15',
};

// 全站字級大/中(預設)/小：這個系統目前每個頁面的字級都是寫死的 px（fontSize: 16 這種），
// 不是用 rem/em 這種會跟著「根字級」縮放的相對單位，所以沒辦法只改一個 CSS 變數就讓全站
// 字級跟著變。改用 CSS 的 zoom（放大整個畫面，不只是文字，連按鈕、留白都會等比例放大/縮小），
// Chrome／Edge／Safari 都支援，是目前能做到「不用把全站幾十個檔案的 px 字級都手動改成
// rem」的做法裡最實際的一個；Firefox 較新版本（126+）也已支援。
export function applyFontScale(scale: FontScale) {
  if (typeof document === 'undefined') return;
  (document.documentElement.style as any).zoom = SCALE_VALUE[scale];
  localStorage.setItem(FONT_SCALE_KEY, scale);
}

export function getStoredFontScale(): FontScale {
  if (typeof window === 'undefined') return 'medium';
  const v = localStorage.getItem(FONT_SCALE_KEY);
  return v === 'small' || v === 'large' ? v : 'medium';
}

/** 掛在 TopNav 這類全站共用元件裡：頁面一載入就套用使用者上次選過的字級。 */
export function useFontScale() {
  const [scale, setScaleState] = useState<FontScale>('medium');

  useEffect(() => {
    const stored = getStoredFontScale();
    setScaleState(stored);
    applyFontScale(stored);
  }, []);

  function setScale(next: FontScale) {
    setScaleState(next);
    applyFontScale(next);
  }

  return { scale, setScale };
}
