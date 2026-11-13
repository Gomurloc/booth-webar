// 사람 인식: MediaPipe 사람 분할(ImageSegmenter, VIDEO 모드).
// 쓰는 곳: 사람이 캐릭터 앞에 서면 캐릭터를 가리기(가림), 옆에 세우기용 사람 상자.
// 어떤 이유로든 실패하면 앱은 가림·옆에 세우기 없이 그대로 돈다. 미리보기는 모델 로딩을 기다리지 않는다.
//
// 모델 고르기(조사 결과)
// - 부스: selfie_multiclass_256x256(여러 사람·전신을 공식 지원). GPU에서 프레임당 약 8ms.
//   CPU에서는 약 200ms라 실시간이 안 되므로, 몸풀기 측정이 예산을 넘으면 selfie_segmenter 가로판으로 내려간다.
// - 폰: selfie_segmenter 정사각판(250KB). 손님 데이터 요금을 생각해 16MB 모델은 받지 않는다.
// - 사람 마스크: multiclass는 1 - 배경(0번) 마스크, selfie는 0번 마스크가 곧 사람.
//   (iOS GPU에서 multiclass 범주 순서가 뒤바뀌는 버그가 있는데 배경 마스크는 맞게 나온다고 보고됐다)
// 주의점(조사에서 직접 확인)
// - VIDEO 모드 시각값이 1ms 이상 늘지 않으면 그 인스턴스는 영영 고장 난다. 예외가 나면 닫고 새로 만든다.
// - 콜백 안에서만 마스크가 유효하다. 콜백 안에서 복사하고 결과를 닫는다(GPU 자원 누수 방지).
// - wasm 경로가 틀리면 Error가 아니라 DOM Event로 거절된다.
import { maskBox, medianBox } from './배치.js';

export const MEDIAPIPE = {
  version: '1.2.2', // 1.2.2부터 SIMD 없는 wasm이 빠졌다: Safari 16.4+, Chrome 91+ 필요
  cdn: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2',
  models: {
    multiclass: {
      file: 'selfie_multiclass_256x256.tflite',
      url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
      invert: true,
    },
    selfie: {
      file: 'selfie_segmenter.tflite',
      url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      invert: false,
    },
    landscape: {
      file: 'selfie_segmenter_landscape.tflite',
      url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
      invert: false,
    },
  },
};

const INPUT_LONG = 384; // 분할 입력 긴 변. 모델 안에서 256으로 줄이므로 더 키워도 경계가 좋아지지 않는다
const SMOOTH = 0.6; // 시간 평활(새 값 비율). 낮추면 덜 떨리지만 움직임을 늦게 따라온다
const MAX_FAILURES = 3;
const FAILURE_RESET_RUNS = 300; // 이만큼(약 20초) 연달아 잘 돌면 실패 횟수를 지운다(행사 하루 동안 드문 예외가 쌓여 꺼지지 않게)
const BOX_HISTORY = 12; // 옆에 세우기 상자는 최근 이만큼(약 0.8초)의 중앙값
const BOX_THRESHOLD = 0.4; // 얼룩을 지운 뒤라 0.5보다 조금 낮춰 발끝·머리끝까지 잡는다

// 순서대로 시도한다. budget(ms)은 분할+마스크 읽기 중앙값 한도. 마지막 후보는 느려도 받아들인다
function candidates(mode, override) {
  if (override && MEDIAPIPE.models[override]) {
    return [
      { model: override, delegate: 'GPU', budget: Infinity },
      { model: override, delegate: 'CPU', budget: Infinity },
    ];
  }
  return mode === 'booth'
    ? [
        { model: 'multiclass', delegate: 'GPU', budget: 40 },
        { model: 'landscape', delegate: 'GPU', budget: 40 },
        { model: 'landscape', delegate: 'CPU', budget: Infinity },
      ]
    : [
        { model: 'selfie', delegate: 'GPU', budget: 45 },
        { model: 'selfie', delegate: 'CPU', budget: Infinity },
      ];
}

// MediaPipe(1.1.0부터)는 작업마다 사용 통계를 odml.pa.googleapis.com으로 보내고 끄는 옵션이 없다.
// 사진은 기기 밖으로 나가지 않는다는 약속에 맞춰 그 주소로 가는 fetch만 빈 성공 응답으로 막는다.
// (CSP로 막으면 콘솔에 오류가 쌓인다.) 사진·영상은 원래 보내지 않는다.
function blockTelemetry() {
  const orig = globalThis.fetch;
  if (!orig || orig.otrWrapped) return;
  const wrapped = function fetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    if (url.startsWith('https://odml.pa.googleapis.com/')) return Promise.resolve(new Response('', { status: 200 }));
    return orig.call(globalThis, input, init);
  };
  wrapped.otrWrapped = true;
  globalThis.fetch = wrapped;
}

const asError = (e) => (e instanceof Error ? e : new Error(e?.type ? `불러오기 실패(${e.type})` : String(e)));

function smoothstep(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 얼룩 지우기: multiclass 모델은 빈 벽에도 얼룩을 낸다(가짜 카메라 장면에서 직접 잼: 옅은 얼룩 0.3~0.5,
// 가끔 진한 얼룩). 그대로 쓰면 그 자리에 선 캐릭터가 반쯤 비치고(금 레코드·장갑이 지워짐) 옆에 세우기 상자도 넓어진다.
// 사람 쪽 픽셀(core 이상)이 이루는 덩어리 중 사람으로 볼 것만 남기고, 그 덩어리가 걸친 칸과 이웃 칸만 남긴다.
// 사람 가장자리의 부드러운 값은 이웃 칸 안이라 살아남는다. 사람으로 보는 덩어리
// - 큰 덩어리: 가장 큰 덩어리의 minFrac(15%) 이상. 여러 사람은 각자 큰 덩어리라 함께 남는다
// - 끊어진 발: 다리가 가늘게 끊기면 발이 따로 떨어진 작은 덩어리가 된다(측정: 가장 큰 덩어리의 약 4%).
//   큰 덩어리 상자의 가로 범위(±폭의 10%) 안이면서 그 세로 가운데보다 아래에서 시작하는 덩어리는 남긴다.
//   발을 버리면 옆에 세우기 발 높이가 틀어진다
export function gateMask(data, w, h, core = 0.5, cell = 8, minFrac = 0.15, minArea = 24) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = []; // { area, x0, y0, x1, y1 }
  const stack = new Int32Array(w * h);
  let largest = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < core || label[i] >= 0) continue;
    const id = comps.length;
    let top = 0;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    stack[top++] = i;
    label[i] = id;
    const visit = (k) => {
      if (label[k] < 0 && data[k] >= core) {
        label[k] = id;
        stack[top++] = k;
      }
    };
    while (top) {
      const j = stack[--top];
      area++;
      const x = j % w;
      const y = (j - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) visit(j - 1);
      if (x < w - 1) visit(j + 1);
      if (j >= w) visit(j - w);
      if (j + w < data.length) visit(j + w);
    }
    comps.push({ area, x0, y0, x1, y1 });
    largest = Math.max(largest, area);
  }
  const people = comps.filter((c) => c.area >= largest * minFrac && c.area >= minArea);
  const margin = w * 0.1;
  const big = comps.map(
    (c) =>
      c.area >= minArea &&
      (people.includes(c) ||
        people.some((p) => c.x0 >= p.x0 - margin && c.x1 <= p.x1 + margin && c.y0 >= (p.y0 + p.y1) / 2)),
  );
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const hot = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = ((y / cell) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const l = label[y * w + x];
      if (l >= 0 && big[l]) hot[row + ((x / cell) | 0)] = 1;
    }
  }
  const keep = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!hot[gy * gw + gx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < gw && y < gh) keep[y * gw + x] = 1;
        }
      }
    }
  }
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    const row = ((y / cell) | 0) * gw;
    for (let x = 0; x < w; x++) if (keep[row + ((x / cell) | 0)]) out[y * w + x] = data[y * w + x];
  }
  return out;
}

// 시간 평활: prev를 제자리에서 next 쪽으로 옮긴다. 크기가 다르면 next를 그대로 복사한 새 배열
export function smoothMask(prev, next, k = SMOOTH) {
  if (!prev || prev.length !== next.length) return Float32Array.from(next);
  for (let i = 0; i < next.length; i++) prev[i] += (next[i] - prev[i]) * k;
  return prev;
}

export class PersonDetector {
  constructor({ mode, cdnOnly = false, model = null, onChange = () => {} }) {
    this.mode = mode;
    this.cdnOnly = cdnOnly;
    this.override = model;
    this.onChange = onChange;
    this.task = null;
    this.choice = null;
    this.vision = null;
    this.fileset = null;
    this.failures = 0;
    this.okRuns = 0;
    this.busy = false;
    this.lastTs = 0;
    this.status = { loaded: false, failed: false, model: null, delegate: null, source: null, lastMs: 0, coverage: 0, box: null, error: null };
    this.input = null;
    this.smooth = null;
    this.live = null; // { canvas, box, coverage }
    this.boxes = [];
    this.liveCanvas = null;
    this.stillCanvas = null;
  }

  nextTs() {
    this.lastTs = Math.max(this.lastTs + 1, Math.round(performance.now()));
    return this.lastTs;
  }

  // 백그라운드로 부른다. 실패해도 던지지 않는다
  async load() {
    try {
      blockTelemetry();
      this.input = document.createElement('canvas');
      await this.importBundle();
      const list = candidates(this.mode, this.override);
      for (const [i, c] of list.entries()) {
        const last = i === list.length - 1;
        let task = null;
        try {
          task = await this.create(c);
          const ms = this.measure(task, c);
          if (ms <= c.budget || last) {
            this.task = task;
            this.choice = c;
            Object.assign(this.status, { loaded: true, model: MEDIAPIPE.models[c.model].file, delegate: c.delegate, lastMs: ms });
            this.onChange(this.status);
            return true;
          }
          task.close();
        } catch (e) {
          // 몸풀기 측정에서 던져도 만든 인스턴스(GPU 컨텍스트 포함)는 닫는다
          try {
            task?.close();
          } catch {
            // 이미 고장 난 인스턴스는 닫다가도 던질 수 있다
          }
          this.status.error = asError(e).message;
        }
      }
      throw new Error(this.status.error ?? '모델을 만들지 못함');
    } catch (e) {
      this.task = null;
      Object.assign(this.status, { loaded: false, failed: true, error: asError(e).message });
      this.onChange(this.status);
      return false;
    }
  }

  async importBundle() {
    const local = new URL('./라이브러리/mediapipe/', import.meta.url).href;
    if (!this.cdnOnly) {
      try {
        this.vision = await import(local + 'vision_bundle.mjs');
        this.fileset = await this.vision.FilesetResolver.forVisionTasks(local + 'wasm');
        this.status.source = 'local';
        return;
      } catch {
        // 받기(npm run 받기)를 안 했으면 CDN으로
      }
    }
    this.vision = await import(MEDIAPIPE.cdn + '/vision_bundle.mjs');
    this.fileset = await this.vision.FilesetResolver.forVisionTasks(MEDIAPIPE.cdn + '/wasm'); // 끝에 / 없이
    this.status.source = 'cdn';
  }

  async create(c) {
    const m = MEDIAPIPE.models[c.model];
    const paths = this.status.source === 'local' ? [new URL('./라이브러리/모델/' + m.file, import.meta.url).href, m.url] : [m.url];
    let lastErr;
    for (const path of paths) {
      try {
        return await this.vision.ImageSegmenter.createFromOptions(this.fileset, {
          baseOptions: { modelAssetPath: path, delegate: c.delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      } catch (e) {
        lastErr = asError(e);
      }
    }
    throw lastErr;
  }

  // 몸풀기 한 번(GPU는 첫 프레임에 셰이더를 컴파일한다) 뒤 세 번 재서 중앙값(ms)
  measure(task, c) {
    const cv = this.input;
    cv.width = c.model === 'selfie' ? 288 : INPUT_LONG;
    cv.height = c.model === 'selfie' ? 384 : 216;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, cv.width, cv.height);
    grad.addColorStop(0, '#888');
    grad.addColorStop(1, '#333');
    g.fillStyle = grad;
    g.fillRect(0, 0, cv.width, cv.height);
    const once = () => {
      const t0 = performance.now();
      task.segmentForVideo(cv, this.nextTs(), (r) => {
        try {
          r.confidenceMasks?.[0]?.getAsFloat32Array();
        } finally {
          r.close();
        }
      });
      return performance.now() - t0;
    };
    once();
    const times = [once(), once(), once()].sort((a, b) => a - b);
    return times[1];
  }

  get ready() {
    return !!this.task && !this.busy;
  }

  // source의 crop(원본 픽셀, 반전 전)을 분할한다. 결과 마스크(0..1)와 크기. 실패하면 null
  run(source, crop) {
    const cv = this.input;
    const s = INPUT_LONG / Math.max(crop.w, crop.h);
    const w = Math.max(16, Math.round(crop.w * s));
    const h = Math.max(16, Math.round(crop.h * s));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext('2d');
    g.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    const invert = MEDIAPIPE.models[this.choice.model].invert;
    let out = null;
    const t0 = performance.now();
    try {
      this.task.segmentForVideo(cv, this.nextTs(), (r) => {
        try {
          const m = r.confidenceMasks?.[0];
          if (!m) return;
          const f = m.getAsFloat32Array();
          out = { data: new Float32Array(f.length), w: m.width, h: m.height };
          if (invert) for (let i = 0; i < f.length; i++) out.data[i] = 1 - f[i];
          else out.data.set(f);
        } finally {
          r.close();
        }
      });
    } catch (e) {
      this.recover(e);
      return null;
    }
    this.status.lastMs = performance.now() - t0;
    if (this.failures && ++this.okRuns >= FAILURE_RESET_RUNS) {
      this.failures = 0;
      this.okRuns = 0;
    }
    return out;
  }

  // 예외가 나면 VIDEO 인스턴스는 다시 못 쓴다: 닫고 같은 설정으로 새로 만든다. 여러 번 실패하면 포기
  recover(e) {
    this.failures++;
    this.okRuns = 0;
    this.status.error = asError(e).message;
    const old = this.task;
    this.task = null;
    try {
      old?.close();
    } catch {
      // 이미 고장 난 인스턴스는 닫다가도 던질 수 있다
    }
    if (this.failures > MAX_FAILURES) {
      Object.assign(this.status, { loaded: false, failed: true });
      this.onChange(this.status);
      return;
    }
    this.busy = true;
    this.create(this.choice)
      .then((t) => {
        this.task = t;
      })
      .catch(() => {
        Object.assign(this.status, { loaded: false, failed: true });
        this.onChange(this.status);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  // 미리보기용: 시간 평활한 마스크를 갱신한다
  updateLive(source, crop) {
    if (!this.ready) return null;
    const m = this.run(source, crop);
    if (!m) return null;
    this.smooth = smoothMask(this.smooth, m.data);
    const clean = gateMask(this.smooth, m.w, m.h); // 평활 상태는 그대로 두고 지운 사본을 쓴다
    this.liveCanvas = paintMask(this.liveCanvas, clean, m.w, m.h);
    const { box, coverage } = maskBox(clean, m.w, m.h, BOX_THRESHOLD);
    this.boxes.push(box);
    if (this.boxes.length > BOX_HISTORY) this.boxes.shift();
    this.status.coverage = coverage;
    this.status.box = box; // 마스크 공간(보이는 자르기, 반전 전) 사람 상자
    this.live = { canvas: this.liveCanvas, box, coverage };
    return this.live;
  }

  // 옆에 세우기용: 최근 상자들의 중앙값(마스크 공간). 사람이 안 보이면 null
  stableBox() {
    return medianBox(this.boxes);
  }

  // 촬영용: 그 프레임 그대로 한 번(평활 없이). 못 하면 null(부르는 쪽이 마지막 미리보기 마스크를 쓴다)
  segmentStill(canvas) {
    if (!this.ready) return null;
    const m = this.run(canvas, { x: 0, y: 0, w: canvas.width, h: canvas.height });
    if (!m) return null;
    const clean = gateMask(m.data, m.w, m.h);
    this.stillCanvas = paintMask(this.stillCanvas, clean, m.w, m.h);
    const { box, coverage } = maskBox(clean, m.w, m.h, BOX_THRESHOLD);
    return { canvas: this.stillCanvas, box, coverage };
  }

  reset() {
    this.smooth = null;
    this.live = null;
    this.boxes = [];
  }
}

// 마스크 값을 흰색+알파 캔버스로. 가장자리는 smoothstep으로 살짝 조이고(0.5보다 조금 위가 반투명),
// 그릴 때 확대 보간이 부드럽게 퍼뜨린다
function paintMask(canvas, data, w, h) {
  const cv = canvas ?? document.createElement('canvas');
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const g = cv.getContext('2d');
  const img = g.createImageData(w, h);
  const px = img.data;
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    px[j] = 255;
    px[j + 1] = 255;
    px[j + 2] = 255;
    px[j + 3] = smoothstep(0.35, 0.75, data[i]) * 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}
