// 설정 기본값과 저장. 부스와 폰은 따로 저장한다(같은 노트북에서 둘 다 열어 볼 수 있게).
// 사생활 창·저장소 차단·미리보기에서는 localStorage가 예외를 던지거나 비어 있을 수 있다.
// 그래도 앱은 기본값으로 돌아야 하므로 읽기·쓰기를 모두 try/catch로 감싼다.
import { sanitizePlacement } from './배치.js';
import { isFrame } from './틀.js';

const KEY = (mode) => `otr-booth-photo.${mode}.v1`;

export function defaultSettings(mode) {
  const booth = mode === 'booth';
  return {
    mirror: 'auto', // auto: 앞(셀카)·웹캠은 거울, 뒤 카메라는 그대로
    countdown: 3,
    harmonize: 0.6,
    shadow: 1,
    grain: 1,
    occlusion: true,
    autoHeight: 1, // 옆에 세우기 때 캐릭터 키 / 사람 키
    frame: booth ? 'print' : 'plain',
    title: 'OFF THE RECORD',
    subline: '삼유스튜디오',
    idleSeconds: 60,
    sound: true,
    cameraId: '',
    resolution: '1080',
    cast: null, // null = 모두. 아니면 보일 캐릭터 id 배열
    placements: { landscape: {}, portrait: {} },
    // 저장된 배치가 맞춰진 보이는 자르기(영상 비율). 화면 비율이 바뀌면 이 기준으로 배치를 장면에 붙여 옮긴다
    placementCrop: { landscape: null, portrait: null },
  };
}

// 자르기 사각 {x,y,w,h}(0..1)만 믿는다
function cropOrNull(c) {
  if (!c || typeof c !== 'object') return null;
  const ok = ['x', 'y', 'w', 'h'].every((k) => typeof c[k] === 'number' && Number.isFinite(c[k]) && c[k] >= 0 && c[k] <= 1);
  return ok && c.w > 0 && c.h > 0 ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
}

const num = (v, lo, hi, f) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
const str = (v, f, max = 60) => (typeof v === 'string' ? v.slice(0, max) : f);
const oneOf = (v, list, f) => (list.includes(v) ? v : f);

// 저장소에서 읽은 값을 믿지 않는다: 모르는 키는 버리고, 범위를 벗어난 값은 기본값으로
export function sanitizeSettings(raw, mode) {
  const d = defaultSettings(mode);
  const r = raw && typeof raw === 'object' ? raw : {};
  const placements = { landscape: {}, portrait: {} };
  for (const o of ['landscape', 'portrait']) {
    const src = r.placements?.[o];
    if (!src || typeof src !== 'object') continue;
    for (const [id, p] of Object.entries(src)) {
      // 기본값 대신 저장된 값의 빈칸만 채운다. 실제 기본 자리는 앱이 캐릭터 순서를 알고 넣는다
      if (p && typeof p === 'object' && typeof p.cx === 'number') {
        placements[o][id] = sanitizePlacement(p, { cx: p.cx, feetY: 0.95, heightFrac: 0.7, flip: false, locked: false });
      }
    }
  }
  return {
    mirror: oneOf(r.mirror, ['auto', 'on', 'off'], d.mirror),
    countdown: oneOf(r.countdown, [3, 5, 10], d.countdown),
    harmonize: num(r.harmonize, 0, 1, d.harmonize),
    shadow: num(r.shadow, 0, 1.5, d.shadow),
    grain: num(r.grain, 0, 2, d.grain),
    occlusion: typeof r.occlusion === 'boolean' ? r.occlusion : d.occlusion,
    autoHeight: num(r.autoHeight, 0.7, 1.3, d.autoHeight),
    frame: isFrame(r.frame) ? r.frame : d.frame,
    title: str(r.title, d.title),
    subline: str(r.subline, d.subline),
    idleSeconds: num(r.idleSeconds, 10, 600, d.idleSeconds),
    sound: typeof r.sound === 'boolean' ? r.sound : d.sound,
    cameraId: str(r.cameraId, d.cameraId, 200),
    resolution: oneOf(r.resolution, ['1080', '4k'], d.resolution),
    cast: Array.isArray(r.cast) && r.cast.every((x) => typeof x === 'string') && r.cast.length ? r.cast : d.cast,
    placements,
    placementCrop: { landscape: cropOrNull(r.placementCrop?.landscape), portrait: cropOrNull(r.placementCrop?.portrait) },
  };
}

// 예외를 삼키는 저장소. 테스트에서는 가짜 저장소를 넘긴다
export function safeStorage(backing) {
  const get = () => {
    try {
      return backing ?? globalThis.localStorage ?? null;
    } catch {
      return null; // 일부 브라우저는 localStorage에 접근만 해도 던진다
    }
  };
  return {
    read(key) {
      try {
        const v = get()?.getItem(key);
        return v == null ? null : JSON.parse(v);
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        get()?.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function loadSettings(mode, storage = safeStorage()) {
  return sanitizeSettings(storage.read(KEY(mode)), mode);
}

export function saveSettings(mode, settings, storage = safeStorage()) {
  return storage.write(KEY(mode), settings);
}
