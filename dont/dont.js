// 사용금지: 포스터 그림이 살아 움직이는 영상.
// 영상 첫 장면 = 포스터 그림이라, 포스터 위 같은 자리에 겹쳐 틀면 포스터가 움직이기 시작하는 것처럼 보인다.
//
// 보기 방식(mode)
// - ar: 인식된 포스터 위에 WebGL 판으로 겹친다(MindAR 앵커에 붙인 판, 텍스처 = 같은 <video>).
// - pinned: 카메라는 켜져 있지만 포스터를 놓쳤다 → 영상을 끊지 않고 화면 가운데로 옮겨 계속 튼다.
//   왜: 부스는 붐벼서 사람이 포스터를 가리기 쉽고, 방문객은 소리를 들으며 폰을 내리기도 한다.
//   "다시 비춰 주세요"로 멈추면 그 순간 영상과 소리가 끊긴다. 옮겨 틀면 탭 없이 끝까지 본다.
//   포스터를 다시 비추면(잠깐 안정되게 보이면) 포스터 위로 돌아간다.
// - screen: 카메라 없이 화면 가운데에서만(직접 고르기, 인식이 안 되는 기기).
//
// 받기(느린 회선)
// - 행사장 회선이 느리면 영상이 조금 돌고 멈추기를 되풀이한다(무서운 장면의 박자가 깨지고 고장 난 것처럼 보인다).
//   그래서 받을 것이 모자라면 멈춰 두고 "불러오는 중 n%"를 보이다가, 받는 속도를 재서 끝까지 끊기지 않을 만큼
//   받았을 때 다시 튼다(처음 시작할 때와 도중에 멈췄을 때 모두). 멈춰 둔 사이 받기가 전혀 늘지 않으면
//   (멈춘 영상은 안 받는 브라우저) 그냥 틀고 그 뒤로는 브라우저에 맡긴다.
//
// 지킬 것
// - play()는 사용자가 누른 처리기 안에서 await 없이 바로 부른다(소리 허용 조건). 그 뒤의 다시 틀기는
//   같은 video라 허용된다(iOS는 한 번 누름으로 튼 video의 제한을 푼다).
//   소리 재생이 거절되면 소리 없이 틀고 "소리 켜기"를 보인다.
// - 숨길 때도 display:none을 쓰지 않는다(iOS에서 텍스처가 멈출 수 있음). 투명도로만 숨긴다.
import { GAMES } from '../games.js';

const LOST_GRACE_MS = 450; // 포스터를 놓친 뒤 이만큼 지나도 못 찾으면 가운데로
const FOUND_GRACE_MS = 600; // 다시 찾은 뒤 이만큼 계속 보이면 포스터 위로
const FEATHER = 0.035; // 판 가장자리를 부드럽게 하는 폭(한 변 비율). 추적 흔들림에 이음매가 덜 보인다
const FADE_IN_MS = 180;
const FADE_OUT_MS = 1000; // 끝날 때 검게
const END_PANEL_DELAY_MS = 1000;
// 받기 판단
const HOLD_POLL_MS = 200;
const HOLD_MIN_SAMPLES = 3; // 받는 속도를 재는 최소 표본(약 0.4초)
const RATE_SAFETY = 1.15; // 받는 속도를 이만큼 낮춰 잡는다
const BUFFER_MARGIN_S = 1.0; // 여유로 더 받아 둘 영상 길이(초)
const HOLD_STALL_MS = 3000; // 멈춰 둔 사이 이만큼 받기가 안 늘면 그냥 튼다

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// 가장자리만 부드럽게 0으로 떨어지는 알파 맵(초록 채널을 쓴다). ctx.filter(사파리 없음) 없이 직접 계산
function featherCanvas(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const ramp = Math.max(1, FEATHER * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x + 0.5, y + 0.5, size - x - 0.5, size - y - 0.5);
      const t = Math.min(1, d / ramp);
      const v = Math.round(255 * t * t * (3 - 2 * t));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class DontPlayer {
  constructor({ onExit }) {
    const $ = (id) => document.getElementById(id);
    this.el = {
      layer: $('dont'),
      video: $('dont-video'),
      close: $('dont-close'),
      sound: $('dont-sound'),
      hint: $('dont-hint'),
      load: $('dont-load'),
      loadText: $('dont-load-text'),
      end: $('dont-end'),
      endLine: $('dont-end-line'),
      msg: $('dont-msg'),
      replay: $('dont-replay'),
      other: $('dont-other'),
    };
    this.onExit = onExit;
    this.ar = null;
    this.targets = [];
    this.overlayIdx = new Set(); // 영상을 겹칠 수 있는 인식 대상 번호
    this.material = null;
    this.meshes = [];
    this.isOpen = false;
    this.mode = 'screen';
    this.ending = false;
    this.hasFrame = false;
    this.opacity = 0;
    this.bright = 1;
    this.lastTick = 0;
    this.timers = { lost: 0, found: 0, end: 0, hold: 0 };
    this.hold = null; // 받는 동안 멈춰 둔 상태 { samples, lastEnd, lastChange }
    this.noHold = false; // 멈춰 둬도 안 받는 브라우저: 이번 재생은 브라우저에 맡긴다
    this.stalled = false; // 재생 중 데이터가 모자라 기다리는 중(브라우저가 멈춘 것)
    this.log = [];
    this.loadLog = []; // 시험용: 불러오는 중 표시가 뜬 구간
    this.el.endLine.textContent = GAMES.dont.line;

    const v = this.el.video;
    v.playsInline = true;
    v.addEventListener('playing', () => {
      this.stalled = false;
      this.markFrame();
      this.updateLoad();
    });
    v.addEventListener('waiting', () => this.onWaiting());
    v.addEventListener('ended', () => this.finish());
    v.addEventListener('error', () => this.failVideo());
    this.el.close.addEventListener('click', () => this.exit());
    this.el.other.addEventListener('click', () => this.exit());
    this.el.replay.addEventListener('click', () => this.replay());
    this.el.sound.addEventListener('click', () => {
      v.muted = false;
      this.el.sound.hidden = true;
    });
    this.tick = this.tick.bind(this);
  }

  // 카드가 뜨면 미리 받아 두기 시작한다(iOS는 무시할 수 있다)
  preload() {
    const v = this.el.video;
    if (v.preload !== 'auto') v.preload = 'auto';
  }

  // 인식이 켜진 뒤 한 번. 사용금지 대상마다 영상 판을 앵커에 붙인다.
  // 인식 준비 중에 영상을 먼저 열었으면(직접 고르기) 여기서부터 포스터를 찾으면 올라가게 한다
  attach(ar, targets) {
    this.detach();
    this.ar = ar;
    this.targets = targets;
    const T = ar.three;
    const tex = new T.VideoTexture(this.el.video);
    tex.colorSpace = T.SRGBColorSpace;
    tex.minFilter = tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    const alpha = new T.CanvasTexture(featherCanvas());
    this.material = new T.MeshBasicMaterial({
      map: tex,
      alphaMap: alpha,
      transparent: true,
      opacity: 0,
      toneMapped: false,
      depthWrite: false,
      depthTest: false,
    });
    this.texture = tex;
    this.alphaTex = alpha;
    targets.forEach((t, i) => {
      if (t.game !== 'dont' || !t.overlay) return;
      const r = t.overlay;
      const h = ar.aspect(i); // 앵커 공간: 폭 1 = 포스터 폭, 가운데가 원점, 위가 +y
      const geo = new T.PlaneGeometry(r.x1 - r.x0, (r.y1 - r.y0) * h);
      const mesh = new T.Mesh(geo, this.material);
      mesh.position.set((r.x0 + r.x1) / 2 - 0.5, (0.5 - (r.y0 + r.y1) / 2) * h, 0.001);
      mesh.renderOrder = 1;
      ar.anchors[i].group.add(mesh);
      this.meshes.push(mesh);
      this.overlayIdx.add(i);
    });
    ar.frameHooks.add(this.tick);
    if (this.isOpen) {
      ar.renderWanted = true;
      if (this.mode === 'screen') this.setMode(this.overlayVisible() >= 0 ? 'ar' : 'pinned');
    }
  }

  // 인식이 꺼질 때. 열려 있으면 화면 가운데 보기로 이어 간다
  detach() {
    clearTimeout(this.timers.lost);
    clearTimeout(this.timers.found);
    if (this.ar) {
      this.ar.frameHooks.delete(this.tick);
      this.ar.renderWanted = false;
    }
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.material?.dispose();
    this.texture?.dispose();
    this.alphaTex?.dispose();
    this.meshes = [];
    this.material = this.texture = this.alphaTex = null;
    this.overlayIdx.clear();
    this.ar = null;
    if (this.isOpen && this.mode !== 'screen') this.setMode('screen');
  }

  overlayVisible() {
    if (!this.ar) return -1;
    for (const i of this.overlayIdx) if (this.ar.isVisible(i)) return i;
    return -1;
  }

  // 지금 보이는 포스터가 영상을 겹칠 수 없는 사용금지 포스터인지(?targets=all6의 두 번째 포스터)
  plainDontVisible() {
    if (!this.ar) return false;
    for (const i of this.ar.visible) {
      const t = this.targets[i];
      if (t?.game === 'dont' && !t.overlay) return true;
    }
    return false;
  }

  // 반드시 클릭 처리기 안에서 바로 부른다
  open() {
    const v = this.el.video;
    this.isOpen = true;
    this.ending = false;
    this.bright = 1;
    this.noHold = false;
    this.el.layer.hidden = false;
    this.el.layer.classList.remove('is-ending');
    this.el.end.hidden = true;
    this.el.msg.hidden = true;
    this.el.sound.hidden = true;
    v.preload = 'auto';
    if (v.readyState > 0) v.currentTime = 0;
    this.startPlayback();
    const i = this.overlayVisible();
    this.setMode(!this.ar ? 'screen' : i >= 0 ? 'ar' : 'pinned');
    if (this.ar) this.ar.renderWanted = true;
    this.el.close.focus({ preventScroll: true });
  }

  // 클릭 안에서 먼저 틀고(소리 허용), 받은 것이 모자라면 바로 멈춰 두고 받는다
  startPlayback() {
    this.play();
    if (!this.fullyBuffered()) this.startHold('start');
  }

  play() {
    const v = this.el.video;
    v.muted = false;
    this.playQuiet();
  }

  // muted를 건드리지 않고 튼다(다시 틀기). 소리 재생이 막히면 소리 없이
  playQuiet() {
    const v = this.el.video;
    let p;
    try {
      p = v.play();
    } catch (e) {
      p = Promise.reject(e);
    }
    p?.catch((e) => {
      if (!this.isOpen || this.hold) return;
      if (e?.name === 'NotAllowedError') {
        // 소리 있는 재생을 막는 브라우저: 소리 없이 틀고 단추로 켜게 한다
        v.muted = true;
        this.el.sound.hidden = false;
        v.play().catch(() => this.failVideo());
      } else if (e?.name !== 'AbortError') {
        this.failVideo();
      }
    });
  }

  // ── 받기 ─────────────────────────────────────
  bufferedEnd() {
    const v = this.el.video;
    const b = v.buffered;
    const t = v.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i);
    return t;
  }

  fullyBuffered() {
    const v = this.el.video;
    return v.duration > 0 && this.bufferedEnd() >= v.duration - 0.1;
  }

  startHold(reason) {
    if (this.hold || this.noHold || !this.isOpen || this.ending) return;
    const now = performance.now();
    this.hold = { reason, samples: [], lastEnd: -1, lastChange: now, since: now };
    this.el.video.pause();
    this.loadLog.push({ t: Math.round(now), reason });
    clearInterval(this.timers.hold);
    this.timers.hold = setInterval(() => this.checkHold(), HOLD_POLL_MS);
    this.checkHold();
  }

  checkHold() {
    const h = this.hold;
    if (!h) return;
    const v = this.el.video;
    const now = performance.now();
    const end = this.bufferedEnd();
    if (end !== h.lastEnd) {
      h.lastEnd = end;
      h.lastChange = now;
    }
    h.samples.push([now, end]);
    while (h.samples.length > 2 && now - h.samples[0][0] > 2500) h.samples.shift();
    const dur = v.duration;
    if (!(dur > 0)) {
      this.updateLoad(null);
      if (now - h.lastChange > HOLD_STALL_MS && h.samples.length > HOLD_MIN_SAMPLES) this.endHold(true);
      return;
    }
    const remaining = Math.max(0, dur - v.currentTime);
    const ahead = end - v.currentTime;
    const [t0, e0] = h.samples[0];
    const rate = now > t0 ? (end - e0) / ((now - t0) / 1000) : 0; // 영상 초 / 실제 초
    const need = Math.min(remaining, remaining * Math.max(0, 1 - rate / RATE_SAFETY) + BUFFER_MARGIN_S);
    const progress = need > 0 ? Math.min(1, Math.max(0, ahead / need)) : 1;
    this.updateLoad(progress);
    if (ahead >= remaining - 0.1 || (h.samples.length >= HOLD_MIN_SAMPLES && ahead >= need && v.readyState >= 3)) {
      this.endHold(false);
    } else if (now - h.lastChange > HOLD_STALL_MS) {
      this.endHold(true);
    }
  }

  endHold(gaveUp) {
    if (!this.hold) return;
    clearInterval(this.timers.hold);
    const h = this.hold;
    this.hold = null;
    const last = this.loadLog[this.loadLog.length - 1];
    if (last) last.ms = Math.round(performance.now() - h.since);
    if (gaveUp) this.noHold = true; // 멈춰 둔 동안 안 받는 브라우저: 앞으로는 틀면서 받게 둔다
    this.updateLoad();
    if (this.isOpen && !this.ending) this.playQuiet();
  }

  onWaiting() {
    if (!this.isOpen || this.ending) return;
    this.stalled = true;
    // 다 받아 놓고 디코딩만 기다리는 경우(틀기 직전에 잠깐)는 멈춰 둘 필요가 없다
    if (!this.noHold && !this.hold && !this.fullyBuffered()) this.startHold('waiting');
    else this.updateLoad();
  }

  // "불러오는 중" 표시. progress: 0~1, null이면 % 없이
  updateLoad(progress) {
    const show = this.isOpen && !this.ending && (!!this.hold || this.stalled);
    this.el.load.hidden = !show;
    if (show) {
      const pct = progress == null ? '' : ` ${Math.round(progress * 100)}%`;
      this.el.loadText.textContent = `불러오는 중…${pct}`;
    }
    this.updateHint();
  }

  markFrame() {
    // 첫 장면이 실제로 그려진 뒤에 판을 보인다(검은 판이 번쩍이지 않게)
    const v = this.el.video;
    const ready = () => {
      this.hasFrame = true;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(ready);
    else requestAnimationFrame(ready);
  }

  setMode(mode) {
    if (this.mode !== mode) this.log.push({ t: Math.round(performance.now()), mode });
    this.mode = mode;
    this.el.layer.dataset.mode = mode;
    this.updateHint();
  }

  // "포스터를 비추면 포스터 위로 돌아가요": 돌아갈 수 있을 때만(겹칠 포스터가 있고, 지금 겹칠 수 없는 포스터를 보고 있지 않을 때)
  updateHint() {
    const loading = !this.el.load.hidden;
    this.el.hint.hidden = !(this.mode === 'pinned' && this.overlayIdx.size > 0 && !this.ending && !loading && !this.plainDontVisible());
  }

  // MindAR 이벤트(허브가 넘겨준다)
  onFound(i) {
    if (!this.isOpen) return;
    this.updateHint();
    if (!this.overlayIdx.has(i)) return;
    clearTimeout(this.timers.lost);
    if (this.mode === 'pinned' && !this.ending) {
      clearTimeout(this.timers.found);
      this.timers.found = setTimeout(() => {
        if (this.isOpen && this.ar?.isVisible(i)) this.setMode('ar');
      }, FOUND_GRACE_MS);
    }
  }

  onLost(i) {
    if (!this.isOpen) return;
    this.updateHint();
    if (!this.overlayIdx.has(i)) return;
    clearTimeout(this.timers.found);
    if (this.mode === 'ar') {
      clearTimeout(this.timers.lost);
      this.timers.lost = setTimeout(() => {
        if (this.isOpen && this.overlayVisible() < 0) this.setMode('pinned');
      }, LOST_GRACE_MS);
    }
  }

  // 매 프레임(MindAR 렌더 루프): 판의 투명도·밝기를 목표값으로 옮긴다
  tick() {
    const now = performance.now();
    const dt = Math.min(100, now - (this.lastTick || now));
    this.lastTick = now;
    if (!this.material) return;
    const wantOpacity = this.isOpen && this.mode === 'ar' && this.hasFrame ? 1 : 0;
    const wantBright = this.ending ? 0 : 1;
    const fadeIn = reduceMotion.matches ? 1 : Math.min(1, dt / FADE_IN_MS);
    const fadeOut = reduceMotion.matches ? 1 : Math.min(1, dt / FADE_OUT_MS);
    this.opacity += (wantOpacity - this.opacity) * (wantOpacity > this.opacity ? fadeIn * 2 : fadeIn);
    if (Math.abs(wantOpacity - this.opacity) < 0.01) this.opacity = wantOpacity;
    this.bright += Math.sign(wantBright - this.bright) * Math.min(Math.abs(wantBright - this.bright), fadeOut);
    this.material.opacity = this.opacity;
    this.material.color.setScalar(this.bright);
    if (this.ar) this.ar.renderWanted = this.isOpen || this.opacity > 0;
  }

  stopHold() {
    clearInterval(this.timers.hold);
    this.hold = null;
    this.stalled = false;
  }

  finish() {
    if (!this.isOpen || this.ending) return;
    this.ending = true;
    this.stopHold();
    this.updateLoad();
    this.el.layer.classList.add('is-ending');
    clearTimeout(this.timers.end);
    this.timers.end = setTimeout(() => this.showEnd(), reduceMotion.matches ? 0 : END_PANEL_DELAY_MS);
  }

  showEnd(message) {
    if (!this.isOpen) return;
    this.el.msg.hidden = !message;
    if (message) this.el.msg.textContent = message;
    this.el.end.hidden = false;
    this.el.replay.hidden = !!message;
    (message ? this.el.other : this.el.replay).focus({ preventScroll: true });
  }

  failVideo() {
    if (!this.isOpen) return;
    this.ending = true;
    this.stopHold();
    this.updateLoad();
    this.el.layer.classList.add('is-ending');
    this.showEnd('영상을 불러오지 못했어요');
  }

  replay() {
    this.el.end.hidden = true;
    this.el.layer.classList.remove('is-ending');
    this.ending = false;
    this.bright = 1;
    const v = this.el.video;
    v.currentTime = 0;
    this.startPlayback();
    const i = this.overlayVisible();
    this.setMode(!this.ar ? 'screen' : i >= 0 ? 'ar' : 'pinned');
  }

  // 화면이 가려지면(다른 앱으로) 멈춘다. 돌아오면 끝 화면에서 다시 보기를 고른다
  suspend() {
    if (!this.isOpen) return;
    this.stopHold();
    this.el.video.pause();
    this.ending = true;
    this.updateLoad();
    this.el.layer.classList.add('is-ending');
    this.showEnd();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearTimeout(this.timers.lost);
    clearTimeout(this.timers.found);
    clearTimeout(this.timers.end);
    this.stopHold();
    const v = this.el.video;
    v.pause();
    this.hasFrame = false;
    this.opacity = 0;
    if (this.material) this.material.opacity = 0;
    this.el.load.hidden = true;
    this.el.layer.hidden = true;
    this.el.layer.classList.remove('is-ending');
  }

  exit() {
    this.close();
    this.onExit?.();
  }

  // 시험용 상태
  debug() {
    const v = this.el.video;
    return {
      open: this.isOpen,
      mode: this.mode,
      ending: this.ending,
      opacity: Number(this.opacity.toFixed(3)),
      time: Number(v.currentTime.toFixed(2)),
      paused: v.paused,
      muted: v.muted,
      ready: v.readyState,
      loading: !this.el.load.hidden,
      hint: !this.el.hint.hidden,
      holds: this.loadLog.slice(-12),
      log: this.log.slice(-12),
    };
  }
}
