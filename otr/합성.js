// 합성기: 카메라 화면 위에 캐릭터를 사진 속에 서 있는 것처럼 얹는다.
// 미리보기와 원본 해상도 촬영이 같은 코드를 쓴다(크기만 다르다). 그래서 보이는 대로 찍힌다.
//
// 한 프레임 그리는 순서(캐릭터마다, 뒤에 선 캐릭터부터)
//  1) 카메라 화면(보이는 자르기, 설정대로 거울 반전)
//  2) 드리운 그림자: 실루엣을 발 뒤 바닥에 납작하게 눕히고(세로 0.16배, 비스듬히) 줄였다 키워 흐리게
//  3) 접지 그림자: 발밑 타원(실제 발바닥 폭에 맞춤, 어두운 장면일수록 약하게) + 발바닥 그림자(발 쪽 실루엣을
//     조금 아래로 내려 흐리게. 신발마다 실제 밑선을 따라 바로 아래에 그늘). 타원만 있으면 두 발 사이 빈 바닥만
//     어둡고 바깥쪽 신발 앞코가 떠 보였다
//  4) 캐릭터: 0.8배로 줄였다 키워 카메라만큼 무르게 → 색 맞춤 표 → 빛 번짐 → 그레인(픽셀 처리 한 번에)
//  5) 빛 번짐: 흐린 배경을 캐릭터 가장자리 띠에 스크린으로 살짝 더한다(밝은 배경 빛이 윤곽으로 번지는 현상).
//     더하기만 하므로 어두운 배경에서 흰 옷 윤곽이 회색 테로 어두워지지 않는다
//  6) 사람 가림: 사람 마스크 자리의 카메라 픽셀을 캐릭터 상자 안에서만 다시 그린다 → 앞에 선 사람이 캐릭터를 가린다
//  7) 사진 전체에 아주 옅은 그레인
// 무거운 일(색 맞춤 픽셀 처리)은 장면이 눈에 띄게 바뀌거나 크기가 바뀔 때만, 초당 몇 번만 한다.
// ctx.filter는 사파리에서 꺼져 있어 흐림은 모두 줄였다 키우기로 만든다.
//
// 포스터 AR·살아 있는 캐릭터에서 더한 것(없으면 예전과 똑같이 그린다)
// - 반복 영상 캐릭터(c.anim): 미리보기는 4)를 WebGL(움직임.js)에서 같은 식으로 칠한다(영상 프레임마다 CPU 픽셀 처리를 돌리면 폰이 못 따라온다).
//   촬영(still)은 부르는 쪽이 지금 프레임을 그림(art.img)으로 바꿔 넣어 예전 CPU 경로 그대로.
// - 효과(c.fx): alpha(불투명도), reveal(위에서부터 드러난 비율), glow(뒤에 번지는 빛), flash(위에 얹는 번쩍임),
//   shadow(그림자 세기 배율). 걸어 나오기에 쓴다
// - 기울기(c.placement.tilt, 라디안): 폰을 기울여 들면 세계의 세로도 화면에서 기운다. 발 지점을 축으로 그림자·캐릭터를 같이 돌린다
import { sourceRectFor } from './화면.js';
import { statsFromRGBA, harmonizeParams, buildLuts, applyHarmonize, statsChanged, lerpStats, shadowLight } from './색.js';
import { artBox, drawOrder } from './배치.js';

export const LOOK = {
  castScaleY: 0.16, // 드리운 그림자 세로 납작함
  castSkew: -0.5, // 기울기(납작해진 그림자 기준). 음수면 그림자 끝이 오른쪽으로: 빛이 왼쪽 앞에 있다고 본다
  castBlur: 0.012, // 흐림 반경 / 보기 높이
  castAlpha: 0.18,
  contactWidth: 1.1, // 접지 그림자 폭 / 실제 발바닥 폭(가장 왼쪽~오른쪽 발)
  contactHeight: 0.05, // 접지 그림자 높이 / 그림 높이
  contactAlpha: 0.25,
  soleBand: 0.04, // 발바닥 그림자로 쓰는 실루엣 맨 아래 줄 / 키
  soleOffset: 0.004, // 그 줄을 아래로 내리는 거리 / 보기 높이(신발 밑선 아래로 이만큼 그늘이 보인다)
  soleBlur: 0.0025, // 흐림 / 보기 높이
  soleAlpha: 0.4, // × 그림자 설정. 사람 대역 신발 밑(바닥보다 약 25% 어두움)에 맞춤. 곱하기 그림자라 장면 밝기 배율은 곱하지 않는다
  wrapAlpha: 0.15, // × 색 맞춤 세기(기본 0.6이면 0.09)
  wrapErode: 0.004, // 가장자리 띠 두께 / 그림 높이
  wrapShrink: 14, // 빛 번짐 배경을 1/14로 줄여 흐린다
  artGrain: 0.06, // × 그레인 설정
  photoGrain: 0.035,
  softness: 0.8, // 캐릭터를 이 배율로 줄였다 키운다
  statsEvery: 333, // 장면 통계 주기(ms) = 색 맞춤 최대 초당 3번
  resizeEvery: 100, // 크기를 바꾸는 중에는 이 주기로만 다시 칠한다(그 사이엔 늘려 그린다)
};

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const NO_FX = { alpha: 1, reveal: 1, glow: 0, flash: 0, shadow: 1 };
// 걸어 나오기 빛: 실루엣을 1/10로 줄였다 키워 번지게. 뒤 빛(halo)은 캐릭터 밑에, 번쩍임(flash)은 위에
const GLOW = { tint: '#ffe9c4', halo: { scale: 1.12, alpha: 0.42 }, flash: { scale: 1.03, alpha: 0.6 }, shrink: 12, pad: 0.25 };

export function makeCanvas(w = 1, h = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// 크기가 다를 때만 바꾼다(같은 값을 넣어도 캔버스가 지워지고 새로 잡혀 느리다)
function fit(c, w, h) {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

// 모자랄 때만 늘린다(AR에서는 크기가 프레임마다 바뀐다): 지금보다 25% 넘게, 64px 단위로(걸어 나오며 커지는 동안 판을
// 수십 번 다시 잡지 않게). 쓰는 쪽은 왼쪽 위 w×h만 쓴다
export function growTo(cur, need) {
  return need <= cur ? cur : Math.ceil(Math.max(need, cur * 1.25) / 64) * 64;
}
function fitAtLeast(c, w, h) {
  if (c.width < w) c.width = growTo(c.width, w);
  if (c.height < h) c.height = growTo(c.height, h);
  return c;
}

// 캐릭터 상자 중 화면(여유 3%)에 보이는 부분(상자 기준 0..1). 발 지점을 축으로 tilt만큼 돌려 그리므로 화면 사각을 거꾸로 돌려 잰다.
// 다 보이면 null(통째로 그린다), 하나도 안 보이면 { empty: true }
function visibleSub(box, tilt, W, H) {
  const m = 0.03;
  const px = box.fx * W;
  const py = box.fy * H;
  const c = Math.cos(-tilt);
  const s = Math.sin(-tilt);
  const xs = [];
  const ys = [];
  for (const [x, y] of [[-m * W, -m * H], [(1 + m) * W, -m * H], [-m * W, (1 + m) * H], [(1 + m) * W, (1 + m) * H]]) {
    const dx = x - px;
    const dy = y - py;
    xs.push((px + dx * c - dy * s - box.x0 * W) / (box.w * W));
    ys.push((py + dx * s + dy * c - box.y0 * H) / (box.h * H));
  }
  const x0 = Math.max(0, Math.min(...xs));
  const x1 = Math.min(1, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const y1 = Math.min(1, Math.max(...ys));
  if (x1 <= x0 || y1 <= y0) return { empty: true };
  if (x0 <= 0.001 && y0 <= 0.001 && x1 >= 0.999 && y1 >= 0.999) return null;
  // 1/64 단위로 넓혀 맞춘다(작은 흔들림마다 판 크기가 바뀌지 않게)
  const q = (v, up) => (up ? Math.ceil(v * 64) : Math.floor(v * 64)) / 64;
  const sx0 = q(x0, false);
  const sy0 = q(y0, false);
  return { x: sx0, y: sy0, w: Math.min(1, q(x1, true)) - sx0, h: Math.min(1, q(y1, true)) - sy0 };
}

// 사각형 r({x,y,w,h}, 대상 픽셀)을 (px,py) 둘레로 a만큼 돌렸을 때 감싸는 사각형
function rotatedBounds(r, px, py, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const xs = [];
  const ys = [];
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const dx = x - px;
    const dy = y - py;
    xs.push(px + dx * c - dy * s);
    ys.push(py + dx * s + dy * c);
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

// 잡음 타일: 평균 128, 대략 정규분포. 픽셀 처리(배열)와 패턴 칠하기(캔버스)에 같이 쓴다
export function makeNoise(size = 128) {
  const tile = new Uint8Array(size * size);
  const canvas = makeCanvas(size, size);
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < tile.length; i++) {
    const v = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
    const n = Math.max(0, Math.min(255, Math.round(128 + v * 220)));
    tile[i] = n;
    img.data[i * 4] = n;
    img.data[i * 4 + 1] = n;
    img.data[i * 4 + 2] = n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { size, tile, canvas };
}

// 보기 정규 사각 rect를 원본(source)에서 읽어 ctx의 (0,0,tw,th)에 그린다. 보기 밖 부분은 비워 둔다
export function drawRegion(ctx, source, view, rect, tw, th) {
  const r = sourceRectFor(view, rect);
  if (!r) return false;
  const kx = tw / rect.w;
  const ky = th / rect.h;
  const dx = (r.dx - rect.x) * kx;
  const dy = (r.dy - rect.y) * ky;
  const dw = r.dw * kx;
  const dh = r.dh * ky;
  ctx.save();
  if (r.flip) {
    // 대상 사각 안에서 좌우로 뒤집는다: x → (2dx + dw) - x
    ctx.translate(2 * dx + dw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, r.sx, r.sy, r.sw, r.sh, dx, dy, dw, dh);
  ctx.restore();
  return true;
}

// 알파 배열 최소값 필터(침식). 가로·세로 따로. 그림 밖은 0으로 본다
function erode(a, w, h, r) {
  const tmp = new Uint8Array(a.length);
  const out = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = -r; k <= r && m > 0; k++) {
        const xx = x + k;
        m = xx < 0 || xx >= w ? 0 : Math.min(m, a[y * w + xx]);
      }
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255;
      for (let k = -r; k <= r && m > 0; k++) {
        const yy = y + k;
        m = yy < 0 || yy >= h ? 0 : Math.min(m, tmp[yy * w + x]);
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(a.length);
  const out = new Uint8Array(a.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s / n;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}

// 그림 한 장에서 한 번만 만들어 두는 것들: 그림 통계, 그림자용 실루엣, 빛 번짐용 가장자리 띠
export function prepareArt(img, meta) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const scaled = (maxH, willRead) => {
    const h = Math.min(maxH, H);
    const w = Math.max(1, Math.round((W * h) / H));
    const c = makeCanvas(w, h);
    const g = c.getContext('2d', willRead ? { willReadFrequently: true } : undefined);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return { c, g, w, h };
  };

  const s = scaled(256, true);
  const stats = statsFromRGBA(s.g.getImageData(0, 0, s.w, s.h).data, { alphaMin: 128 });

  const sil = scaled(360, false);
  sil.g.globalCompositeOperation = 'source-in';
  sil.g.fillStyle = '#000';
  sil.g.fillRect(0, 0, sil.w, sil.h);

  // 가장자리 띠 = 알파 - 침식한 알파, 살짝 흐리게
  const e = scaled(512, true);
  const px = e.g.getImageData(0, 0, e.w, e.h);
  const alpha = new Uint8Array(e.w * e.h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = px.data[i * 4 + 3];
  const eroded = erode(alpha, e.w, e.h, Math.max(2, Math.round(e.h * LOOK.wrapErode)));
  const band = new Uint8Array(alpha.length);
  for (let i = 0; i < band.length; i++) band[i] = Math.max(0, alpha[i] - eroded[i]);
  const soft = boxBlur(band, e.w, e.h, 2);
  for (let i = 0; i < soft.length; i++) {
    px.data[i * 4] = 255;
    px.data[i * 4 + 1] = 255;
    px.data[i * 4 + 2] = 255;
    px.data[i * 4 + 3] = soft[i];
  }
  e.g.putImageData(px, 0, 0);

  // 발바닥 줄: 발 선(feet.y)에서 키의 4% 위까지. 그 줄의 실루엣(발바닥 그림자)과 실제 발바닥 폭(접지 타원 폭)
  const feetRow = Math.min(e.h, Math.round(meta.feet.y * e.h));
  const bandRows = Math.max(2, Math.round((meta.feet.y - meta.top) * e.h * LOOK.soleBand));
  const r0 = Math.max(0, feetRow - bandRows);
  const rows = Math.max(1, feetRow - r0);
  const soleCanvas = makeCanvas(e.w, rows);
  const sg = soleCanvas.getContext('2d');
  const soleImg = sg.createImageData(e.w, rows);
  let sx0 = e.w;
  let sx1 = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < e.w; x++) {
      const a = alpha[(r0 + y) * e.w + x];
      soleImg.data[(y * e.w + x) * 4 + 3] = a;
      if (a > 128) {
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
      }
    }
  }
  sg.putImageData(soleImg, 0, 0);
  const found = sx1 >= sx0;
  const sole = {
    canvas: soleCanvas,
    y0: r0 / e.h,
    y1: feetRow / e.h,
    x0: found ? sx0 / e.w : meta.feet.x - 0.25,
    x1: found ? (sx1 + 1) / e.w : meta.feet.x + 0.25,
  };

  return {
    id: meta.id,
    name: meta.name,
    img,
    width: W,
    height: H,
    aspect: W / H,
    top: meta.top,
    feet: meta.feet,
    face: meta.face,
    stats,
    silhouette: sil.c,
    edge: e.c,
    sole,
  };
}

export class Compositor {
  // still: 촬영용(통계를 매번 새로 재고, 평활·주기 제한 없이 바로 칠한다). gpu: 반복 영상 캐릭터를 칠할 AnimGL(미리보기만)
  constructor({ noise, still = false, gpu = null }) {
    this.noise = noise;
    this.still = still;
    this.gpu = gpu;
    this.rev = makeCanvas();
    this.glows = new WeakMap();
    this.chars = new Map();
    this.shadow = makeCanvas();
    this.occ = makeCanvas();
    this.tiny = makeCanvas();
    this.tint = makeCanvas();
    this.soleCv = makeCanvas();
    this.whole = null; // 보이는 화면 전체 통계(톤 맞춤용)
    this.wholeAt = -Infinity;
    this.stats = makeCanvas(64, 36);
    this.statsCtx = this.stats.getContext('2d', { willReadFrequently: true });
    this.patterns = new WeakMap();
  }

  charState(id) {
    let st = this.chars.get(id);
    if (!st) {
      st = {
        stats: null,
        statsAt: -Infinity,
        applied: null, // 지금 칠해 둔 그림에 쓴 국소 통계
        appliedWhole: null, // 지금 칠해 둔 그림에 쓴 전체 통계
        look: null,
        prep: null,
        work: makeCanvas(), // 픽셀 처리용(CPU)
        out: makeCanvas(), // 매 프레임 그릴 결과(왼쪽 위 prep.w×prep.h)
        soft: makeCanvas(),
        wrap: makeCanvas(),
        gprep: null, // 반복 영상(GPU) 경로의 맞춤 값
        wrapSrc: null,
      };
      this.chars.set(id, st);
    }
    return st;
  }

  // f: { source, view, cast:[{art, placement, fx?, anim?}], mask:{canvas}|null, look:{harmonize, shadow, grain, occlusion}, now, debugTint }
  // 반환: 캐릭터별 { id, box(보기 정규), stats, params, gpu } (디버그·시험용)
  render(ctx, f) {
    const W = f.view.viewW;
    const H = f.view.viewH;
    const aspect = W / H;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawRegion(ctx, f.source, f.view, FULL, W, H);

    const report = [];
    if (f.cast.length) this.updateWhole(f);
    for (const c of drawOrder(f.cast)) {
      const box = artBox(c.placement, c.art, aspect);
      const st = this.charState(c.art.id);
      const fx = c.fx ?? NO_FX;
      const tilt = c.placement.tilt ?? 0;
      const turned = Math.abs(tilt) > 1e-3;
      this.updateStats(st, f, box, c.art);
      if (turned) {
        // 발 지점을 축으로 그림자·캐릭터를 같이 돌린다(가림은 카메라 픽셀이라 돌리지 않는다)
        ctx.save();
        ctx.translate(box.fx * W, box.fy * H);
        ctx.rotate(tilt);
        ctx.translate(-box.fx * W, -box.fy * H);
      }
      const shadow = f.look.shadow * fx.shadow;
      const shadowBox = this.castShadow(ctx, c, box, W, H, shadow);
      this.contactShadow(ctx, c, box, W, H, shadow * shadowLight(st.stats?.lum ?? 0.5));
      this.soleShadow(ctx, c, box, W, H, shadow);
      if (fx.glow > 0) this.drawGlow(ctx, c, box, W, H, fx.glow * fx.alpha, GLOW.halo);
      this.drawCharacter(ctx, st, c, box, f, fx);
      if (fx.flash > 0) this.drawGlow(ctx, c, box, W, H, fx.flash, GLOW.flash);
      if (turned) ctx.restore();
      if (f.mask && f.look.occlusion && c.placement.front === 'person') this.occlude(ctx, f, box, shadowBox, tilt);
      report.push({ id: c.art.id, box, stats: st.stats, whole: this.whole, params: st.prep?.params ?? null, gpu: !!st.prep?.gpu });
    }
    if (f.debugTint && f.mask) this.drawTint(ctx, f);
    this.photoGrain(ctx, W, H, f.look.grain);
    ctx.restore();
    return report;
  }

  // 보이는 화면 전체를 64×36으로 줄여 잰다(톤 맞춤용, 캐릭터 모두 같이 쓴다)
  updateWhole(f) {
    if (!this.still && this.whole && f.now - this.wholeAt < LOOK.statsEvery) return;
    this.wholeAt = f.now;
    const g = this.statsCtx;
    g.clearRect(0, 0, 64, 36);
    drawRegion(g, f.source, f.view, FULL, 64, 36);
    const raw = statsFromRGBA(g.getImageData(0, 0, 64, 36).data, { alphaMin: 255 });
    if (!raw || !raw.mean.every(Number.isFinite)) return;
    this.whole = this.still ? raw : lerpStats(this.whole, raw, 0.5);
  }

  // 캐릭터 상자 둘레(상하좌우 50% 여유)의 카메라 화면을 64×36으로 줄여 잰다
  updateStats(st, f, box, art) {
    if (!this.still && st.stats && f.now - st.statsAt < LOOK.statsEvery) return;
    st.statsAt = f.now;
    const mx = box.w * 0.5;
    const my = box.h * 0.5;
    const g = this.statsCtx;
    g.clearRect(0, 0, 64, 36);
    if (!drawRegion(g, f.source, f.view, { x: box.x0 - mx, y: box.y0 - my, w: box.w + 2 * mx, h: box.h + 2 * my }, 64, 36)) return;
    const raw = statsFromRGBA(g.getImageData(0, 0, 64, 36).data, { alphaMin: 255 });
    if (!raw) return;
    st.stats = this.still ? raw : lerpStats(st.stats, raw, 0.5);
    if (!st.stats.mean.every(Number.isFinite)) st.stats = art.stats;
  }

  // 드리운 그림자. 그린 범위(대상 픽셀)를 돌려준다(가림 범위에 넣는다)
  castShadow(ctx, c, box, W, H, strength) {
    const art = c.art;
    const w = box.w * W;
    const h = box.h * H;
    const fx = box.fx * W;
    const fy = box.fy * H;
    const feetX = (c.placement.flip ? 1 - art.feet.x : art.feet.x) * w;
    const feetY = art.feet.y * h;
    const sy = LOOK.castScaleY;
    const sk = LOOK.castSkew * sy;
    // 발 기준 상대 좌표 (du, dv) → (du + sk·dv, sy·dv)
    const xs = [];
    const ys = [];
    for (const du of [-feetX, w - feetX]) {
      for (const dv of [-feetY, h - feetY]) {
        xs.push(du + sk * dv);
        ys.push(sy * dv);
      }
    }
    const blur = Math.max(1, LOOK.castBlur * H);
    const pad = blur * 2.5;
    const bx = fx + Math.min(...xs) - pad;
    const by = fy + Math.min(...ys) - pad;
    const bw = Math.max(...xs) - Math.min(...xs) + 2 * pad;
    const bh = Math.max(...ys) - Math.min(...ys) + 2 * pad;
    const bounds = { x: bx, y: by, w: bw, h: bh };
    if (strength <= 0) return bounds;

    const ds = Math.max(1, blur * 0.75); // 이만큼 줄여 그렸다가 키우면 반경 약 blur로 퍼진다
    const sw = Math.max(2, Math.ceil(bw / ds));
    const shh = Math.max(2, Math.ceil(bh / ds));
    const cv = fit(this.shadow, sw, shh);
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, sw, shh);
    g.imageSmoothingQuality = 'high';
    g.setTransform(1 / ds, 0, sk / ds, sy / ds, (fx - bx) / ds, (fy - by) / ds);
    if (c.placement.flip) g.transform(-1, 0, 0, 1, w - 2 * feetX, 0);
    g.drawImage(art.silhouette, -feetX, -feetY, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);

    ctx.save();
    ctx.globalAlpha = Math.min(1, LOOK.castAlpha * strength);
    ctx.drawImage(cv, 0, 0, sw, shh, bx, by, sw * ds, shh * ds);
    ctx.restore();
    return bounds;
  }

  // 발밑 타원: 폭은 실제 발바닥 폭(가장 왼쪽~오른쪽 발)의 1.1배, 가운데는 발바닥 가운데
  contactShadow(ctx, c, box, W, H, strength) {
    if (strength <= 0) return;
    const sole = c.art.sole;
    const mid = (sole.x0 + sole.x1) / 2;
    const cx = box.x0 + (c.placement.flip ? 1 - mid : mid) * box.w;
    const rx = Math.max(1, (LOOK.contactWidth * (sole.x1 - sole.x0) * box.w * W) / 2);
    const ry = Math.max(1, (LOOK.contactHeight * box.h * H) / 2);
    const a = Math.min(1, LOOK.contactAlpha * strength);
    ctx.save();
    ctx.translate(cx * W, box.fy * H - ry * 0.3);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(0, 0, 0, ${a})`);
    grad.addColorStop(0.45, `rgba(0, 0, 0, ${a * 0.5})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-rx, -rx, 2 * rx, 2 * rx);
    ctx.restore();
  }

  // 발바닥 그림자: 실루엣 맨 아래 줄(신발 아랫부분)을 조금 아래로 내려 흐리게 깐다. 캐릭터가 위에 그려지므로
  // 신발 밑선 바로 아래 가는 그늘만 보인다. 두 발 높이가 달라도(한 발이 조금 뒤) 각 신발 밑선을 따라간다.
  // 신발이 바닥에 닿는 자리마다 그늘이 생겨 앞코가 뜨지 않는다(사람 대역 신발 밑 그늘과 같은 수준을 목표로)
  soleShadow(ctx, c, box, W, H, strength) {
    if (strength <= 0) return;
    const sole = c.art.sole;
    const w = box.w * W;
    const bandH = Math.max(1, (sole.y1 - sole.y0) * box.h * H);
    const blur = Math.max(1, LOOK.soleBlur * H);
    const ds = Math.max(1, blur * 0.75);
    const pad = blur * 2;
    const tw = Math.max(2, Math.ceil((w + 2 * pad) / ds));
    const th = Math.max(2, Math.ceil((bandH + 2 * pad) / ds));
    const cv = fit(this.soleCv, tw, th);
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, tw, th);
    g.imageSmoothingQuality = 'high';
    if (c.placement.flip) g.setTransform(-1, 0, 0, 1, (w + 2 * pad) / ds, 0);
    g.drawImage(c.art.sole.canvas, pad / ds, pad / ds, w / ds, bandH / ds);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const x = box.x0 * W - pad;
    const y = (box.y0 + sole.y0 * box.h) * H + LOOK.soleOffset * H - pad;
    ctx.save();
    ctx.globalAlpha = Math.min(1, LOOK.soleAlpha * strength);
    ctx.drawImage(cv, 0, 0, tw, th, x, y, tw * ds, th * ds);
    ctx.restore();
  }

  drawCharacter(ctx, st, c, box, f, fx = NO_FX) {
    const W = f.view.viewW;
    const H = f.view.viewH;
    const pw = Math.max(2, Math.round(box.w * W));
    const ph = Math.max(2, Math.round(box.h * H));
    const flip = c.placement.flip;
    const lookKey = `${f.look.harmonize}|${f.look.grain}`;
    const gpuOk = !this.still && this.gpu?.ok && c.anim?.ready;
    // GPU(미리보기): 상자가 화면 밖으로 크게 나가면(카메라 가까이 선 AR 캐릭터) 보이는 부분만 칠한다. 위에서부터 드러나는 중(reveal<1)은 통째로
    let sub = null;
    if (gpuOk && fx.reveal >= 1) {
      sub = visibleSub(box, c.placement.tilt ?? 0, W, H);
      if (sub?.empty) return;
    }
    const gpuDone = gpuOk && this.prepareGpu(st, c, box, f, pw, ph, lookKey, sub);
    if (!gpuDone) {
      const prep = st.prep;
      const since = f.now - (prep?.at ?? -Infinity);
      const sizeChanged = !prep || Math.abs(prep.w - pw) > Math.max(1, pw * 0.01) || prep.flip !== flip;
      const lookChanged =
        !prep || prep.lookKey !== lookKey || statsChanged(st.applied, st.stats) || statsChanged(st.appliedWhole, this.whole);
      // 반복 영상 캐릭터였다가 PNG로 돌아온 경우(WebGL을 잃음)에도 다시 칠한다
      if (this.still || !prep || prep.gpu || (sizeChanged && since >= LOOK.resizeEvery) || (lookChanged && since >= LOOK.statsEvery)) {
        this.prepare(st, c, box, f, pw, ph, lookKey);
      }
    }
    let src = st.out;
    if (fx.reveal < 1) src = this.revealed(st, fx.reveal);
    const s = st.prep.sub;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fx.alpha));
    if (s) ctx.drawImage(src, 0, 0, st.prep.w, st.prep.h, (box.x0 + s.x * box.w) * W, (box.y0 + s.y * box.h) * H, s.w * box.w * W, s.h * box.h * H);
    else ctx.drawImage(src, 0, 0, st.prep.w, st.prep.h, box.x0 * W, box.y0 * H, box.w * W, box.h * H);
    ctx.restore();
  }

  // 반복 영상 캐릭터(미리보기): 맞춤 값·빛 번짐 배경은 CPU 경로와 같은 때(장면·크기·자리가 바뀔 때, 초당 몇 번)만 다시 재고,
  // 그림은 영상 새 프레임마다·크기가 바뀔 때마다 GPU로 칠한다. 못 하면 false(부르는 쪽이 PNG로 그린다).
  // sub(상자 기준 0..1 사각, 없으면 통째로): 그 부분만 같은 해상도로 칠한다
  prepareGpu(st, c, box, f, pw, ph, lookKey, sub = null) {
    const art = c.art;
    const flip = c.placement.flip;
    const g = st.gprep;
    const since = f.now - (g?.at ?? -Infinity);
    const lookChanged = !g || g.lookKey !== lookKey || statsChanged(st.applied, st.stats) || statsChanged(st.appliedWhole, this.whole);
    const moved =
      !g || Math.abs(g.box.x0 - box.x0) > box.w * 0.05 || Math.abs(g.box.y0 - box.y0) > box.h * 0.05 || Math.abs(g.pw - pw) > pw * 0.05;
    if (!g || (lookChanged && since >= LOOK.statsEvery) || (moved && since >= LOOK.resizeEvery)) {
      const k = f.look.harmonize;
      const scene = st.stats ?? art.stats;
      const params = harmonizeParams(scene, art.stats, k, this.whole ?? scene);
      const wrapA = Math.min(1, LOOK.wrapAlpha * k);
      let wrapCanvas = null;
      if (wrapA > 0) {
        const tw = Math.max(2, Math.round(pw / LOOK.wrapShrink));
        const th = Math.max(2, Math.round(ph / LOOK.wrapShrink));
        st.wrapSrc = fit(st.wrapSrc ?? makeCanvas(), tw, th);
        const tg = st.wrapSrc.getContext('2d');
        tg.clearRect(0, 0, tw, th);
        tg.imageSmoothingQuality = 'high';
        drawRegion(tg, f.source, f.view, { x: box.x0, y: box.y0, w: box.w, h: box.h }, tw, th);
        wrapCanvas = st.wrapSrc;
      }
      st.gprep = { at: f.now, lookKey, params, luts: buildLuts(params), wrapA, wrapCanvas, key: (g?.key ?? 0) + 1, box: { ...box }, pw };
      st.applied = st.stats;
      st.appliedWhole = this.whole;
    }
    const G = st.gprep;
    const p = st.prep;
    const rw = sub ? Math.max(2, Math.round(pw * sub.w)) : pw;
    const rh = sub ? Math.max(2, Math.round(ph * sub.h)) : ph;
    const sameSub = (a, b) => (!a && !b) || (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
    if (p?.gpu && p.frame === c.anim.frameId && p.w === rw && p.h === rh && p.key === G.key && p.flip === flip && sameSub(p.sub, sub)) return true; // 그대로
    const r = this.gpu.render(c.anim, rw, rh, {
      sub,
      luts: G.luts,
      lutKey: G.key,
      sat: G.params.sat,
      wrapAlpha: G.wrapA,
      wrapCanvas: G.wrapCanvas,
      wrapKey: G.key,
      edgeCanvas: art.edge,
      grain: f.look.grain > 0 ? LOOK.artGrain * f.look.grain : 0,
      softness: LOOK.softness,
      flip,
      noise: this.noise.canvas,
    });
    if (!r) return false;
    const og = fitAtLeast(st.out, rw, rh).getContext('2d');
    og.clearRect(0, 0, rw, rh);
    og.drawImage(r.canvas, r.sx, r.sy, r.w, r.h, 0, 0, rw, rh);
    st.prep = { w: rw, h: rh, sub, flip, at: f.now, params: G.params, lookKey, gpu: true, frame: c.anim.frameId, key: G.key };
    return true;
  }

  // 위에서부터 reveal 비율만큼만 보이게(아래 끝은 부드럽게). 걸어 나오기 첫머리: 포스터에서 벗겨지듯 드러난다
  revealed(st, reveal) {
    const w = st.prep.w;
    const h = st.prep.h;
    const c = fitAtLeast(this.rev, w, h); // reveal<1이면 sub 없이 통째로 칠해 둔 것이다(drawCharacter)
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(st.out, 0, 0, w, h, 0, 0, w, h);
    const feather = 0.18;
    const edge = Math.max(0, reveal) * (1 + feather) * h;
    const grad = g.createLinearGradient(0, edge - feather * h, 0, edge);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  // 걸어 나오기 빛: 실루엣을 작게 줄였다 키운 따뜻한 흰 빛을 더하기(lighter)로 얹는다. kind: GLOW.halo | GLOW.flash
  drawGlow(ctx, c, box, W, H, amount, kind) {
    let gc = this.glows.get(c.art);
    if (!gc) {
      // 둘레에 여백(PAD)을 두고 작게 그린다: 여백이 없으면 빛이 그림 판 끝(발밑)에서 반듯하게 잘렸다
      const sil = c.art.silhouette;
      const sw = Math.max(2, Math.round(sil.width / GLOW.shrink));
      const sh = Math.max(2, Math.round(sil.height / GLOW.shrink));
      const px = Math.ceil(sw * GLOW.pad);
      const py = Math.ceil(sh * GLOW.pad);
      gc = makeCanvas(sw + 2 * px, sh + 2 * py);
      const g = gc.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(sil, px, py, sw, sh);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = GLOW.tint;
      g.fillRect(0, 0, gc.width, gc.height);
      gc.padX = px / sw;
      gc.padY = py / sh;
      this.glows.set(c.art, gc);
    }
    const w = box.w * W * kind.scale * (1 + 2 * gc.padX);
    const h = box.h * H * kind.scale * (1 + 2 * gc.padY);
    const cx = (box.x0 + box.w / 2) * W;
    const cy = (box.y0 + box.h / 2) * H;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, amount * kind.alpha);
    if (c.placement.flip) {
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-cx, 0);
    }
    ctx.drawImage(gc, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
  }

  // 캐릭터를 이번 크기·장면에 맞춰 칠해 둔다(보기 방향으로, 좌우 반전 포함)
  prepare(st, c, box, f, pw, ph, lookKey) {
    const art = c.art;
    const flip = c.placement.flip;
    const k = f.look.harmonize;

    // 1) 0.8배로 줄였다 키워 카메라 화면만큼 무르게
    const sw = Math.max(1, Math.round(pw * LOOK.softness));
    const sh = Math.max(1, Math.round(ph * LOOK.softness));
    const sg = fit(st.soft, sw, sh).getContext('2d');
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.clearRect(0, 0, sw, sh);
    sg.imageSmoothingQuality = 'high';
    if (flip) sg.setTransform(-1, 0, 0, 1, sw, 0);
    sg.drawImage(art.img, 0, 0, sw, sh);
    sg.setTransform(1, 0, 0, 1, 0, 0);

    const g = fit(st.work, pw, ph).getContext('2d', { willReadFrequently: true });
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, pw, ph);
    g.imageSmoothingQuality = 'high';
    g.drawImage(st.soft, 0, 0, pw, ph);

    // 2) 빛 번짐 재료: 흐린 배경(색) × 가장자리 띠(알파)
    const wrapA = LOOK.wrapAlpha * k;
    let wrap = null;
    if (wrapA > 0) {
      const tw = Math.max(2, Math.round(pw / LOOK.wrapShrink));
      const th = Math.max(2, Math.round(ph / LOOK.wrapShrink));
      const tg = fit(this.tiny, tw, th).getContext('2d');
      tg.clearRect(0, 0, tw, th);
      tg.imageSmoothingQuality = 'high';
      drawRegion(tg, f.source, f.view, { x: box.x0, y: box.y0, w: box.w, h: box.h }, tw, th);
      const wg = fit(st.wrap, pw, ph).getContext('2d', { willReadFrequently: true });
      wg.setTransform(1, 0, 0, 1, 0, 0);
      wg.globalCompositeOperation = 'source-over';
      wg.clearRect(0, 0, pw, ph);
      wg.imageSmoothingQuality = 'high';
      wg.drawImage(this.tiny, 0, 0, pw, ph);
      wg.globalCompositeOperation = 'destination-in';
      if (flip) wg.setTransform(-1, 0, 0, 1, pw, 0);
      wg.drawImage(art.edge, 0, 0, pw, ph);
      wg.setTransform(1, 0, 0, 1, 0, 0);
      wg.globalCompositeOperation = 'source-over';
      wrap = { data: wg.getImageData(0, 0, pw, ph).data, alpha: Math.min(1, wrapA) };
    }

    // 3) 색 맞춤 → 빛 번짐(스크린) → 그레인(픽셀 처리 한 번)
    const scene = st.stats ?? art.stats;
    const params = harmonizeParams(scene, art.stats, k, this.whole ?? scene);
    const img = g.getImageData(0, 0, pw, ph);
    const n = this.noise;
    const grain =
      f.look.grain > 0
        ? { tile: n.tile, size: n.size, alpha: LOOK.artGrain * f.look.grain, ox: (Math.random() * n.size) | 0, oy: (Math.random() * n.size) | 0 }
        : null;
    applyHarmonize(img.data, pw, buildLuts(params), params.sat, grain, wrap);
    g.putImageData(img, 0, 0);

    // CPU 캔버스를 매 프레임 그리면 매번 올려 보내야 해서, 결과는 보통 캔버스에 한 번 옮겨 둔다
    const og = fit(st.out, pw, ph).getContext('2d');
    og.clearRect(0, 0, pw, ph);
    og.drawImage(st.work, 0, 0);

    st.prep = { w: pw, h: ph, flip, at: f.now, params, lookKey };
    st.applied = st.stats;
    st.appliedWhole = this.whole;
  }

  // 사람 가림: 캐릭터 상자(+그림자 범위) 안에서만, 사람 마스크 자리의 카메라 픽셀을 다시 그린다. tilt면 돌린 범위를 감싼다
  occlude(ctx, f, box, shadowBox, tilt = 0) {
    const W = f.view.viewW;
    const H = f.view.viewH;
    let ux0 = Math.min(box.x0 * W, shadowBox.x);
    let uy0 = Math.min(box.y0 * H, shadowBox.y);
    let ux1 = Math.max(box.x1 * W, shadowBox.x + shadowBox.w);
    let uy1 = Math.max(box.y1 * H, shadowBox.y + shadowBox.h);
    if (Math.abs(tilt) > 1e-3) {
      const r = rotatedBounds({ x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 }, box.fx * W, box.fy * H, tilt);
      ux0 = r.x;
      uy0 = r.y;
      ux1 = r.x + r.w;
      uy1 = r.y + r.h;
    }
    const x0 = Math.max(0, Math.floor(ux0));
    const y0 = Math.max(0, Math.floor(uy0));
    const x1 = Math.min(W, Math.ceil(ux1));
    const y1 = Math.min(H, Math.ceil(uy1));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return;
    const g = fit(this.occ, rw, rh).getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, rw, rh);
    g.imageSmoothingQuality = 'high';
    drawRegion(g, f.source, f.view, { x: x0 / W, y: y0 / H, w: rw / W, h: rh / H }, rw, rh);
    g.globalCompositeOperation = 'destination-in';
    this.maskTransform(g, f, -x0, -y0);
    g.drawImage(f.mask.canvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.occ, 0, 0, rw, rh, x0, y0, rw, rh);
  }

  // 마스크(보이는 자르기 전체, 반전 전) → 대상 픽셀. ox, oy는 대상 캔버스 원점 이동
  maskTransform(g, f, ox, oy) {
    const m = f.mask.canvas;
    const W = f.view.viewW;
    const H = f.view.viewH;
    if (f.view.mirror) g.setTransform(-W / m.width, 0, 0, H / m.height, W + ox, oy);
    else g.setTransform(W / m.width, 0, 0, H / m.height, ox, oy);
  }

  // 디버그: 사람 마스크를 붉게 덮어 보여 준다(미리보기 전용)
  drawTint(ctx, f) {
    const m = f.mask.canvas;
    const g = fit(this.tint, m.width, m.height).getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, m.width, m.height);
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#e3232b';
    g.fillRect(0, 0, m.width, m.height);
    ctx.save();
    ctx.globalAlpha = 0.3;
    this.maskTransform(ctx, f, 0, 0);
    ctx.drawImage(this.tint, 0, 0);
    ctx.restore();
  }

  photoGrain(ctx, W, H, grain) {
    const a = LOOK.photoGrain * grain;
    if (a <= 0) return;
    let pat = this.patterns.get(ctx);
    if (!pat) {
      pat = ctx.createPattern(this.noise.canvas, 'repeat');
      this.patterns.set(ctx, pat);
    }
    const s = this.noise.size;
    const ox = (Math.random() * s) | 0;
    const oy = (Math.random() * s) | 0;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = a;
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pat;
    ctx.fillRect(ox, oy, W, H);
    ctx.restore();
  }
}
