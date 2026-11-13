// 카운트다운 삑 소리와 셔터 소리. 소리 파일 없이 WebAudio로 만든다.
// 브라우저는 사용자 동작(탭·키) 안에서만 소리를 켜 준다. 그래서 첫 동작 때 unlock()을 부르고,
// 그 전에 울릴 일이 생기면 조용히 건너뛴다.
// iOS는 무음 스위치가 WebAudio를 막는다. 손님 폰에서는 그 설정을 존중하고,
// 부스(직원 기기)에서만 audioSession을 'playback'으로 바꿔 무음 스위치와 상관없이 울린다.

export class Sound {
  constructor({ enabled = true, booth = false } = {}) {
    this.enabled = enabled;
    this.booth = booth;
    this.ctx = null;
    document.addEventListener('visibilitychange', () => {
      // iOS는 백그라운드에 다녀오면 'interrupted' 상태로 남는 일이 있어 다시 깨운다
      if (document.visibilityState === 'visible') this.ctx?.resume?.().catch(() => {});
    });
  }

  setEnabled(on) {
    this.enabled = on;
  }

  // 사용자 동작 안에서 부른다
  unlock() {
    try {
      if (this.booth && navigator.audioSession) navigator.audioSession.type = 'playback';
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  // 카운트다운 한 번. 마지막 초는 조금 높게
  beep(last = false) {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = last ? 1320 : 880;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  // 셔터: 짧은 잡음을 대역 필터로 걸러 찰칵 두 번. 삑보다 크게
  shutter() {
    if (!this.ready()) return;
    const ctx = this.ctx;
    const len = Math.round(ctx.sampleRate * 0.08);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const click = (at, level) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 3000;
      band.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
      src.connect(band).connect(gain).connect(ctx.destination);
      src.start(at);
      src.stop(at + 0.08);
    };
    const t = ctx.currentTime;
    click(t, 0.5);
    click(t + 0.06, 0.25);
  }
}
