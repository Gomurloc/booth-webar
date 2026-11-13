// 포스터 AR(otr/?ar=1): OFF THE RECORD 포스터를 알아보고, 캐릭터 둘을 포스터 앞 바닥에 사람 크기로 세운다.
// 캐릭터는 2.5D 판(늘 카메라를 본다)이고, 자리·크기만 세계를 따른다. 매 프레임 발·머리 점을 화면에 투영해
// 기존 합성기의 배치(cx, feetY, heightFrac)로 넘기므로 그림자·색 맞춤·입자감·사람 가림이 그대로 돈다.
//
// 흐름
// - 인식: MindAR 1.2.5 인식기(Controller)만 쓴다(렌더러 없음). 앱의 카메라 영상을 긴 변 960으로 줄여 넣는다.
//   MindAR가 가정하는 화각(세로 45도)을 폰 카메라 화각(설정, 긴 변 63도)으로 바꿔 넣어서 포스터 밖의 점(바닥)도 제자리에 투영한다.
// - 처리 주기: 추적은 약 20번/초(사이 프레임은 자이로로 메운다), 찾기(무거움)는 포스터를 찾는 동안 약 80ms마다.
//   잡아 둔 자리가 있으면(놓친 동안) 예측 자세 추적을 먼저 하고, 찾기는 예측한 포스터가 화면 안이면 0.5초마다
//   (예측 자리 둘레 한 칸과 화면 가운데 칸을 번갈아), 화면 밖이면 1.5초마다. 카운트다운 중에는 찾지 않는다. 결과 화면·숨김에서는 멈춘다.
// - 놓쳤을 때: 마지막 자세를 붙잡고, 그 뒤 폰이 돈 만큼(deviceorientation)을 카메라 좌표에 곱해 캐릭터를 세계에 붙여 둔다.
//   자이로가 없으면 화면에 그대로 멈춘다(폰을 세로↔가로로 돌린 것만은 화면 각으로 맞춘다). 예측한 자세로 추적을 먼저 시도해서
//   포스터가 다시 보이면 찾기 없이 바로 붙고, 0.3초 동안 이어 붙인다(점프 없이). 추적 중에도 자이로로 다음 자세를 예측한다.
// - 자이로 시각: 카메라 영상은 찍힌 뒤 수십 ms 늦게 화면에 온다. 자이로 값을 1.5초 기록해 두고, 그 프레임이 찍힌 시각
//   (requestVideoFrameCallback의 captureTime, 없으면 50ms 전으로 봄)의 값을 보간해 쓴다. 그 둘레 ±40ms(지금보다 앞서지 않게)를
//   평균해 센서 잡음을 거른다(가운데 맞춘 창이라 늦어지지 않는다).
// - 걸어 나오기: 처음 잡았을 때(또는 다른 포스터·다시 불러오기) 한 번, 포스터 그림 속 자리에서 바닥 자리로 1.5초.
//   착지 자리가 화면에 다 안 들어오면(포스터에 너무 가까움) 포스터 그림 자리에서 다 드러난 채 기다린다(앱이 release를 부른다).
// - 중력·벽 방향: 자이로가 있으면 포스터가 수직 벽에 똑바로 걸렸다고 보고 자세의 기울기를 중력에 맞추고(세계.js upright),
//   벽이 바라보는 방위는 처음 잘 맞은 프레임들의 평균으로 붙잡아 둔다(작은 포스터는 이 방향을 몇 도씩 틀리게 잡는다).
// - 가림: 사람이 포스터를 가리기 시작하면 맞춘 특징점이 줄며 자세가 틀어진다. 화면 안에 들어온 점 중 맞춘 비율이
//   기준(잘 맞을 때 비율의 0.6배, 0.3~0.5)을 넘을 때만 자리를 고친다. 기준을 상대값으로 둔 것은 실제 인쇄물·조명에서
//   비율이 렌더 그림(0.94~1.0)보다 낮게 나올 수 있어서다.
import { videoToView } from './화면.js';
import {
  POSTER_WIDTH_M,
  apply4,
  rotate4,
  glToMvt,
  intrinsics,
  projectInput,
  posterToObject,
  cameraMatrixQ,
  screenMatrix,
  cameraDelta,
  quatFromOrientation,
  qalign,
  qslerp,
  qmean,
  OneEuro,
  placementFromPoints,
  upright,
  wallAzimuth,
  lerpPlacementAR,
  stepOut,
  STEP_OUT_MS,
  STEP_WAIT_U,
} from './세계.js';

const TRACK_LONG = 960; // 인식 입력 긴 변(px). 2.6m 거리의 B2 포스터가 약 150px(추적 기준 그림 128px 이상)
const TRACK_MS = 50; // 추적 최소 간격(약 20번/초)
const DETECT_MS = 80; // 포스터를 찾는 동안 찾기 최소 간격
const DETECT_NEAR_MS = 500; // 놓친 동안, 예측한 포스터가 화면 안일 때 찾기 간격(찾기 메인 스레드 시간의 6배보다 짧게는 안 한다)
const DETECT_FAR_MS = 1500; // 예측한 포스터가 화면 밖일 때(폰을 다른 데로 돌림. 예측이 틀렸을 때를 위해 가끔은 찾는다)
const WARMUP = 5; // 찾은 뒤 이만큼 연달아 추적되면 잡았다고 본다(MindAR 기본값)
const WARMUP_PREDICTED = 2; // 예측 자세에서 다시 붙을 때(이미 어디 있는지 안다)
const MISS = 5; // 이만큼 연달아 놓치면 놓쳤다고 본다
const BLEND_MS = 300; // 다시 붙을 때 이어 붙이는 시간
// 맞춘 특징점 비율 기준: 잘 맞을 때 비율(qRef)의 Q_REL배, Q_MIN~Q_GOOD 사이. 처음 잡기 전에는 Q_START
const Q_GOOD = 0.5;
const Q_MIN = 0.3;
const Q_REL = 0.6;
const Q_START = 0.35;
const Q_REF_DECAY_MS = 20_000; // qRef가 내려가는 시간 상수(잠깐 가려진 동안 기준이 같이 내려가지 않게 느리게)
const PREDICT_MAX_JUMP = 0.25; // 예측 자세에서 붙은 결과가 예측과 포스터 폭의 25% 넘게 다르면 버린다(엉뚱한 곳에 붙음)
// 벽이 바라보는 방향(지구 좌표 방위)은 바뀌지 않는다. 작은 포스터는 이 방향을 몇 도씩 틀리게 잡고(평면 자세의 모호함) 그대로
// 따라가기도 해서(시험: 빠르게 돌린 뒤 바닥 자리 100px 어긋남), 처음 잘 맞은 프레임들의 평균을 쓰고 천천히만 따라간다
const AZ_INIT = 15; // 처음 이만큼은 그냥 평균
const AZ_GATE = (5 * Math.PI) / 180; // 평균에서 이보다 먼 값은 버린다
const AZ_FOLLOW = 0.01; // 그 뒤 따라가는 비율(자이로 방위가 천천히 흐르는 것만 따라간다)
const AZ_RESET_MS = 4000; // 버리는 값만 이만큼 이어지면(평균이 틀렸다) 다시 잰다
const LOAD_TIMEOUT_MS = 40_000;
const CAM_LAG_MS = 50; // captureTime을 모를 때 카메라 프레임이 찍힌 뒤 화면에 오기까지로 보는 시간
const GYRO_KEEP_MS = 1500; // 자이로 기록 길이
const GYRO_TAU_MS = 40; // 자이로 평균 반폭
const WAIT_MAX_MS = 8000; // 착지 자리가 화면에 안 들어와도 이만큼 기다리면 걸어 나온다(물러날 자리가 없는 부스)
const NEAR_FADE = [1.5, 2.0]; // 캐릭터 키가 화면 높이의 이 배율 사이면 흐려지고 넘으면 안 그린다(카메라가 캐릭터 바로 앞)
const CTRL_KEEP = 2; // 영상 크기별 인식기를 이만큼 붙잡아 둔다(세로↔가로를 다시 돌릴 때 다시 만드는 멈춤이 없게)

// 포스터마다 걸어 나오기 시작 자리: 포스터 그림 속 캐릭터(포스터 폭·높이 비율). x = 발 가로 위치, top = 머리 꼭대기, h = 키(포스터 높이 배)
// 3U_Main은 포스터에 그려진 우주인(왼쪽)·아리아(오른쪽) 자리에서(2026-11-13 1000x1438 렌더에서 잼). 없는 포스터는 가운데에서
export const POSTERS = [
  {
    id: '3U_Main',
    start: { record: { x: 0.3, top: 0.27, h: 0.72 }, aria: { x: 0.72, top: 0.45, h: 0.58 } },
  },
  { id: '3U_Second', start: null },
];
const CENTER_START = [{ x: 0.42, top: 0.36, h: 0.42 }, { x: 0.58, top: 0.36, h: 0.42 }];

const screenAngle = () => {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return Number.isFinite(a) ? a : 0;
};

// deviceorientation 받기. iOS는 사용자 동작 안에서 허락을 받아야 한다(requestOrientation)
// - 받은 값은 시각과 함께 1.5초 기록한다(카메라 프레임이 찍힌 시각의 값을 쓰려고).
// - 한 번이라도 받았으면 계속 쓴다: 크로미움은 각도가 0.1도 넘게 바뀔 때만 이벤트를 보내서, 폰을 가만히 받치면 이벤트가 끊긴다.
// - 페이지가 숨겨지면 기록을 지운다(돌아오면 방위 기준이 새로 잡힐 수 있다). onReset으로 알린다
export class Gyro {
  constructor() {
    this.hist = []; // { t, q } 지구←기기 사원수
    this.events = 0;
    this.resets = 0;
    this.onReset = null;
    this.on = (e) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const now = performance.now();
      let t = e.timeStamp;
      if (!(t > now - 1000 && t <= now + 1)) t = now; // 옛 브라우저는 timeStamp 기준이 다르다
      const last = this.hist[this.hist.length - 1];
      let q = quatFromOrientation(e.alpha, e.beta, e.gamma);
      if (last) {
        q = qalign(last.q, q);
        if (t <= last.t) t = last.t + 0.01;
      }
      this.hist.push({ t, q });
      while (this.hist.length > 2 && this.hist[0].t < t - GYRO_KEEP_MS) this.hist.shift();
      this.events++;
    };
    this.onVis = () => {
      if (document.hidden) this.reset();
    };
    addEventListener('deviceorientation', this.on);
    document.addEventListener('visibilitychange', this.onVis);
  }

  get available() {
    return this.hist.length > 0;
  }

  reset() {
    if (!this.hist.length) return;
    this.hist = [];
    this.resets++;
    this.onReset?.();
  }

  // 시각 t의 기기 방향(기록 사이는 구면 보간, 밖이면 끝 값)
  quatAt(t) {
    const h = this.hist;
    if (t <= h[0].t) return h[0].q;
    const n = h.length - 1;
    if (t >= h[n].t) return h[n].q;
    let i = n;
    while (i > 0 && h[i - 1].t > t) i--;
    const a = h[i - 1];
    const b = h[i];
    return qslerp(a.q, b.q, (t - a.t) / (b.t - a.t));
  }

  // 시각 t(카메라 프레임이 찍힌 때)의 지구←카메라 회전(GL 축). 없으면 null
  matrix(t, front) {
    if (!this.hist.length) return null;
    const latest = this.hist[this.hist.length - 1].t;
    const tau = Math.max(0, Math.min(GYRO_TAU_MS, latest - t));
    let q;
    if (tau < 4) q = this.quatAt(t);
    else {
      const list = [];
      for (let k = -4; k <= 4; k++) list.push(this.quatAt(t + (k / 4) * tau));
      q = qmean(list);
    }
    return cameraMatrixQ(q, screenAngle(), front);
  }

  stop() {
    removeEventListener('deviceorientation', this.on);
    document.removeEventListener('visibilitychange', this.onVis);
  }
}

// iOS 13+: 자이로 허락. 결과: 'granted' | 'denied' | 'prompt'(아직 안 물었고 지금은 물을 수 없음: 사용자 동작이 아니었다) | 'unneeded'.
// 이미 정해진 허락(같은 주소에서 받은 것)은 사용자 동작 없이 불러도 창 없이 돌아온다
let permission = null;
export function needsOrientationPermission() {
  const D = window.DeviceOrientationEvent;
  return !!D && typeof D.requestPermission === 'function';
}
export function requestOrientation() {
  if (!needsOrientationPermission()) return Promise.resolve('unneeded');
  if (permission) return Promise.resolve(permission);
  let p;
  try {
    p = window.DeviceOrientationEvent.requestPermission();
  } catch {
    return Promise.resolve('prompt');
  }
  return Promise.resolve(p).then(
    (r) => (permission = r === 'granted' ? 'granted' : 'denied'),
    () => 'prompt', // NotAllowedError: 사용자 동작 밖이라 묻지 못했다. 다음 탭에서 다시
  );
}

export class PosterAR {
  // video: 앱의 카메라 <video>, targetsUrl·vendorUrl: 주소, world(): 지금 설정(posterHeight, standOff, posterWidth, fov, chars),
  // front(): 앞 카메라인가, reduced(): 움직임 줄이기, onStatus(status): 상태가 바뀔 때, camLag: 시험용 카메라 지연(ms, 없으면 null)
  constructor({ video, targetsUrl, vendorUrl, world, front, reduced, onStatus, camLag = null }) {
    Object.assign(this, { video, targetsUrl, vendorUrl, world, front, reduced, onStatus, camLag });
    this.status = 'loading'; // loading → scanning → live ⇄ hold, 또는 failed
    this.gyro = new Gyro();
    this.gyro.onReset = () => this.dropGyro();
    this.ctrl = null;
    this.ctrls = new Map(); // 영상 크기·화각별 인식기 { ctrl, input, inputCtx, K, scale, videoSize, fov, crops, used }
    this.dims = null;
    this.buffer = null;
    this.running = false;
    this.paused = false;
    this.detectPaused = false; // 카운트다운 중
    this.token = 0;
    this.gen = 0; // forget·다시 만들기마다 늘린다(기다리는 사이 바뀌었으면 결과를 버린다)
    this.track = null; // { index, mvt, G(GL), R, angle, count, predicted }
    this.pose = null; // 잡은 자세 { index, G(거른 GL), R(그때 카메라 회전), angle(그때 화면 각), t }
    this.held = null; // 다시 붙을 때 이어 붙일 앞 자세
    this.blendAt = 0;
    this.anchor = null; // { index, at(걸어 나오기 시작 시각), wait(착지 자리를 기다리는 중), since }
    this.filter = new OneEuro();
    this.missed = 0;
    this.errors = 0;
    this.qRef = 0;
    this.qRefAt = 0;
    this.lastQ = 0;
    this.lastDetect = 0;
    this.lastLoop = 0;
    this.cropN = 0;
    this.frameMeta = null; // 카메라 영상 최근 프레임 { cap, pres, at }
    this.perf = { detectMs: 0, detectMainMs: 0, trackMs: 0, trackMainMs: 0, loops: 0, detects: 0, tracks: 0, since: performance.now(), rate: 0, relocks: 0, relockTries: 0, rebuilds: 0 };
    this.error = null;
    this.watchFrames();
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  // 카메라 영상 프레임이 찍힌 시각을 받아 둔다(자이로 값을 그 시각에 맞춘다)
  watchFrames() {
    const v = this.video;
    if (typeof v?.requestVideoFrameCallback !== 'function') return;
    const gen = (this.frameGen = (this.frameGen ?? 0) + 1);
    const cb = (now, m) => {
      if (gen !== this.frameGen || this.stopped) return;
      this.frameMeta = { cap: m?.captureTime, pres: m?.presentationTime ?? now, at: performance.now() };
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }

  // 지금 보이는(그리고 인식에 넣는) 카메라 프레임이 찍힌 시각
  frameTime() {
    const now = performance.now();
    const m = this.frameMeta;
    // 영상을 바꾸면(카메라 다시 열기) 콜백이 끊길 수 있다: 1초 넘게 소식이 없으면 다시 건다
    if (m && now - m.at > 1000 && this.video.readyState >= 2 && !this.video.paused) this.watchFrames();
    if (this.camLag != null) return (m?.pres ?? now) - this.camLag;
    if (m && Number.isFinite(m.cap) && m.cap > 0 && m.cap <= now + 1 && now - m.cap < 1000) return m.cap;
    return (m && now - m.at < 1000 ? m.pres : now) - CAM_LAG_MS;
  }

  // 인식 도구·대상 파일을 받고 인식기를 만든다. 실패하면 던진다(앱은 포스터 없이로 넘어간다)
  async start() {
    const token = ++this.token;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('인식 준비 시간 초과')), LOAD_TIMEOUT_MS));
    const ready = (async () => {
      const [mod, buffer] = await Promise.all([
        import(this.vendorUrl),
        this.buffer ?? fetch(this.targetsUrl).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
      ]);
      this.mod = mod;
      this.buffer = buffer;
      if (token !== this.token) return;
      this.build();
    })();
    try {
      await Promise.race([ready, timeout]);
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.setStatus('failed');
      this.stop();
      throw e;
    }
    if (token !== this.token) return;
    this.running = true;
    this.setStatus(this.pose ? 'hold' : 'scanning');
    this.loop(token);
  }

  // 지금 영상 크기·화각에 맞는 인식기를 쓴다. 처음 보는 크기면 만든다(셰이더 컴파일로 1~2초 멈춘다), 본 적 있으면 다시 쓴다
  build() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('카메라 영상 없음');
    const fov = this.world().fov;
    const key = `${vw}x${vh}@${fov}`;
    let c = this.ctrls.get(key);
    if (!c) {
      c = this.makeCtrl(vw, vh, fov);
      this.ctrls.set(key, c);
      this.perf.rebuilds++;
      // 오래 안 쓴 것부터 정리
      while (this.ctrls.size > CTRL_KEEP) {
        let oldKey = null;
        for (const [k, v] of this.ctrls) if (k !== key && (!oldKey || v.used < this.ctrls.get(oldKey).used)) oldKey = k;
        this.disposeCtrl(this.ctrls.get(oldKey));
        this.ctrls.delete(oldKey);
      }
    }
    c.used = performance.now();
    Object.assign(this, { ctrl: c.ctrl, input: c.input, inputCtx: c.inputCtx, K: c.K, scale: c.scale, videoSize: c.videoSize, fov: c.fov, crops: c.crops });
    this.dims = c.ctrl.markerDimensions;
    this.track = null;
    this.gen++;
  }

  makeCtrl(vw, vh, fov) {
    const s = Math.min(1, TRACK_LONG / Math.max(vw, vh));
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    const input = document.createElement('canvas');
    input.width = w;
    input.height = h;
    const inputCtx = input.getContext('2d');
    const ctrl = new this.mod.Controller({ inputWidth: w, inputHeight: h, maxTrack: 1 });
    // 화각: MindAR는 세로 45도로 본다. 폰 카메라에 맞춘 초점 거리로 바꿔 넣는다(대상 파일을 넣기 전에: 추적기·워커가 이 값을 가져간다)
    const K = intrinsics(w, h, fov);
    ctrl.projectionTransform = [
      [K.f, 0, w / 2],
      [0, K.f, h / 2],
      [0, 0, 1],
    ];
    ctrl.projectionMatrix = ctrl._glProjectionMatrix({ projectionTransform: ctrl.projectionTransform, width: w, height: h, near: 10, far: 100000 });
    ctrl.addImageTargetsFromBuffer(this.buffer.slice(0));
    inputCtx.drawImage(this.video, 0, 0, w, h);
    ctrl.dummyRun(input); // 셰이더 컴파일(첫 프레임이 느린 것을 여기서 치른다)
    return { ctrl, input, inputCtx, K, scale: { x: w / vw, y: h / vh }, videoSize: { w: vw, h: vh }, fov, crops: makeCrops(w, h, ctrl.cropDetector.cropSize), used: 0 };
  }

  disposeCtrl(entry) {
    const c = entry?.ctrl;
    if (!c) return;
    // 처리 중인 워커 답이 있을 수 있어 잠시 뒤에 정리한다(허브 ar.js와 같은 방식)
    setTimeout(() => {
      try {
        c.worker?.terminate();
      } catch {}
      const t = c.tracker;
      const held = [t?.featurePointsListT, t?.imagePixelsListT, t?.imagePropertiesListT];
      for (const cache of Object.values(c.cropDetector?.detector?.tensorCaches ?? {})) held.push(Object.values(cache ?? {}));
      for (const list of held) {
        for (const x of list ?? []) {
          try {
            x?.dispose?.();
          } catch {}
        }
      }
    }, 1500);
  }

  // 영상 크기나 화각이 바뀌었다. keep이면(같은 카메라를 세로↔가로로 돌림·해상도만 바뀜) 잡은 자리·걸어 나오기·벽 방위를 그대로 둔다:
  // 자세는 카메라 좌표라 화면이 돈 만큼은 자이로 회전차(없으면 화면 각)로 맞고, 초점 거리·축소 비율만 새로 잡으면 된다.
  // 화각을 바꾸면 자세의 거리가 달라지므로 버린다
  async restart({ keep = false } = {}) {
    const token = ++this.token;
    this.running = false;
    if (keep) {
      this.track = null;
      if (this.status === 'live') this.setStatus('hold');
    } else this.forget();
    try {
      this.build();
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.setStatus('failed');
      return;
    }
    if (token !== this.token) return;
    this.running = true;
    this.setStatus(this.pose ? 'hold' : 'scanning');
    this.loop(token);
  }

  // 잡은 자리를 잊는다(다시 불러오기). 다음에 잡으면 다시 걸어 나온다
  forget() {
    this.track = null;
    this.pose = null;
    this.held = null;
    this.anchor = null;
    this.az = null;
    this.missed = 0;
    this.gen++;
    this.filter.reset();
    if (this.ctrl && this.status !== 'failed') this.setStatus('scanning');
  }

  // 자이로 기준이 바뀌었을 수 있다(백그라운드에서 돌아옴): 회전에 묶인 값은 버린다. 붙잡은 캐릭터는 다시 붙을 때까지 화면에 멈춘다
  dropGyro() {
    if (this.pose) this.pose.R = null;
    if (this.held) this.held.R = null;
    if (this.track) this.track.R = null;
    this.az = null;
  }

  pause(on) {
    this.paused = on;
  }

  stop() {
    this.token++;
    this.running = false;
    this.stopped = true;
    this.gyro.stop();
    for (const c of this.ctrls.values()) this.disposeCtrl(c);
    this.ctrls.clear();
    this.ctrl = null;
  }

  // 다시 만들어야 하면 이유: 'fov'(화각 설정을 바꿈, 자세를 버린다) | 'size'(영상 크기만, 자세를 둔다) | null
  needsRebuild() {
    if (!this.ctrl) return null;
    const v = this.video;
    if (this.world().fov !== this.fov) return 'fov';
    if (v.videoWidth && v.videoHeight && (v.videoWidth !== this.videoSize.w || v.videoHeight !== this.videoSize.h)) return 'size';
    return null;
  }

  drawInput() {
    this.inputCtx.drawImage(this.video, 0, 0, this.input.width, this.input.height);
  }

  camR(t = this.frameTime()) {
    return this.gyro.matrix(t, this.front());
  }

  // GL 자세 G(그때 카메라 회전 src.R, 화면 각 src.angle)를 지금 카메라(R, angle)로 옮긴다.
  // 자이로가 없으면 화면 각이 바뀐 만큼(세로↔가로)만 돌린다
  rotated(G, src, R, angle) {
    if (src.R && R) return rotate4(cameraDelta(src.R, R), G);
    if (src.angle != null && src.angle !== angle) {
      const f = this.front();
      return rotate4(cameraDelta(screenMatrix(src.angle, f), screenMatrix(angle, f)), G);
    }
    return G;
  }

  async loop(token) {
    while (this.running && token === this.token) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!this.running || token !== this.token) return;
      const now = performance.now();
      if (this.paused || document.hidden || !this.ctrl || this.video.readyState < 2) continue;
      // 폰이 느려 추적이 오래 걸리면 간격을 벌린다(추적이 메인 스레드를 잡은 시간의 3배 이상 = 메인 스레드의 1/3 이하):
      // 미리보기 프레임을 남겨 둔다. 사이 움직임은 자이로가 메운다.
      // 잡은 시간은 동기 부분만 잰다(await까지 재면 사람 인식 모델을 받는 멈춤 같은 것이 몇 초짜리로 들어가 간격이 몇 초로 벌어지고,
      // 그 사이 찾기도 못 해 포스터를 한참 못 잡았다: 검토의 "잠금 56초·0.5초 톱니")
      if (now - this.lastLoop < Math.max(TRACK_MS, 3 * this.perf.trackMainMs)) continue;
      if (!this.track && !this.pose && (this.detectPaused || now - this.lastDetect < DETECT_MS)) continue;
      this.lastLoop = now;
      try {
        await this.step(now, token);
        this.errors = 0;
      } catch (e) {
        // 인식기 안 오류: 이번 프레임만 버리고 잇는다. 연달아 나면 포기
        this.errors++;
        this.error = String(e?.message ?? e);
        if (this.errors > 20) {
          this.setStatus('failed');
          this.stop();
          return;
        }
      }
      this.perf.loops++;
      if (now - this.perf.since > 1000) {
        this.perf.rate = (this.perf.loops * 1000) / (now - this.perf.since);
        this.perf.loops = 0;
        this.perf.since = now;
      }
    }
  }

  // 맞춘 특징점 비율 기준(위 Q_* 설명)
  qGate() {
    return this.qRef ? Math.min(Q_GOOD, Math.max(Q_MIN, Q_REL * this.qRef)) : Q_START;
  }

  noteQ(q, now) {
    const decayed = this.qRef * Math.exp(-(now - this.qRefAt) / Q_REF_DECAY_MS);
    this.qRef = Math.max(q, decayed);
    this.qRefAt = now;
  }

  async step(now, token) {
    const ctrl = this.ctrl;
    const gen = this.gen;
    this.drawInput();
    const R = this.camR();
    const angle = screenAngle();
    const inputT = ctrl.inputLoader.loadInput(this.input);
    try {
      let mvt = null;
      let index = -1;
      let predicted = false;
      const t0 = performance.now();
      if (this.track) {
        // 추적 중: 자이로로 이번 프레임 자세를 예측해서 넘긴다(빠르게 돌려도 덜 놓친다)
        index = this.track.index;
        const guess = this.track.R && R ? glToMvt(this.rotated(this.track.G, this.track, R, angle), this.dims[index][1]) : this.track.mvt;
        mvt = await this.trackOnce(inputT, guess, index);
        this.perf.trackMs = ema(this.perf.trackMs, performance.now() - t0);
        this.perf.tracks++;
        predicted = this.track?.predicted ?? false;
      } else {
        // 놓친 상태에서 자리를 알면: 예측 자세에서 바로 추적해 본다(포스터가 다시 보이면 찾기 없이 붙는다)
        let G = null;
        let onScreen = false;
        if (this.pose) {
          G = this.rotated(this.pose.G, this.pose, R, angle);
          onScreen = this.posterOnInput(G, this.pose.index);
          if (onScreen) {
            this.perf.relockTries++;
            const tryMvt = await this.trackOnce(inputT, glToMvt(G, this.dims[this.pose.index][1]), this.pose.index);
            if (gen !== this.gen || token !== this.token) return;
            if (tryMvt && this.lastQ >= this.qGate() && this.closeTo(tryMvt, G, this.pose.index)) {
              this.perf.relocks++;
              mvt = tryMvt;
              index = this.pose.index;
              predicted = true;
              this.track = { index, count: 0, predicted: true };
            }
          }
        }
        if (!mvt && !this.detectPaused && performance.now() - this.lastDetect >= this.detectGap(onScreen)) {
          this.lastDetect = performance.now();
          // 찾을 칸(256px 안팎): 놓친 동안은 예측한 포스터 둘레와 화면 가운데·바깥 칸을 번갈아, 찾는 동안은 가운데 칸 위주로 돌아가며
          const crop = G && onScreen && this.cropN % 2 === 0 ? this.cropAround(G, this.pose.index) : this.nextCrop();
          this.cropN++;
          const td = performance.now();
          const r = await this.detectAt(inputT, crop);
          this.perf.detectMs = ema(this.perf.detectMs, performance.now() - td);
          this.perf.detects++;
          if (gen !== this.gen || token !== this.token) return;
          if (r.targetIndex !== -1) {
            index = r.targetIndex;
            mvt = await this.trackOnce(inputT, r.modelViewTransform, index);
            if (mvt) this.track = { index, count: 0, predicted: false };
          }
        }
      }
      // 기다리는 사이 다시 불러오기·카메라 바꾸기·다시 만들기가 있었으면 이 결과는 버린다
      if (!this.running || gen !== this.gen || token !== this.token || this.ctrl !== ctrl) return;
      if (mvt && this.track) {
        const G = ctrl._glModelViewMatrix(mvt, index);
        Object.assign(this.track, { index, mvt, G, R, angle, predicted });
        if (this.lastQ >= this.qGate()) {
          this.noteQ(this.lastQ, now);
          this.track.count++;
          this.missed = 0;
          // 이미 잡고 있던 포스터를 다시 찾았으면(놓친 직후·붙잡은 동안) 짧게만 확인한다: 5프레임을 기다리는 동안 낡은 자세가
          // live로 보였고(멈춤 뒤 옆으로 걸은 시험에서 1.5초·130px), 그 사이 또 놓치면 처음부터 다시 셌다
          const warm = predicted || this.pose?.index === index ? WARMUP_PREDICTED : WARMUP;
          if (this.track.count > warm) this.lock(index, G, R, angle, now);
        } else if (this.status === 'live' && ++this.missed > MISS) {
          this.setStatus('hold'); // 가려져 점이 모자란 채 따라가는 중: 자리는 마지막 좋은 자세 + 자이로
        }
      } else {
        this.track = null;
        if (this.status === 'live' && ++this.missed > MISS) this.setStatus('hold');
      }
    } finally {
      inputT.dispose();
    }
  }

  detectGap(onScreen) {
    if (!this.pose) return DETECT_MS;
    return onScreen ? Math.max(DETECT_NEAR_MS, 6 * this.perf.detectMainMs) : DETECT_FAR_MS;
  }

  // 찾기 한 번(MindAR _detectAndMatch와 같되 찾을 칸을 고른다)
  async detectAt(inputT, crop) {
    const ctrl = this.ctrl;
    const t0 = performance.now();
    const { featurePoints } = ctrl.cropDetector._detect(inputT, crop.x, crop.y);
    this.perf.detectMainMs = ema(this.perf.detectMainMs, Math.min(300, performance.now() - t0));
    this.lastCrop = crop;
    return ctrl._workerMatch(featurePoints, this.dims.map((_, i) => i));
  }

  // 찾는 동안 돌아가며 볼 칸: 가운데 9칸(MindAR detectMoving과 같은 자리) 두 번에 바깥 칸 한 번
  nextCrop() {
    const c = this.crops;
    this.cycle = (this.cycle ?? -1) + 1;
    if (c.outer.length && this.cycle % 3 === 2) {
      this.outerI = ((this.outerI ?? -1) + 1) % c.outer.length;
      return c.outer[this.outerI];
    }
    this.centerI = ((this.centerI ?? -1) + 1) % c.center.length;
    return c.center[this.centerI];
  }

  // 예측한 포스터 가운데 둘레 칸
  cropAround(G, index) {
    const d = this.dims[index];
    const p = projectInput(apply4(G, [d[0] / 2, d[1] / 2, 0]), this.K);
    const cs = this.crops.size;
    if (!p) return this.nextCrop();
    return clampCrop(p[0] - cs / 2, p[1] - cs / 2, this.K.w, this.K.h, cs);
  }

  // MindAR _trackAndUpdate와 같되, 맞춘 특징점 비율(this.lastQ)을 남긴다. 비율은 이 자세로 화면 안에 들어오는 점 중에서 센다
  // (포스터가 화면 밖으로 반쯤 나가도 가려진 것으로 보지 않게). 화면 안 점이 30%도 안 되면 전체로 나눈다(믿기 어렵다)
  async trackOnce(inputT, mvt, index) {
    const ctrl = this.ctrl;
    const t0 = performance.now();
    const { worldCoords, screenCoords } = ctrl.tracker.track(inputT, mvt, index);
    this.perf.trackMainMs = ema(this.perf.trackMainMs, Math.min(150, performance.now() - t0)); // 한 번 튀는 값(셰이더 컴파일)은 150ms로 자른다
    const total = ctrl.tracker.trackingKeyframeList[index]?.points.length || 1;
    const visible = this.visiblePoints(mvt, index);
    const denom = visible >= 0.3 * total ? visible : total;
    this.lastQ = Math.min(1, worldCoords.length / Math.max(1, denom));
    this.perf.q = this.lastQ;
    this.perf.visible = visible / total;
    if (worldCoords.length < 4) return null;
    return ctrl._workerTrackUpdate(mvt, { worldCoords, screenCoords });
  }

  // 자세 mvt(MindAR 내부 3×4)로 추적 기준 그림의 점이 입력 화면 안(여백 6px)에 몇 개 들어오나
  visiblePoints(mvt, index) {
    const kf = this.ctrl.tracker.trackingKeyframeList[index];
    if (!kf) return 0;
    const P = this.ctrl.projectionTransform;
    const m = mvt;
    const mvp = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => P[r][0] * m[0][c] + P[r][1] * m[1][c] + P[r][2] * m[2][c]));
    const W = this.K.w;
    const H = this.K.h;
    const M = 6;
    let n = 0;
    for (const p of kf.points) {
      const x = p.x / kf.scale;
      const y = p.y / kf.scale;
      const h = mvp[2][0] * x + mvp[2][1] * y + mvp[2][3];
      if (!(h > 0)) continue;
      const u = (mvp[0][0] * x + mvp[0][1] * y + mvp[0][3]) / h;
      const v = (mvp[1][0] * x + mvp[1][1] * y + mvp[1][3]) / h;
      if (u >= M && u < W - M && v >= M && v < H - M) n++;
    }
    return n;
  }

  // 잡았다(또는 계속 잡고 있다). 처음이거나 다른 포스터면 걸어 나오기를 시작하고, 붙잡고 있던 자세에서 오면 이어 붙인다
  lock(index, G, R, angle, now) {
    // live인데 자세가 0.25초 넘게 안 바뀌었으면(잠깐 놓쳤다 다시 찾음) 다시 붙는 것처럼 이어 붙인다(낡은 자세에서 튀지 않게)
    const fresh = this.status !== 'live' || (this.pose && now - this.pose.t > 250);
    if (fresh) {
      this.filter.reset();
      if (this.pose && this.anchor?.index === index) {
        this.held = { ...this.pose };
        this.blendAt = now;
      } else {
        this.held = null;
        // 움직임 줄이기면 기다리지 않는다(바닥 자리에서 서서히 나타나기만 한다)
        this.anchor = { index, at: now, wait: !this.reduced(), since: now };
        this.az = null; // 다른 포스터(벽)
      }
    }
    // 자이로가 있으면 포스터를 중력에 맞춰 세우고 벽 방향을 평균에 맞춘다(바닥 자리가 덜 흔들리고 덜 어긋난다).
    // 추적기는 MindAR 자세 그대로 이어 간다
    const Gu = R ? upright(G, R, this.dims[index], this.wallAz(G, R, now)) : G;
    this.pose = { index, G: this.filter.filter(now, Gu), R, angle, t: now };
    this.setStatus('live');
  }

  // 착지 자리가 화면에 들어왔다(앱이 부른다): 포스터 안에서 기다리던 캐릭터가 이어서 걸어 나온다
  release(now = performance.now()) {
    const a = this.anchor;
    if (!a?.wait) return;
    a.wait = false;
    if ((now - a.at) / STEP_OUT_MS > STEP_WAIT_U) a.at = now - STEP_WAIT_U * STEP_OUT_MS;
  }

  // 벽 방위 평균(원형 평균: 단위 벡터 합). 아직 모르면 이번 값
  wallAz(G, R, now) {
    const a = wallAzimuth(G, R);
    if (a == null) return this.az ? Math.atan2(this.az.y, this.az.x) : null;
    const z = this.az;
    // 버리는 값만 AZ_RESET_MS 넘게 이어지면(평균이 틀렸다) 다시 잰다. 놓친 동안(프레임이 안 옴)은 세지 않는다
    if (!z || (z.rejectSince && now - z.rejectSince > AZ_RESET_MS)) {
      this.az = { x: Math.cos(a), y: Math.sin(a), n: 1, rejectSince: 0 };
      return a;
    }
    const mean = Math.atan2(z.y, z.x);
    let d = a - mean;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (z.n < AZ_INIT) {
      z.x += Math.cos(a);
      z.y += Math.sin(a);
      z.n++;
    } else if (Math.abs(d) < AZ_GATE) {
      const m = mean + d * AZ_FOLLOW;
      z.x = Math.cos(m);
      z.y = Math.sin(m);
      z.rejectSince = 0;
    } else if (!z.rejectSince) {
      z.rejectSince = now;
    }
    return Math.atan2(z.y, z.x);
  }

  // 예측 자세에서 포스터 가운데가 입력 화면 안(여유 10%)에 들어오는가
  posterOnInput(G, index) {
    const d = this.dims[index];
    const p = projectInput(apply4(G, [d[0] / 2, d[1] / 2, 0]), this.K);
    if (!p) return false;
    const mx = this.K.w * 0.1;
    const my = this.K.h * 0.1;
    return p[0] > -mx && p[0] < this.K.w + mx && p[1] > -my && p[1] < this.K.h + my;
  }

  // 예측에서 붙은 자세가 예측과 가까운가(포스터 가운데 화면 거리가 포스터 화면 폭의 25% 이내)
  closeTo(mvt, Gpred, index) {
    const G = this.ctrl._glModelViewMatrix(mvt, index);
    const d = this.dims[index];
    const c = [d[0] / 2, d[1] / 2, 0];
    const a = projectInput(apply4(G, c), this.K);
    const b = projectInput(apply4(Gpred, c), this.K);
    const e = projectInput(apply4(Gpred, [d[0], d[1] / 2, 0]), this.K);
    if (!a || !b || !e) return false;
    const half = Math.hypot(e[0] - b[0], e[1] - b[1]);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < PREDICT_MAX_JUMP * 2 * half;
  }

  // 캐릭터 하나의 시작 자리(포스터 그림 속)·바닥 자리(미터, 포스터 좌표)
  spots(id, i, index) {
    const w = this.world();
    const d = this.dims[index];
    const pw = w.posterWidth ?? POSTER_WIDTH_M;
    const posterH = (pw * d[1]) / d[0];
    const c = w.chars[id] ?? { height: 1.6, offset: i === 0 ? -0.55 : 0.55 };
    const st = POSTERS[index]?.start?.[id] ?? CENTER_START[i % 2];
    const startH = st.h * posterH;
    const top = (0.5 - st.top) * posterH;
    return {
      from: { feet: [(st.x - 0.5) * pw, top - startH, 0.002], height: startH },
      to: { feet: [c.offset, -w.posterHeight, w.standOff], height: c.height },
    };
  }

  // 포스터 좌표 점(m) → 보기 정규 좌표. 화면 뒤면 null
  toView(G, index, p, view) {
    const ip = projectInput(apply4(G, posterToObject(p, this.dims[index], this.world().posterWidth ?? POSTER_WIDTH_M)), this.K);
    if (!ip) return null;
    return videoToView(view, ip[0] / this.scale.x, ip[1] / this.scale.y);
  }

  placeAt(G, index, feet, height, view) {
    const f = this.toView(G, index, feet, view);
    const h = this.toView(G, index, [feet[0], feet[1] + height, feet[2]], view);
    if (!f || !h) return null;
    return placementFromPoints(f, h, view.viewW, view.viewH);
  }

  // 지금 카메라로 본 잡은 자세(다시 붙는 중이면 앞 자세와 섞을 것 포함)
  viewPoses(now) {
    const R = this.camR();
    const angle = screenAngle();
    const G = this.rotated(this.pose.G, this.pose, R, angle);
    const Gold = this.held && now - this.blendAt < BLEND_MS ? this.rotated(this.held.G, this.held, R, angle) : null;
    return { G, Gold, k: Gold ? easeInOut((now - this.blendAt) / BLEND_MS) : 1 };
  }

  // 이번 프레임에 그릴 캐릭터: [{ id, placement:{cx, feetY, heightFrac, tilt}, land(착지 자리 배치), fx:{alpha, glow, flash, shadow, reveal}, landed, waiting }]
  // ids: 보일 캐릭터 id(캐릭터.json 순서 중 지금 고른 것), order: 캐릭터.json 전체 순서. fx.alpha가 0이면 그리지 않는다(앱이 거른다)
  items(now, view, ids, order) {
    if (!this.pose || !this.anchor || !this.dims) return [];
    const idx = this.pose.index;
    const { G, Gold, k } = this.viewPoses(now);
    const a = this.anchor;
    const reduced = this.reduced();
    if (a.wait && (reduced || now - a.since > WAIT_MAX_MS)) this.release(now);
    let u = (now - a.at) / STEP_OUT_MS;
    if (a.wait) u = Math.min(u, STEP_WAIT_U);
    const place = (feet, height) => {
      let p = this.placeAt(G, idx, feet, height, view);
      if (p && Gold) {
        const q = this.placeAt(Gold, idx, feet, height, view);
        if (q) p = lerpPlacementAR(q, p, k);
      }
      return p && Number.isFinite(p.cx) && Number.isFinite(p.heightFrac) && p.heightFrac > 0.01 ? p : null;
    };
    const out = [];
    for (const id of ids) {
      const i = order.indexOf(id);
      const { from, to } = this.spots(id, i, idx);
      const s = stepOut(u, from, to, reduced);
      const p = place(s.feet, s.height);
      if (!p) continue;
      const land = place(to.feet, to.height);
      // 카메라가 캐릭터 바로 앞이면(화면 높이의 1.5~2배) 흐리게 지운다: 판이 화면을 덮고 그림 판이 지나치게 커진다
      const near = 1 - smoothstep(NEAR_FADE[0], NEAR_FADE[1], p.heightFrac);
      out.push({
        id,
        placement: p,
        land,
        fx: { alpha: s.alpha * near, glow: s.glow, flash: s.flash, shadow: s.shadow * near, reveal: s.reveal },
        landed: !a.wait && u >= 1,
        waiting: !!a.wait,
      });
    }
    return out;
  }

  // 시험·디버그용: 지금 자세로 본 캐릭터 바닥 자리(발·머리)를 영상 픽셀로
  debug() {
    const now = performance.now();
    const out = {
      status: this.status,
      index: this.pose?.index ?? null,
      anchorAge: this.anchor ? now - this.anchor.at : null,
      waiting: !!this.anchor?.wait,
      gyro: this.gyro.available,
      gyroEvents: this.gyro.events,
      gyroResets: this.gyro.resets,
      camLag: this.frameMeta ? +(now - this.frameTime()).toFixed(1) : null,
      input: this.input ? [this.input.width, this.input.height] : null,
      ctrls: this.ctrls.size,
      poseAge: this.pose ? Math.round(now - this.pose.t) : null,
      poseR: !!this.pose?.R,
      trackCount: this.track?.count ?? null,
      q: this.lastQ,
      qGate: this.qGate(),
      qRef: this.qRef,
      perf: { ...this.perf },
      error: this.error,
      chars: {},
    };
    if (!this.pose || !this.dims) return out;
    const R = this.camR();
    const G = this.rotated(this.pose.G, this.pose, R, screenAngle());
    const w = this.world();
    const pw = w.posterWidth ?? POSTER_WIDTH_M;
    const pt = (p) => {
      const ip = projectInput(apply4(G, posterToObject(p, this.dims[this.pose.index], pw)), this.K);
      return ip ? [ip[0] / this.scale.x, ip[1] / this.scale.y] : null;
    };
    for (const [id, c] of Object.entries(w.chars)) {
      out.chars[id] = { feet: pt([c.offset, -w.posterHeight, w.standOff]), head: pt([c.offset, -w.posterHeight + c.height, w.standOff]) };
    }
    out.posterCenter = pt([0, 0, 0]);
    const d = this.dims[this.pose.index];
    out.depthM = (-apply4(this.pose.G, [d[0] / 2, d[1] / 2, 0])[2] * pw) / d[0];
    return out;
  }
}

// 찾을 칸 목록. 가운데 9칸은 MindAR detectMoving과 같은 자리(가운데부터), 바깥 칸은 그 밖을 덮는 격자(가운데에서 가까운 차례)
function makeCrops(w, h, cs) {
  const center = [];
  for (const i of [4, 1, 7, 3, 5, 0, 2, 6, 8]) {
    const dx = i % 3;
    const dy = Math.floor(i / 3);
    center.push(clampCrop(w / 2 - cs + (dx * cs) / 2, h / 2 - cs + (dy * cs) / 2, w, h, cs));
  }
  const x0 = Math.min(...center.map((c) => c.x));
  const y0 = Math.min(...center.map((c) => c.y));
  const x1 = Math.max(...center.map((c) => c.x + cs));
  const y1 = Math.max(...center.map((c) => c.y + cs));
  const outer = [];
  const steps = (len) => {
    const n = Math.max(1, Math.ceil((len - cs) / (cs / 2))) + 1;
    return Array.from({ length: n }, (_, k) => (n === 1 ? 0 : ((len - cs - 1) * k) / (n - 1)));
  };
  for (const y of steps(h)) {
    for (const x of steps(w)) {
      const c = clampCrop(x, y, w, h, cs);
      const mx = c.x + cs / 2;
      const my = c.y + cs / 2;
      if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1) continue; // 가운데 칸들이 덮는 곳
      outer.push(c);
    }
  }
  outer.sort((a, b) => Math.hypot(a.x + cs / 2 - w / 2, a.y + cs / 2 - h / 2) - Math.hypot(b.x + cs / 2 - w / 2, b.y + cs / 2 - h / 2));
  return { size: cs, center, outer };
}

function clampCrop(x, y, w, h, cs) {
  return { x: Math.max(0, Math.min(w - cs - 1, Math.floor(x))), y: Math.max(0, Math.min(h - cs - 1, Math.floor(y))) };
}

function ema(a, b) {
  return a ? a * 0.8 + b * 0.2 : b;
}

function easeInOut(t) {
  const u = Math.min(1, Math.max(0, t));
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
}

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
