// 按鈕點選音效：用瀏覽器內建的 Web Audio API 即時合成兩種短提示音，不用另外找/放音效檔案。
// 「確定」類音效：兩個上升的音（像遊戲選單選到東西的聲音）。
// 「取消」類音效：一個下降的音，跟確定類明顯不同，一聽就知道剛剛按到的是取消/清除/刪除這類動作。

const SOUND_MUTE_KEY = 'app_sound_muted';

export function isSoundMuted(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(SOUND_MUTE_KEY) === '1';
}

export function setSoundMuted(muted: boolean) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SOUND_MUTE_KEY, muted ? '1' : '0');
}

let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!sharedCtx) sharedCtx = new AudioContextCtor();
  // 瀏覽器的自動播放政策：AudioContext 有時會用「suspended」狀態建立，
  // 一定要在使用者實際點擊之後才能 resume，這裡的呼叫本來就是點擊事件觸發的，符合規定。
  if (sharedCtx.state === 'suspended') sharedCtx.resume();
  return sharedCtx;
}

function playTone(freqStart: number, freqEnd: number, durationSec: number, volume: number) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(freqEnd, ctx.currentTime + durationSec);
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationSec);
}

export function playConfirmSound() {
  if (isSoundMuted()) return;
  playTone(520, 780, 0.08, 0.06);
  setTimeout(() => playTone(780, 1040, 0.09, 0.05), 70);
}

export function playCancelSound() {
  if (isSoundMuted()) return;
  playTone(420, 260, 0.14, 0.05);
}

export function playNeutralSound() {
  if (isSoundMuted()) return;
  playTone(500, 520, 0.05, 0.035);
}
