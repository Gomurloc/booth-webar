// 부스 사진 앱 진입점.
// 상태: loading(카메라 켜는 중) → live(미리보기) → countdown → result(찍은 사진), 그리고 error.
// 모드: ?booth=1 부스(직원이 다루는 가로 화면), 없으면 폰(손님 폰, 세로).
// 그 밖의 주소 옵션: ?debug=1 디버그 표시, ?cdn=1 내려받아 둔 라이브러리 대신 CDN, ?qr=<주소> 부스 QR,
// ?model=multiclass|selfie|landscape 사람 인식 모델 강제.
import { makeView, stillView, captureSize, canvasPixelSize, orientationOf, maskBoxToView, cropNorm, sameCrop } from './화면.js';
import {
  defaultPlacement,
  artBox,
  clampPlacement,
  drawOrder,
  hitTest,
  moveBy,
  scaleBy,
  scaleFromHandle,
  autoPlace,
  lerpPlacement,
  easeInOut,
  remapPlacement,
} from './배치.js';
import { Compositor, makeNoise, prepareArt, makeCanvas } from './합성.js';
import { PersonDetector } from './사람.js';
import { FRAMES, FONT, layoutFrame, drawFrame } from './틀.js';
import { canvasToJpeg, makePhotoFile, canShareFile, sharePhoto, downloadPhoto, printPhoto, setPrintPhoto } from './내보내기.js';
import { Sound } from './소리.js';
import { loadSettings, saveSettings } from './설정.js';
import { openCamera, attachVideo, stopStream, listCameras, CameraError } from './카메라.js';

const query = new URLSearchParams(location.search);
const MODE = query.get('booth') === '1' ? 'booth' : 'phone';
const DEBUG = query.get('debug') === '1';
const CDN_ONLY = query.get('cdn') === '1';
const QR_TARGET = query.get('qr');
// 받기.mjs의 QR 경로·버전과 맞춘다
const QR_LIB = {
  local: './라이브러리/qrcode/qrcode.mjs',
  cdn: 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs',
};
const SEG_EVERY = 66; // 사람 인식 주기(ms), 약 15fps
const HANDLE_PX = 30; // 크기 손잡이를 잡는 반경(CSS px)
const AUTO_PLACE_MS = 250;
const STALL_MS = 4000; // 미리보기 영상이 이만큼 멈춰 있으면 카메라를 다시 연다(iOS 백그라운드 복귀, USB 웹캠 끊김)
const ORIENTS = ['landscape', 'portrait'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  video: $('카메라'),
  canvas: $('화면'),
  wordmark: $('워드마크'),
  gear: $('설정버튼'),
  qr: $('큐알'),
  qrCanvas: $('큐알그림'),
  hint: $('도움말'),
  tools: $('편집도구'),
  autoPlace: $('옆에세우기'),
  flip: $('좌우반전'),
  front: $('앞뒤'),
  lock: $('잠금'),
  lockHint: $('잠금안내'),
  cast: $('배역'),
  frameChip: $('틀칩'),
  shutter: $('셔터'),
  switchCam: $('카메라전환'),
  count: $('카운트'),
  flash: $('플래시'),
  toast: $('알림'),
  debug: $('디버그'),
  result: $('결과'),
  resultImg: $('결과사진'),
  frames: $('틀고르기'),
  save: $('저장'),
  print: $('인쇄'),
  again: $('다시찍기'),
  resultHint: $('결과안내'),
  error: $('오류'),
  errorTitle: $('오류제목'),
  errorText: $('오류설명'),
  retry: $('다시시도'),
  settings: $('설정창'),
  settingsClose: $('설정닫기'),
  form: $('설정폼'),
  cameraList: $('카메라목록'),
  defaultFrame: $('기본틀'),
  resetPlacement: $('배치초기화'),
  lockSetting: $('배치잠금설정'),
  fullscreen: $('전체화면'),
};
const ctx = el.canvas.getContext('2d', { alpha: false });

const settings = loadSettings(MODE);
const sound = new Sound({ enabled: settings.sound, booth: MODE === 'booth' });
const noise = makeNoise();
const liveComp = new Compositor({ noise });
const stillComp = new Compositor({ noise, still: true });
const person = new PersonDetector({ mode: MODE, cdnOnly: CDN_ONLY, model: query.get('model'), onChange: onSegChange });

const app = {
  state: 'loading',
  arts: [], // 캐릭터.json 순서
  cast: [], // 지금 보이는 캐릭터 id
  selected: null,
  camera: null,
  camToken: 0,
  errorKind: null,
  facing: 'user', // 폰은 셀카 카메라로 시작
  view: null,
  orient: null, // 마지막으로 그린 화면 방향(바뀌면 잠금 표시를 다시 맞춘다)
  watch: { t: -1, at: 0, moved: false }, // 영상 멈춤 감시
  camCheck: 0,
  drawn: false, // 첫 프레임을 그렸나
  lastSeg: 0,
  anim: null,
  report: [],
  result: null,
  lastBlob: null,
  renderToken: 0,
  countToken: 0,
  idle: { timer: 0, left: 0 },
  wakeLock: null,
  fps: { frames: 0, since: performance.now(), value: 0 },
  debugAt: 0,
  hintTimer: 0,
  canvases: { raw: makeCanvas(), base: makeCanvas(), out: makeCanvas() },
};

// ── 시험·디버그용 고리 ─────────────────────────────
const hooks = {
  ready: false,
  state: 'loading',
  segmentation: person.status,
  shoot: (opts) => shoot(opts),
  setFrame: (id) => setResultFrame(id),
  setCast: (key) => {
    const ids = key === 'both' || key === 'all' ? app.arts.map((a) => a.id) : [].concat(key);
    applyCast(ids, false);
    return app.cast;
  },
  autoPlace: () => autoPlaceNow(),
  lastPhotoBlob: () => app.lastBlob,
  get view() {
    return app.view;
  },
  get placement() {
    return Object.fromEntries(app.arts.map((a) => [a.id, placementFor(a.id)]));
  },
  get stats() {
    return app.report.map((r) => ({ id: r.id, box: r.box, stats: r.stats, params: r.params }));
  },
};
window.__booth = hooks;

// ── 상태 ─────────────────────────────────────────
function setState(s) {
  app.state = s;
  hooks.state = s;
  el.body.dataset.state = s;
  // 결과 화면을 떠나면 대기 타이머를 늘 끈다(결과를 그리는 사이에 돌아간 경우에도 미리보기에서 타이머가 새지 않게)
  if (s !== 'result') {
    clearInterval(app.idle.timer);
    app.idle.timer = 0;
  }
}

// 결과 화면 닫기(사진·인쇄 영역 걷기). 상태는 부르는 쪽이 바꾼다
function closeResult() {
  el.result.hidden = true;
  setPrintPhoto(null);
}

const ERRORS = {
  insecure: ['카메라를 켤 수 없는 주소예요', '카메라는 https 주소나 이 컴퓨터(localhost)에서만 켜져요.', false],
  denied: [
    '카메라 권한이 꺼져 있어요',
    '주소창 왼쪽 자물쇠(사이트 설정)에서 카메라를 허용으로 바꾼 뒤 다시 시도를 눌러 주세요. 아이폰은 설정 → Safari → 카메라에서도 바꿀 수 있어요.',
    true,
  ],
  nocam: ['카메라를 찾지 못했어요', '웹캠이 연결돼 있는지 확인하고 다시 시도를 눌러 주세요. 연결하면 저절로 다시 켜요.', true],
  busy: ['다른 앱이 카메라를 쓰고 있어요', '화상회의나 카메라 앱을 닫고 다시 시도를 눌러 주세요.', true],
  ended: ['카메라 연결이 끊겼어요', '케이블을 다시 꽂으면 저절로 다시 켜요. 안 되면 다시 시도를 눌러 주세요.', true],
  failed: ['카메라를 켜지 못했어요', '다시 시도를 눌러 주세요. 계속되면 페이지를 새로 고쳐 주세요.', true],
  art: ['캐릭터 그림을 불러오지 못했어요', '캐릭터 폴더의 그림 파일과 캐릭터.json을 확인한 뒤 페이지를 새로 고쳐 주세요.', false],
};

function showError(kind) {
  const [title, text, retry] = ERRORS[kind] ?? ERRORS.failed;
  app.errorKind = kind;
  setState('error');
  closeResult();
  el.errorTitle.textContent = title;
  el.errorText.textContent = text;
  el.retry.hidden = !retry;
  el.error.hidden = false;
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    saveSettings(MODE, settings);
  }, 300);
}

// 미뤄 둔 저장을 바로 쓴다(탭을 닫거나 숨길 때. 직원이 배치를 맞춘 직후 닫아도 날아가지 않게)
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  saveSettings(MODE, settings);
}

// ── 카메라 ─────────────────────────────────────────
function stopCamera() {
  clearTimeout(app.camCheck);
  if (!app.camera) return;
  app.camera.track.removeEventListener('ended', onTrackEnded);
  app.camera.track.removeEventListener('mute', onTrackMute);
  app.camera.track.removeEventListener('unmute', onTrackUnmute);
  stopStream(app.camera.stream);
  app.camera = null;
}

// 트랙이 꺼진(muted) 채로 남으면 다시 연다. iOS는 백그라운드에서 꺼졌다가 돌아와도 안 켜지는 일이 있다
function checkCameraSoon(ms) {
  clearTimeout(app.camCheck);
  app.camCheck = setTimeout(() => {
    if (document.visibilityState === 'visible' && app.state === 'live' && app.camera?.track.muted) startCamera();
  }, ms);
}

function onTrackMute() {
  checkCameraSoon(3000);
}

function onTrackUnmute() {
  clearTimeout(app.camCheck);
}

// 영상이 STALL_MS 넘게 멈춰 있으면 카메라를 다시 연다. 이 스트림에서 시간이 한 번이라도 흐른 걸 본 뒤에만
// (시간을 안 올려 주는 브라우저에서 계속 다시 여는 일이 없게)
function watchCamera(now) {
  const w = app.watch;
  const t = el.video.currentTime;
  if (t !== w.t) {
    w.t = t;
    w.at = now;
    if (t > 0) w.moved = true;
    return;
  }
  if (w.moved && app.state === 'live' && !document.hidden && now - w.at > STALL_MS) {
    console.warn('카메라 영상이 멈춰 다시 엽니다');
    startCamera();
  }
}

function onTrackEnded() {
  stopCamera();
  showError('ended');
}

async function startCamera() {
  const token = ++app.camToken;
  stopCamera();
  el.error.hidden = true;
  closeResult(); // 결과 화면에서 설정으로 카메라를 바꿔도 결과가 미리보기 위에 남지 않게
  setState('loading');
  app.watch = { t: -1, at: performance.now(), moved: false };
  app.drawn = false;
  hooks.ready = false;
  try {
    const cam = await openCamera({
      deviceId: settings.cameraId || null,
      facing: settings.cameraId ? null : app.facing,
      resolution: settings.resolution,
    });
    if (token !== app.camToken) return stopStream(cam.stream); // 그사이 다른 카메라를 열었다
    app.camera = cam;
    app.facing = cam.facing;
    cam.track.addEventListener('ended', onTrackEnded);
    cam.track.addEventListener('mute', onTrackMute);
    cam.track.addEventListener('unmute', onTrackUnmute);
    await attachVideo(el.video, cam.stream);
    app.view = null;
    person.reset();
    fillCameraList();
  } catch (e) {
    if (token !== app.camToken) return;
    showError(e instanceof CameraError ? e.kind : 'failed');
  }
}

// 카메라 이름은 권한을 받은 뒤에야 나오므로 카메라를 켤 때마다 목록을 다시 채운다
async function fillCameraList() {
  const cams = await listCameras();
  const keep = settings.cameraId;
  el.cameraList.replaceChildren(new Option('기본 카메라', ''), ...cams.map((c) => new Option(c.label, c.deviceId)));
  el.cameraList.value = cams.some((c) => c.deviceId === keep) ? keep : '';
}

function mirrorNow() {
  if (settings.mirror === 'on') return true;
  if (settings.mirror === 'off') return false;
  return app.facing !== 'environment';
}

// ── 캐릭터·배치 ─────────────────────────────────────
function orientation() {
  return app.view ? orientationOf(app.view.viewW, app.view.viewH) : orientationOf(innerWidth, innerHeight);
}

function viewAspect() {
  return app.view ? app.view.viewW / app.view.viewH : innerWidth / innerHeight;
}

function artOf(id) {
  return app.arts.find((a) => a.id === id);
}

function placementFor(id, o = orientation()) {
  const saved = settings.placements[o][id];
  if (saved) return saved;
  const i = app.arts.findIndex((a) => a.id === id);
  return defaultPlacement(id, o, i, app.arts.length);
}

function setPlacement(id, p) {
  const art = artOf(id);
  if (!art) return;
  settings.placements[orientation()][id] = clampPlacement(p, art, viewAspect());
  if (app.anim) delete app.anim.to[id];
  saveSoon();
}

// 옆에 세우기 애니메이션 중이면 중간값
function shownPlacement(id) {
  const a = app.anim;
  if (a && a.to[id]) return lerpPlacement(a.from[id], a.to[id], easeInOut((performance.now() - a.start) / AUTO_PLACE_MS));
  return placementFor(id);
}

function castItems() {
  return app.arts.filter((a) => app.cast.includes(a.id)).map((a) => ({ art: a, placement: shownPlacement(a.id) }));
}

function isLocked() {
  return MODE === 'booth' && app.arts.length > 0 && app.arts.every((a) => placementFor(a.id).locked);
}

function editMode() {
  return MODE === 'phone' || !isLocked();
}

function canEdit() {
  return app.state === 'live' && editMode();
}

function select(id) {
  app.selected = id;
  el.body.dataset.selected = id ?? 'none';
  if (id) {
    const front = placementFor(id).front;
    el.front.textContent = front === 'person' ? '사람이 앞' : '캐릭터가 앞';
  }
}

function syncEditUi() {
  const on = editMode();
  el.body.dataset.edit = on ? 'on' : 'off';
  el.lockHint.textContent = isLocked() ? '배치 풀기' : '배치 잠금';
  el.lockSetting.textContent = isLocked() ? '배치 풀기' : '배치 잠금';
  if (!on) select(null);
}

// 잠금은 가로·세로 배치 모두에 같이 건다. 한쪽만 잠그면 태블릿이 돌아갔을 때 화면은 잠김으로 보이는데
// 실제로는 손님이 캐릭터를 끌 수 있었다
function toggleLock() {
  if (MODE !== 'booth' || !app.arts.length) return;
  const lock = !isLocked();
  for (const o of ORIENTS) {
    for (const a of app.arts) settings.placements[o][a.id] = { ...placementFor(a.id, o), locked: lock };
  }
  app.anim = null;
  saveSoon();
  syncEditUi();
  if (!lock) select(app.cast[0] ?? null);
  toast(lock ? '배치를 잠갔어요. 손님은 캐릭터를 움직일 수 없어요.' : '배치를 풀었어요. 끌어서 옮기고 L로 다시 잠가요.');
}

function cycleSelected(back) {
  const ids = drawOrder(castItems()).map((i) => i.art.id);
  if (!ids.length) return;
  const i = ids.indexOf(app.selected);
  select(ids[(i + (back ? -1 : 1) + ids.length) % ids.length]);
}

async function loadCharacters() {
  const base = new URL('./캐릭터/', import.meta.url);
  const cfg = await (await fetch(new URL('캐릭터.json', base))).json();
  const arts = await Promise.all(
    cfg.characters.map(async (c) => {
      const img = new Image();
      img.src = new URL(c.file, base).href;
      await img.decode();
      // 빈칸이 있어도 돌게 기본값을 채운다
      return prepareArt(img, {
        id: c.id,
        name: c.name ?? c.id,
        top: c.top ?? 0,
        feet: { x: c.feet?.x ?? 0.5, y: c.feet?.y ?? 1 },
        face: { x: c.face?.x ?? 0.5, y: c.face?.y ?? 0.1, size: c.face?.size ?? 0.4 },
      });
    }),
  );
  app.arts = arts;
  buildCastChips();
  applyCast(settings.cast, false);
  syncEditUi();
}

// 얼굴 썸네일(정사각). 원본 밖으로 나가는 부분은 검정
function faceThumb(art, px = 96) {
  const c = makeCanvas(px, px);
  const g = c.getContext('2d');
  g.fillStyle = '#06070a';
  g.fillRect(0, 0, px, px);
  const side = art.face.size * art.width;
  let sx = art.face.x * art.width - side / 2;
  let sy = art.face.y * art.height - side / 2;
  const k = px / side;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(art.width, sx + side);
  const y1 = Math.min(art.height, sy + side);
  g.imageSmoothingQuality = 'high';
  g.drawImage(art.img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
  return c.toDataURL('image/png');
}

// 캐릭터 고르기. 정확히 둘이면 [둘 다 / 첫째만 / 둘째만] 중 하나, 그 밖에는 캐릭터마다 켜고 끄기
function buildCastChips() {
  const thumbs = new Map(app.arts.map((a) => [a.id, faceThumb(a)]));
  const chip = (ids, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.ids = ids.join(' ');
    b.setAttribute('aria-label', label);
    for (const id of ids) {
      const img = document.createElement('img');
      img.src = thumbs.get(id);
      img.alt = '';
      b.append(img);
    }
    return b;
  };
  if (app.arts.length === 2) {
    const [a, b] = app.arts;
    el.cast.setAttribute('role', 'radiogroup');
    el.cast.replaceChildren(
      chip([a.id, b.id], '두 캐릭터 함께'),
      chip([a.id], `${a.name}만`),
      chip([b.id], `${b.name}만`),
    );
    for (const btn of el.cast.children) btn.setAttribute('role', 'radio');
  } else {
    el.cast.setAttribute('role', 'group');
    el.cast.replaceChildren(...app.arts.map((a) => chip([a.id], a.name)));
  }
  el.cast.hidden = app.arts.length < 2;
}

function onCastClick(e) {
  const btn = e.target.closest('button[data-ids]');
  if (!btn) return;
  const ids = btn.dataset.ids.split(' ');
  if (app.arts.length === 2) return applyCast(ids, true);
  // 여럿일 때는 켜고 끄기. 하나는 남긴다
  const id = ids[0];
  const next = app.cast.includes(id) ? app.cast.filter((x) => x !== id) : [...app.cast, id];
  if (next.length) applyCast(next, true);
}

// 보일 캐릭터를 정한다. 폰은 늘 저장, 부스는 직원이 배치를 푼 상태에서 고를 때만 기본값으로 저장
// (잠긴 부스에서 손님이 고른 것은 그 손님 차례에만 쓰고, 처음 화면으로 돌아가면 직원 기본값으로 돌아간다)
function applyCast(ids, fromUser) {
  const all = app.arts.map((a) => a.id);
  const valid = (ids ?? all).filter((id) => all.includes(id));
  app.cast = all.filter((id) => (valid.length ? valid : all).includes(id));
  for (const b of el.cast.children) {
    const bids = b.dataset.ids.split(' ');
    const pair = app.arts.length === 2;
    const on = pair ? bids.length === app.cast.length && bids.every((id) => app.cast.includes(id)) : app.cast.includes(bids[0]);
    b.setAttribute(pair ? 'aria-checked' : 'aria-pressed', String(on));
  }
  if (app.selected && !app.cast.includes(app.selected)) select(null);
  if (fromUser && (MODE === 'phone' || !isLocked())) {
    settings.cast = app.cast.length === all.length ? null : [...app.cast];
    saveSoon();
  }
}

// ── 사람 인식 ───────────────────────────────────────
function onSegChange(status) {
  el.body.dataset.seg = status.loaded ? 'on' : 'off';
  if (status.failed) toast('사람 인식 없이 진행해요');
}

function autoPlaceNow() {
  const box = person.status.loaded ? person.stableBox() : null;
  if (!box || !app.view) {
    toast('사람이 보이지 않아요. 화면 안에 서 주세요.');
    return false;
  }
  const people = maskBoxToView(app.view, box);
  const chars = app.cast.map((id) => ({ id, placement: placementFor(id), art: artOf(id) }));
  const next = autoPlace({ people, chars, heightRatio: settings.autoHeight, viewAspect: viewAspect() });
  const from = Object.fromEntries(chars.map((c) => [c.id, c.placement]));
  for (const [id, p] of Object.entries(next)) setPlacement(id, p);
  if (!reduceMotion.matches) {
    const to = Object.fromEntries(Object.keys(next).map((id) => [id, placementFor(id)]));
    app.anim = { from, to, start: performance.now() };
  }
  return true;
}

// ── 그리기 ─────────────────────────────────────────
function look() {
  return {
    harmonize: settings.harmonize,
    shadow: settings.shadow,
    grain: settings.grain,
    occlusion: settings.occlusion && person.status.loaded,
  };
}

// 보이는 자르기가 바뀌면(전체 화면 풀기, 창 크기, 폰 주소창) 저장된 배치를 장면에 붙여 옮긴다.
// 기준 자르기는 설정에 같이 저장해서, 다음에 다른 창 크기로 열어도 바닥 표시에 맞춘 발 자리가 그대로다
function anchorPlacements() {
  const o = orientation();
  const cur = cropNorm(app.view);
  const ref = settings.placementCrop[o];
  if (sameCrop(ref, cur)) return;
  if (ref) {
    const saved = settings.placements[o];
    for (const id of Object.keys(saved)) saved[id] = remapPlacement(saved[id], ref, cur, app.view.mirror);
    app.anim = null;
  }
  settings.placementCrop[o] = cur;
  saveSoon();
}

function updateView() {
  const cssW = el.canvas.clientWidth;
  const cssH = el.canvas.clientHeight;
  const { w, h } = canvasPixelSize(cssW, cssH, devicePixelRatio);
  if (el.canvas.width !== w || el.canvas.height !== h) {
    el.canvas.width = w;
    el.canvas.height = h;
  }
  const vw = el.video.videoWidth;
  const vh = el.video.videoHeight;
  const mirror = mirrorNow();
  const v = app.view;
  if (!v || v.videoW !== vw || v.videoH !== vh || v.viewW !== w || v.viewH !== h || v.mirror !== mirror) {
    const cropChanged = !v || v.videoW !== vw || v.videoH !== vh || v.viewW / v.viewH !== w / h;
    app.view = makeView({ videoW: vw, videoH: vh, viewW: w, viewH: h, mirror });
    if (cropChanged) {
      person.reset(); // 마스크는 보이는 자르기에 묶여 있다
      anchorPlacements();
    }
    const o = orientation();
    if (o !== app.orient) {
      app.orient = o;
      syncEditUi(); // 방향마다 배치가 따로라 잠금·편집 표시를 다시 맞춘다
    }
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  const drawing = app.state === 'loading' || app.state === 'live' || app.state === 'countdown';
  if (!drawing || !app.camera || el.video.readyState < 2 || !el.video.videoWidth) return;
  watchCamera(now);
  if (!app.camera) return; // 멈춰서 다시 여는 중
  updateView();
  if (app.anim && now - app.anim.start >= AUTO_PLACE_MS) app.anim = null;

  if (person.ready && !document.hidden && now - app.lastSeg >= SEG_EVERY) {
    app.lastSeg = now;
    person.updateLive(el.video, app.view.crop);
  }

  const mask = person.status.loaded && person.live ? { canvas: person.live.canvas } : null;
  app.report = liveComp.render(ctx, {
    source: el.video,
    view: app.view,
    cast: castItems(),
    mask,
    look: look(),
    now,
    debugTint: DEBUG,
  });
  drawEditOverlay();
  if (DEBUG) drawPeopleBox();

  if (!app.drawn && app.arts.length) {
    app.drawn = true;
    if (app.state === 'loading') setState('live');
    hooks.ready = true;
    onFirstFrame();
  }
  if (DEBUG) updateDebug(now);
}

let firstFrameDone = false;
function onFirstFrame() {
  if (firstFrameDone) return;
  firstFrameDone = true;
  // 미리보기가 먼저 보이게 한 뒤 모델을 받는다(GPU 첫 프레임은 셰이더 컴파일로 잠깐 멈출 수 있다)
  setTimeout(() => person.load(), 300);
  if (MODE === 'phone') {
    el.hint.hidden = false;
    app.hintTimer = setTimeout(hideHint, 7000);
  }
}

function hideHint() {
  clearTimeout(app.hintTimer);
  el.hint.hidden = true;
}

// 고른 캐릭터 둘레 점선과 크기 손잡이(미리보기에만, 사진에는 안 들어간다)
function handlePoint(box) {
  const W = el.canvas.width;
  const H = el.canvas.height;
  const m = 18 * (W / el.canvas.clientWidth);
  return { x: Math.min(W - m, Math.max(m, box.x1 * W)), y: Math.min(H - m, Math.max(m, box.y0 * H)) };
}

function drawEditOverlay() {
  if (!canEdit() || !app.selected || !app.cast.includes(app.selected)) return;
  const W = el.canvas.width;
  const H = el.canvas.height;
  const k = W / el.canvas.clientWidth;
  const b = artBox(shownPlacement(app.selected), artOf(app.selected), W / H);
  ctx.save();
  ctx.strokeStyle = 'rgba(201, 209, 220, 0.9)';
  ctx.lineWidth = 1.5 * k;
  ctx.setLineDash([7 * k, 6 * k]);
  ctx.strokeRect(b.x0 * W, b.y0 * H, b.w * W, b.h * H);
  ctx.setLineDash([]);
  const hp = handlePoint(b);
  ctx.beginPath();
  ctx.arc(hp.x, hp.y, 10 * k, 0, Math.PI * 2);
  ctx.fillStyle = '#c9d1dc';
  ctx.fill();
  ctx.lineWidth = 2 * k;
  ctx.strokeStyle = '#06070a';
  ctx.stroke();
  // 발 지점
  ctx.beginPath();
  ctx.moveTo(b.fx * W - 8 * k, b.fy * H);
  ctx.lineTo(b.fx * W + 8 * k, b.fy * H);
  ctx.strokeStyle = 'rgba(201, 209, 220, 0.9)';
  ctx.lineWidth = 1.5 * k;
  ctx.stroke();
  ctx.restore();
}

// 디버그: 옆에 세우기가 쓰는 사람 상자(최근 중앙값)
function drawPeopleBox() {
  const box = person.status.loaded ? person.stableBox() : null;
  if (!box) return;
  const b = maskBoxToView(app.view, box);
  const W = el.canvas.width;
  const H = el.canvas.height;
  const k = W / el.canvas.clientWidth;
  ctx.save();
  ctx.strokeStyle = 'rgba(201, 209, 220, 0.7)';
  ctx.lineWidth = k;
  ctx.setLineDash([3 * k, 4 * k]);
  ctx.strokeRect(b.x0 * W, b.y0 * H, (b.x1 - b.x0) * W, (b.y1 - b.y0) * H);
  ctx.restore();
}

function updateDebug(now) {
  app.fps.frames++;
  if (now - app.fps.since >= 1000) {
    app.fps.value = Math.round((app.fps.frames * 1000) / (now - app.fps.since));
    app.fps.frames = 0;
    app.fps.since = now;
  }
  if (now - app.debugAt < 250) return;
  app.debugAt = now;
  const f = (x) => (x == null ? '-' : x.toFixed(2));
  const s = person.status;
  const v = app.view;
  const wh = app.report[0]?.whole;
  const lines = [
    `fps ${app.fps.value}  화면 ${v.viewW}x${v.viewH}  영상 ${v.videoW}x${v.videoH}  거울 ${v.mirror ? '켬' : '끔'}`,
    `사람 ${s.loaded ? `${s.model} ${s.delegate} ${s.source} ${s.lastMs.toFixed(1)}ms 덮음 ${f(s.coverage)}` : s.failed ? `실패: ${s.error}` : '불러오는 중'}`,
    `화면 전체 p2 ${f(wh?.p2)} p98 ${f(wh?.p98)}`,
  ];
  for (const r of app.report) {
    const st = r.stats;
    const p = r.params;
    lines.push(
      `${r.id}  둘레 rgb ${st ? st.mean.map(f).join(' ') : '-'} 밝기 ${f(st?.lum)}`,
      `   맞춤 이득 ${p ? p.gains.map(f).join(' ') : '-'} 검정 ${f(p?.black)} 흰색 ${f(p?.white)} 채도 ${f(p?.sat)}`,
    );
  }
  el.debug.textContent = lines.join('\n');
}

// ── 손가락·마우스로 배치 ───────────────────────────
const pointers = new Map();
let gesture = null;

function pointerInfo(e) {
  const r = el.canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, px: e.clientX, py: e.clientY };
}

function hitItems() {
  return drawOrder(castItems()).map((i) => ({ id: i.art.id, box: artBox(i.placement, i.art, viewAspect()) }));
}

function nearHandle(pt) {
  if (!app.selected || !app.cast.includes(app.selected)) return false;
  const hp = handlePoint(artBox(placementFor(app.selected), artOf(app.selected), viewAspect()));
  const k = el.canvas.width / el.canvas.clientWidth;
  const r = el.canvas.getBoundingClientRect();
  const dx = r.left + hp.x / k - pt.px;
  const dy = r.top + hp.y / k - pt.py;
  return Math.hypot(dx, dy) <= HANDLE_PX;
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const id = app.selected ?? hitTest(hitItems(), mid.x, mid.y);
  if (!id) return null;
  select(id);
  return { type: 'pinch', id, start: placementFor(id), d0: Math.max(1, Math.hypot(a.px - b.px, a.py - b.py)), m0: mid };
}

function onPointerDown(e) {
  if (app.state !== 'live') return;
  hideHint();
  if (!canEdit()) return;
  const pt = pointerInfo(e);
  el.canvas.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, pt);
  if (pointers.size === 2) {
    gesture = startPinch();
    return;
  }
  if (pointers.size > 2) return;
  if (nearHandle(pt)) {
    gesture = { type: 'scale', id: app.selected, start: placementFor(app.selected), y0: pt.y };
    return;
  }
  const id = hitTest(hitItems(), pt.x, pt.y);
  select(id ?? (MODE === 'booth' ? app.selected : null));
  gesture = id ? { type: 'move', id, start: placementFor(id), from: pt } : null;
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  const pt = pointerInfo(e);
  pointers.set(e.pointerId, pt);
  if (!gesture || !canEdit()) return;
  const g = gesture;
  if (g.type === 'move') setPlacement(g.id, moveBy(g.start, pt.x - g.from.x, pt.y - g.from.y));
  else if (g.type === 'scale') setPlacement(g.id, scaleFromHandle(g.start, g.y0, pt.y));
  else if (g.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.px - b.px, a.py - b.py);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    setPlacement(g.id, moveBy(scaleBy(g.start, d / g.d0), mid.x - g.m0.x, mid.y - g.m0.y));
  }
}

function onPointerUp(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 1 && gesture?.type === 'pinch') {
    // 두 손가락 중 하나를 떼면 남은 손가락으로 이어서 옮긴다
    const [rest] = pointers.values();
    gesture = { type: 'move', id: gesture.id, start: placementFor(gesture.id), from: rest };
  } else if (pointers.size === 0) gesture = null;
}

function onWheel(e) {
  if (!canEdit()) return;
  const pt = pointerInfo(e);
  const id = app.selected ?? hitTest(hitItems(), pt.x, pt.y);
  if (!id) return;
  e.preventDefault();
  select(id);
  setPlacement(id, scaleBy(placementFor(id), Math.exp(-e.deltaY * 0.0015)));
}

// ── 촬영 ───────────────────────────────────────────
function restartAnimation(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // 같은 애니메이션을 다시 돌리려면 한 번 배치를 읽어야 한다
  node.classList.add(cls);
}

async function shoot({ countdown } = {}) {
  if (app.state !== 'live' || !app.drawn) return null;
  sound.unlock(); // 셔터 클릭·키는 사용자 활성화라 iOS도 여기서 소리를 켜 준다
  closeSettings();
  hideHint();
  select(null);
  const token = ++app.countToken;
  const secs = Number.isFinite(countdown) ? countdown : settings.countdown;
  setState('countdown');
  for (let s = secs; s > 0; s--) {
    el.count.textContent = String(s);
    restartAnimation(el.count, '톡');
    sound.beep(s === 1);
    await sleep(1000);
    if (token !== app.countToken || app.state !== 'countdown') return null; // Esc로 취소
  }
  el.count.textContent = '';
  restartAnimation(el.flash, '터짐');
  sound.shutter();
  let shot;
  try {
    shot = capture();
  } catch (e) {
    console.warn('촬영 실패', e);
    toast('사진을 만들지 못했어요. 다시 찍어 주세요.');
    setState('live');
    return null;
  }
  await showResult(shot);
  return { width: shot.base.width, height: shot.base.height };
}

// 지금 영상 프레임을 원본 해상도로 잘라(보이는 그대로) 같은 합성기로 다시 그린다
function capture() {
  const v = app.view;
  const size = captureSize(v.crop.w, v.crop.h);
  const raw = app.canvases.raw;
  raw.width = size.w;
  raw.height = size.h;
  raw.getContext('2d').drawImage(el.video, v.crop.x, v.crop.y, v.crop.w, v.crop.h, 0, 0, size.w, size.h);
  const sv = stillView(size.w, size.h, v.mirror);

  // 그 프레임으로 사람 마스크를 한 번 더 만든다. 안 되면 마지막 미리보기 마스크(같은 자르기 공간)
  let mask = null;
  if (person.status.loaded) {
    mask = person.segmentStill(raw) ?? (person.live ? { canvas: person.live.canvas, box: person.live.box } : null);
  }
  const base = app.canvases.base;
  base.width = size.w;
  base.height = size.h;
  const report = stillComp.render(base.getContext('2d'), {
    source: raw,
    view: sv,
    cast: castItems(),
    mask: mask && settings.occlusion ? mask : null,
    look: look(),
    now: performance.now(),
    debugTint: false,
  });

  // 인화지 자르기의 중심: 캐릭터들 + 사람
  const boxes = report.map((r) => r.box);
  if (mask?.box) boxes.push(maskBoxToView(sv, mask.box));
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const subject = boxes.length
    ? {
        x0: clamp01(Math.min(...boxes.map((b) => b.x0))),
        y0: clamp01(Math.min(...boxes.map((b) => b.y0))),
        x1: clamp01(Math.max(...boxes.map((b) => b.x1))),
        y1: clamp01(Math.max(...boxes.map((b) => b.y1))),
      }
    : null;
  return { base, subject, date: new Date() };
}

// 사진 글꼴을 받아 둔다(구글 폰트가 안 오면 2.5초 뒤 시스템 글꼴로 그린다)
function fontsReady(text) {
  const fonts = [`500 40px ${FONT.mono}`, `400 40px ${FONT.mono}`, `400 40px ${FONT.sans}`, `500 40px ${FONT.sans}`];
  return Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f, text))).catch(() => null), sleep(2500)]);
}

async function showResult(shot) {
  if (app.result?.url) URL.revokeObjectURL(app.result.url);
  const r = { ...shot, frame: settings.frame };
  app.result = r;
  // 새 사진이 다 만들어질 때까지 앞 손님 사진이 보이지 않게
  el.resultImg.hidden = true;
  el.resultImg.removeAttribute('src');
  el.resultHint.textContent = '사진 만드는 중…';
  setState('result');
  el.result.hidden = false;
  // 저장 단추에 포커스를 주면 부스 Space/Enter(발판·리모컨)가 다시 찍기 대신 저장을 눌렀다. 결과 영역에 준다
  el.result.focus({ preventScroll: true });
  await renderResult();
  if (app.state !== 'result' || app.result !== r) return; // 그리는 사이에 돌아갔거나 다음 사진을 찍었다
  startIdle();
}

async function renderResult() {
  const r = app.result;
  if (!r) return;
  const token = ++app.renderToken;
  const layout = layoutFrame(r.frame, r.base.width, r.base.height, r.subject);
  await fontsReady(`${settings.title}${settings.subline}기록 없음 REC 0123456789.:`);
  if (token !== app.renderToken) return;
  const out = app.canvases.out;
  out.width = layout.outW;
  out.height = layout.outH;
  drawFrame(out.getContext('2d'), layout, r.base, {
    title: settings.title,
    subline: settings.subline,
    date: r.date,
    noise: noise.canvas,
  });
  const blob = await canvasToJpeg(out, 0.92);
  if (token !== app.renderToken) return;
  const old = r.url;
  r.blob = blob;
  r.file = makePhotoFile(blob, r.date);
  r.url = URL.createObjectURL(blob);
  r.landscape = layout.landscape;
  app.lastBlob = blob;
  el.resultImg.src = r.url;
  if (app.result === r && app.state === 'result') setPrintPhoto(r.url, r.landscape);
  if (old) URL.revokeObjectURL(old);
  await el.resultImg.decode().catch(() => {});
  if (token !== app.renderToken) return;
  el.resultImg.hidden = false;
  for (const b of el.frames.children) b.setAttribute('aria-checked', String(b.dataset.frame === r.frame));
}

function setResultFrame(id) {
  if (!app.result || !FRAMES.some((f) => f.id === id)) return Promise.resolve(false);
  app.result.frame = id;
  bumpIdle();
  return renderResult().then(() => true);
}

function backToLive() {
  if (app.state !== 'result') return;
  closeResult();
  setState('live');
  app.watch.at = performance.now();
  if (MODE === 'booth') {
    applyCast(settings.cast, false); // 다음 손님은 직원 기본값으로
    // 포커스를 단추에 두지 않는다: 그래야 다음 Space/Enter가 촬영, Tab이 캐릭터 고르기로 간다
    if (el.result.contains(document.activeElement)) document.activeElement.blur();
  } else el.shutter.focus({ preventScroll: true });
}

// 부스: 결과 화면에서 아무도 안 만지면 처음 화면으로
function startIdle() {
  clearInterval(app.idle.timer);
  if (MODE !== 'booth') {
    el.resultHint.textContent = '사진을 길게 눌러도 저장할 수 있어요';
    return;
  }
  app.idle.left = settings.idleSeconds;
  const tick = () => {
    el.resultHint.textContent = `${app.idle.left}초 뒤 처음 화면으로`;
    if (app.idle.left-- <= 0) backToLive();
  };
  tick();
  app.idle.timer = setInterval(tick, 1000);
}

function bumpIdle() {
  if (MODE === 'booth' && app.state === 'result') app.idle.left = settings.idleSeconds;
}

function buildFrameChips() {
  el.frames.replaceChildren(
    ...FRAMES.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = '알약';
      b.setAttribute('role', 'radio');
      b.dataset.frame = f.id;
      b.textContent = f.label;
      return b;
    }),
  );
  el.defaultFrame.replaceChildren(...FRAMES.map((f) => new Option(f.label, f.id)));
  syncFrameChip();
}

function syncFrameChip() {
  el.frameChip.textContent = FRAMES.find((f) => f.id === settings.frame).label;
  el.frameChip.setAttribute('aria-label', `사진 틀: ${el.frameChip.textContent}. 눌러서 바꾸기`);
}

// ── 설정창 ─────────────────────────────────────────
function openSettings() {
  for (const input of el.form.querySelectorAll('[data-key]')) {
    const v = settings[input.dataset.key];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = String(v ?? '');
  }
  el.settings.hidden = false;
  el.body.dataset.settings = 'open';
  el.gear.setAttribute('aria-expanded', 'true');
  el.settingsClose.focus({ preventScroll: true });
}

function closeSettings() {
  if (el.settings.hidden) return;
  el.settings.hidden = true;
  delete el.body.dataset.settings;
  el.gear.setAttribute('aria-expanded', 'false');
}

function onSettingInput(e) {
  const t = e.target;
  const key = t.dataset.key;
  if (!key) return;
  let v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.type === 'number') v = Number(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return;
  if (key === 'idleSeconds' && (v < 10 || v > 600)) return;
  // 카메라·해상도는 고르기를 마쳤을 때(change)만 다시 연다
  if ((key === 'cameraId' || key === 'resolution') && e.type !== 'change') return;
  if (settings[key] === v) return;
  settings[key] = v;
  saveSoon();
  if (key === 'cameraId' || key === 'resolution') startCamera();
  else if (key === 'sound') sound.setEnabled(v);
  else if (key === 'frame') syncFrameChip();
}

// 지금 방향의 배치를 기본값으로. 잠금 상태는 그대로 둔다
function resetPlacements() {
  const o = orientation();
  const lock = isLocked();
  settings.placements[o] = {};
  if (lock) for (const a of app.arts) settings.placements[o][a.id] = { ...placementFor(a.id, o), locked: true };
  if (app.view) settings.placementCrop[o] = cropNorm(app.view);
  app.anim = null;
  saveSoon();
  syncEditUi();
  toast('배치를 처음대로 돌렸어요');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => toast('이 브라우저는 전체 화면을 열 수 없어요'));
}

// ── 화면 꺼짐 막기(부스) ────────────────────────────
async function keepAwake() {
  if (MODE !== 'booth' || app.wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => {
      app.wakeLock = null;
    });
  } catch {
    // 사파리는 첫 요청을 사용자 동작 안에서만 받는다. 다음 탭·키에서 다시 시도한다
  }
}

// ── QR(부스에서 손님 폰 모드로 보내기) ──────────────
async function showQr() {
  if (MODE !== 'booth' || !QR_TARGET) return;
  let qrcode = null;
  const urls = CDN_ONLY ? [QR_LIB.cdn] : [new URL(QR_LIB.local, import.meta.url).href, QR_LIB.cdn];
  for (const u of urls) {
    try {
      qrcode = (await import(u)).default;
      break;
    } catch {
      // 다음 경로
    }
  }
  if (!qrcode) return; // 못 불러오면 QR 없이
  let text = QR_TARGET;
  try {
    text = new URL(QR_TARGET).href; // 한글 주소는 %로 바꿔 ASCII로
  } catch {
    // 주소가 아니면 글자 그대로
  }
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  // 둘레 여백은 규격(ISO/IEC 18004)대로 4칸. 화면에는 스타일.css가 정한 크기(부스 약 220px)로 보인다
  const quiet = 4;
  const cell = Math.max(2, Math.floor(480 / (n + 2 * quiet)));
  const size = (n + 2 * quiet) * cell;
  const cv = el.qrCanvas;
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  // 어두운 칸 + 밝은 바탕(뒤집힌 QR은 못 읽는 스캐너가 있다)
  g.fillStyle = '#c9d1dc';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#06070a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  el.qr.hidden = false;
}

// ── 키보드 ─────────────────────────────────────────
function onEscape() {
  if (!el.settings.hidden) return closeSettings();
  if (app.state === 'countdown') {
    app.countToken++;
    el.count.textContent = '';
    setState('live');
    return;
  }
  if (app.state === 'result') return backToLive();
  select(null);
}

// 키보드로 옮겨 온 포커스인가(초점 테두리가 보이는가). 오래된 브라우저는 선택자를 몰라 던지므로 그때는 그렇다고 본다
function focusVisible(node) {
  try {
    return node.matches(':focus-visible');
  } catch {
    return true;
  }
}

function onKey(e) {
  if (e.key === 'Escape') {
    onEscape();
    return;
  }
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  bumpIdle();
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const inSettings = el.settings.contains(e.target);
  if (key === ' ' || key === 'Enter') {
    // 단추 위에서는 그 단추를 누른다. 다만 부스에서 손가락·마우스로 누른 뒤 포커스만 남은 단추(초점 테두리 없음)는
    // 건너뛴다: 발판·리모컨의 Space/Enter가 촬영·다시 찍기 대신 얼굴 칩·좌우 반전·저장을 누르던 문제
    if (tag === 'BUTTON' && (MODE !== 'booth' || inSettings || focusVisible(e.target))) return;
    e.preventDefault();
    if (tag === 'BUTTON') e.target.blur();
    if (app.state === 'live') shoot();
    else if (app.state === 'result') backToLive();
    return;
  }
  if (MODE !== 'booth' || e.ctrlKey || e.metaKey || e.altKey) return;
  // 글자 단축키는 자판 위치(e.code)로도 받는다: 한글 입력 상태에서는 e.key가 'ㄴ' 같은 글자로 온다
  const letter = /^Key[A-Z]$/.test(e.code ?? '') ? e.code.slice(3).toLowerCase() : key;
  const active = document.activeElement;
  if (letter === 'f') toggleFullscreen();
  else if (letter === 's') (el.settings.hidden ? openSettings : closeSettings)();
  else if (letter === 'l') toggleLock();
  else if (!canEdit()) return;
  else if (key === 'Tab' && !inSettings && (!active || active === document.body || !focusVisible(active))) {
    e.preventDefault();
    cycleSelected(e.shiftKey);
  } else if (app.selected && key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 0.02 : 0.004;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
    setPlacement(app.selected, moveBy(placementFor(app.selected), d[0], d[1]));
  } else if (app.selected && (key === '+' || key === '=' || key === '-')) {
    setPlacement(app.selected, scaleBy(placementFor(app.selected), key === '-' ? 1 / 1.02 : 1.02));
  }
}

// ── 연결 ───────────────────────────────────────────
function wire() {
  el.body.dataset.mode = MODE;
  el.body.dataset.selected = 'none';
  el.debug.hidden = !DEBUG;

  // 첫 사용자 동작에서 소리·화면 꺼짐 막기를 켠다(브라우저가 동작 안에서만 허락한다)
  // 터치의 pointerdown은 사용자 활성화가 아니다(HTML 규격·WebKit). iOS는 pointerup·touchend·click에서만 허락하므로 모두 건다
  const unlock = () => {
    sound.unlock();
    keepAwake();
  };
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown']) addEventListener(ev, unlock, { capture: true });
  addEventListener('keydown', onKey);
  addEventListener('pointerdown', bumpIdle, { capture: true });
  // 부스: 손가락·마우스로 누른 단추에 포커스를 남기지 않는다(다음 Space/Enter·Tab이 그 단추로 가지 않게)
  addEventListener('click', (e) => {
    if (MODE !== 'booth' || e.detail === 0) return; // detail 0 = 키보드로 누름
    const b = e.target.closest?.('button');
    if (b && !el.settings.contains(b)) b.blur();
  });

  el.canvas.addEventListener('pointerdown', onPointerDown);
  el.canvas.addEventListener('pointermove', onPointerMove);
  el.canvas.addEventListener('pointerup', onPointerUp);
  el.canvas.addEventListener('pointercancel', onPointerUp);
  el.canvas.addEventListener('wheel', onWheel, { passive: false });

  el.shutter.addEventListener('click', () => shoot());
  el.switchCam.addEventListener('click', () => {
    app.facing = app.facing === 'environment' ? 'user' : 'environment';
    settings.cameraId = '';
    saveSoon();
    startCamera();
  });
  el.frameChip.addEventListener('click', () => {
    const i = FRAMES.findIndex((f) => f.id === settings.frame);
    settings.frame = FRAMES[(i + 1) % FRAMES.length].id;
    syncFrameChip();
    saveSoon();
  });
  el.cast.addEventListener('click', onCastClick);
  el.autoPlace.addEventListener('click', () => autoPlaceNow());
  el.flip.addEventListener('click', () => {
    if (app.selected) setPlacement(app.selected, { ...placementFor(app.selected), flip: !placementFor(app.selected).flip });
  });
  el.front.addEventListener('click', () => {
    if (!app.selected) return;
    const p = placementFor(app.selected);
    setPlacement(app.selected, { ...p, front: p.front === 'person' ? 'character' : 'person' });
    select(app.selected);
  });
  el.lock.addEventListener('click', toggleLock);
  el.lockSetting.addEventListener('click', toggleLock); // 키보드 없는 태블릿 부스에서 잠금을 푸는 길

  el.frames.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-frame]');
    if (b) setResultFrame(b.dataset.frame);
  });
  el.save.addEventListener('click', () => {
    const r = app.result;
    if (!r?.file) return;
    // 공유는 클릭 처리기 맨 앞에서, await 없이(사파리 사용자 동작 규칙)
    if (MODE === 'phone' && canShareFile(r.file)) {
      el.save.disabled = true;
      sharePhoto(r.file)
        .then((res) => {
          if (res === 'failed') downloadPhoto(r.file);
        })
        .finally(() => {
          el.save.disabled = false;
        });
      return;
    }
    downloadPhoto(r.file);
    toast('사진을 저장했어요');
  });
  el.print.addEventListener('click', async () => {
    const r = app.result;
    if (!r?.url) return;
    clearInterval(app.idle.timer);
    el.print.disabled = true;
    try {
      setPrintPhoto(r.url, r.landscape);
      if (!(await printPhoto())) toast('인쇄 화면을 열지 못했어요. 다시 눌러 주세요.');
    } finally {
      el.print.disabled = false;
      if (app.state === 'result' && app.result === r) startIdle();
    }
  });
  el.again.addEventListener('click', backToLive);
  el.retry.addEventListener('click', startCamera);

  el.gear.addEventListener('click', () => (el.settings.hidden ? openSettings() : closeSettings()));
  el.settingsClose.addEventListener('click', closeSettings);
  el.form.addEventListener('input', onSettingInput);
  el.form.addEventListener('change', onSettingInput);
  el.form.addEventListener('submit', (e) => e.preventDefault());
  el.resetPlacement.addEventListener('click', resetPlacements);
  el.fullscreen.addEventListener('click', toggleFullscreen);

  // 부스: 워드마크를 2초 누르면 설정(키보드 없는 태블릿용)
  let press = 0;
  el.wordmark.addEventListener('pointerdown', () => {
    if (MODE !== 'booth') return;
    clearTimeout(press);
    press = setTimeout(openSettings, 2000);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.wordmark.addEventListener(ev, () => clearTimeout(press));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      flushSave();
      return;
    }
    keepAwake();
    if (!app.camera) return;
    if (app.camera.track.readyState === 'ended') return onTrackEnded();
    // iOS: 돌아오면 영상이 멈춰 있거나 검게 남는 일이 있다. 재생을 다시 걸고, 그래도 멈춰 있으면 감시가 다시 연다
    el.video.play().catch(() => {});
    app.watch.at = performance.now();
    if (app.camera.track.muted) checkCameraSoon(1500);
  });
  addEventListener('pagehide', flushSave);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (app.state === 'error' && (app.errorKind === 'nocam' || app.errorKind === 'ended')) startCamera();
  });
}

async function main() {
  wire();
  buildFrameChips();
  requestAnimationFrame(loop);
  keepAwake();
  showQr();
  const chars = loadCharacters().catch((e) => {
    console.warn('캐릭터 불러오기 실패', e);
    return 'fail';
  });
  await startCamera();
  if ((await chars) === 'fail') {
    stopCamera();
    showError('art');
  }
}

main();
