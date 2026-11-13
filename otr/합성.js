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
  // still: 촬영용(통계를 매번 새로 재고, 평활·주기 제한 없이 바로 칠한다)
  constructor({ noise, still = false }) {
    this.noise = noise;
    this.still = still;
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
        out: makeCanvas(), // 매 프레임 그릴 결과
        soft: makeCanvas(),
        wrap: makeCanvas(),
      };
      this.chars.set(id, st);
    }
    return st;
  }

  // f: { source, view, cast:[{art, placement}], mask:{canvas}|null, look:{harmonize, shadow, grain, occlusion}, now, debugTint }
  // 반환: 캐릭터별 { id, box(보기 정규), stats, params } (디버그·시험용)
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
      this.updateStats(st, f, box, c.art);
      const shadowBox = this.castShadow(ctx, c, box, W, H, f.look.shadow);
      this.contactShadow(ctx, c, box, W, H, f.look.shadow * shadowLight(st.stats?.lum ?? 0.5));
      this.soleShadow(ctx, c, box, W, H, f.look.shadow);
      this.drawCharacter(ctx, st, c, box, f);
      if (f.mask && f.look.occlusion && c.placement.front === 'person') this.occlude(ctx, f, box, shadowBox);
      report.push({ id: c.art.id, box, stats: st.stats, whole: this.whole, params: st.prep?.params ?? null });
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

  drawCharacter(ctx, st, c, box, f) {
    const W = f.view.viewW;
    const H = f.view.viewH;
    const pw = Math.max(2, Math.round(box.w * W));
    const ph = Math.max(2, Math.round(box.h * H));
    const flip = c.placement.flip;
    const lookKey = `${f.look.harmonize}|${f.look.grain}`;
    const prep = st.prep;
    const since = f.now - (prep?.at ?? -Infinity);
    const sizeChanged = !prep || Math.abs(prep.w - pw) > Math.max(1, pw * 0.01) || prep.flip !== flip;
    const lookChanged =
      !prep || prep.lookKey !== lookKey || statsChanged(st.applied, st.stats) || statsChanged(st.appliedWhole, this.whole);
    if (this.still || !prep || (sizeChanged && since >= LOOK.resizeEvery) || (lookChanged && since >= LOOK.statsEvery)) {
      this.prepare(st, c, box, f, pw, ph, lookKey);
    }
    ctx.drawImage(st.out, 0, 0, st.prep.w, st.prep.h, box.x0 * W, box.y0 * H, box.w * W, box.h * H);
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

  // 사람 가림: 캐릭터 상자(+그림자 범위) 안에서만, 사람 마스크 자리의 카메라 픽셀을 다시 그린다
  occlude(ctx, f, box, shadowBox) {
    const W = f.view.viewW;
    const H = f.view.viewH;
    const x0 = Math.max(0, Math.floor(Math.min(box.x0 * W, shadowBox.x)));
    const y0 = Math.max(0, Math.floor(Math.min(box.y0 * H, shadowBox.y)));
    const x1 = Math.min(W, Math.ceil(Math.max(box.x1 * W, shadowBox.x + shadowBox.w)));
    const y1 = Math.min(H, Math.ceil(Math.max(box.y1 * H, shadowBox.y + shadowBox.h)));
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
