'use client';

import { useEffect, useRef, useState } from 'react';
import { getSiteSetting } from '@/lib/siteContent';

const MUSIC_PLAYING_KEY = 'app_music_playing';
const MUSIC_VOLUME_KEY = 'app_music_volume';

/**
 * 背景音樂：掛在 app/(app)/layout.tsx 這一層，跟 TopNav 同一層，只要使用者還在系統裡用
 * 前端路由切換頁面（沒有整頁重新整理），這個元件就不會重新掛載，音樂會持續播放不中斷。
 *
 * 重要限制（不是這裡的程式碼問題，是瀏覽器本身的規定）：
 * 1. 瀏覽器不允許網頁一開啟就自動播放有聲音的音樂，一定要使用者自己按一次播放鍵才能開始播放；
 *    這是 Chrome/Safari 的自動播放政策，沒有辦法繞過。
 * 2. 如果使用者整頁重新整理（按 F5、直接重新輸入網址、關掉分頁再打開），播放狀態不會保留，
 *    需要再按一次播放——真的要做到「重新整理也不中斷」需要另外的機制（例如背景分頁播放服務），
 *    工程量大很多，這裡先不做。
 */
export default function BackgroundMusicPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.4);

  useEffect(() => {
    (async () => {
      const url = await getSiteSetting('background_music_url');
      setMusicUrl(url);
    })();
    const storedVolume = typeof window !== 'undefined' ? localStorage.getItem(MUSIC_VOLUME_KEY) : null;
    if (storedVolume) setVolume(parseFloat(storedVolume));
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (typeof window !== 'undefined') localStorage.setItem(MUSIC_VOLUME_KEY, String(volume));
  }, [volume]);

  function togglePlay() {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
      localStorage.setItem(MUSIC_PLAYING_KEY, '0');
    } else {
      audioRef.current.play().catch(() => {
        // 使用者互動之外的呼叫（例如某些瀏覽器仍然擋下）會被拒絕，安靜地忽略即可，
        // 畫面上的播放鍵狀態不會跳動，使用者可以再按一次。
      });
      setPlaying(true);
      localStorage.setItem(MUSIC_PLAYING_KEY, '1');
    }
  }

  if (!musicUrl) return null; // 系統管理員S還沒上傳背景音樂之前，完全不顯示這個控制項

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <audio ref={audioRef} src={musicUrl} loop preload="none" />
      <button
        onClick={togglePlay}
        title={playing ? '暫停背景音樂' : '播放背景音樂'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}
      >
        {playing ? '🔊' : '🔈'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        style={{ width: 60 }}
        title="音量"
      />
    </div>
  );
}
