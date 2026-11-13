// 색 맞춤. 순수 모듈(DOM 없음). 그림 캐릭터를 카메라 장면의 빛·색에 맞춰 사진 속에 선 것처럼 보이게 한다.
//
// 장면 통계 두 가지를 쓴다.
// - 국소 통계: 캐릭터 둘레(상자 ±50%)를 64×36으로 줄여 잰 것. 화이트밸런스(그 자리 빛 색)와 접지 그림자 세기에 쓴다.
// - 전체 통계: 보이는 화면 전체를 64×36으로 줄여 잰 것. 톤(검정·흰색 지점)에 쓴다.
//   국소 창만 보면 캐릭터 둘레가 밝은 벽뿐일 때 검정이 크게 떠서(부츠가 빛바랜 판지처럼 보임) 손님이 다가올 때마다
//   검정이 출렁였다. 화면 전체에는 보통 손님의 머리·옷이 들어 있어 카메라의 실제 검정·밝은 쪽을 더 잘 알려 준다.
// 맞추는 것
// - 화이트밸런스: 장면이 따뜻하면 캐릭터도 따뜻하게(회색 세계 가정, 밝기는 그대로, 일부만)
// - 톤: 진짜 사진은 완전한 검정·흰색이 드물다. 검정은 화면 어두운 쪽(p2) 쪽으로 조금(최대 0.08, 웹캠 검정 수준),
//   흰색은 화면 밝은 쪽(p98) 쪽으로 눌러 어두운 방에서 캐릭터만 빛나지 않게 한다. 가장 효과가 큰 단서다.
// - 채도: 애니 그림은 카메라 사진보다 색이 진해서 세기에 따라 조금 뺀다(기본 0.85배).
//   배경 채도에 맞추던 방식은 회색 벽이면 늘 바래고, 따뜻한 조명의 색 쏠림을 채도로 읽어 오히려 올려서 뺐다.
// 세기 k(0..1)로 전부 함께 줄였다 키운다. 계산은 채널별 256칸 표(LUT) + 픽셀마다 채도·빛 번짐·그레인 한 번.
// 캔버스 ctx.filter는 사파리에서 꺼져 있어 쓰지 않는다.

export const LUMA = [0.2126, 0.7152, 0.0722];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// RGBA 배열 → { mean:[r,g,b](0..1), lum, p2, p5, p95, p98, sat, n }
// alphaMin 미만 픽셀은 뺀다(그림의 투명 부분, 장면 상자가 화면 밖으로 나가 비어 있는 부분)
export function statsFromRGBA(data, { alphaMin = 1 } = {}) {
  const hist = new Uint32Array(256);
  let r = 0;
  let g = 0;
  let b = 0;
  let sat = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < alphaMin) continue;
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    r += R;
    g += G;
    b += B;
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    sat += mx - mn; // 채도는 색 폭(max-min)으로 잰다: 어두운 픽셀에서 튀지 않는다
    hist[Math.round(LUMA[0] * R + LUMA[1] * G + LUMA[2] * B)]++;
    n++;
  }
  if (n === 0) return null;
  const pct = (q) => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  const mean = [r / n / 255, g / n / 255, b / n / 255];
  return {
    mean,
    lum: LUMA[0] * mean[0] + LUMA[1] * mean[1] + LUMA[2] * mean[2],
    p2: pct(0.02),
    p5: pct(0.05),
    p95: pct(0.95),
    p98: pct(0.98),
    sat: sat / n / 255,
    n,
  };
}

// 국소 장면 통계·그림 통계·전체 화면 통계 → 맞춤 값 { gains:[r,g,b], black, white, sat }
// whole(전체 통계)이 없으면 국소 통계로 대신한다
export function harmonizeParams(scene, art, k, whole = scene) {
  const s = clamp(k, 0, 1);
  const m = scene.mean;
  const avg = Math.max((m[0] + m[1] + m[2]) / 3, 1e-4);
  // 회색 세계: 장면 평균의 색 기울기를 일부(지수 0.5k)만 옮긴다. 웹캠은 자동 화이트밸런스가 있고,
  // 세게 옮기면 색 있는 배경(부스 현수막 등) 옆에서 캐릭터가 그 색으로 물든다
  let gains = m.map((c) => Math.pow(Math.max(c, 1e-4) / avg, 0.5 * s));
  // 밝기 보존: 밝기 가중합이 1이 되게 나눈 뒤 채널마다 [0.85, 1.15]로 묶는다
  const l = gains[0] * LUMA[0] + gains[1] * LUMA[1] + gains[2] * LUMA[2];
  gains = gains.map((x) => clamp(x / l, 0.85, 1.15));
  const p2 = whole.p2 ?? whole.p5 ?? 0;
  const p98 = whole.p98 ?? whole.p95 ?? 1;
  const black = clamp(p2 * 0.8 * s, 0, 0.08);
  // 흰 천은 밝은 회색 벽보다 조금 밝다: 화면 p98의 1.15배를 흰색 목표로
  const white = clamp(1 + (Math.min(1, p98 * 1.15) - 1) * Math.min(1, 1.5 * s), 0.5, 1);
  const sat = clamp(1 - 0.25 * s, 0.75, 1);
  return { gains, black, white, sat };
}

// 맞춤 값 → 채널별 256칸 표. 순서: 화이트밸런스 이득 → 검정·흰색 지점
export function buildLuts({ gains, black, white }) {
  return gains.map((gain) => {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const c = clamp((i / 255) * gain, 0, 1);
      lut[i] = Math.round((black + c * (white - black)) * 255);
    }
    return lut;
  });
}

// ImageData.data에 바로 적용한다(제자리 수정). 투명 픽셀은 건너뛴다. 순서: 표 → 채도 → 빛 번짐 → 그레인.
// wrap이 있으면 빛 번짐을 스크린 혼합으로 더한다: { data(RGBA, 같은 크기. 색=흐린 배경, 알파=가장자리 띠), alpha }.
//   스크린은 빛을 더하기만 해서 어두운 배경 앞에서 흰 옷 윤곽을 회색으로 물들이지 않는다(섞기 방식의 문제였다).
// grain이 있으면 미리 만든 잡음 타일을 오버레이 혼합으로 얹는다: { tile:Uint8Array(평균 128), size, alpha, ox, oy }
export function applyHarmonize(data, width, luts, sat, grain = null, wrap = null) {
  const [lr, lg, lb] = luts;
  const doSat = Math.abs(sat - 1) > 1e-3;
  const satQ = Math.round(sat * 256);
  const ga = grain ? grain.alpha : 0;
  const tile = grain?.tile;
  const ts = grain?.size ?? 1;
  const ox = grain?.ox ?? 0;
  const oy = grain?.oy ?? 0;
  const wd = wrap && wrap.alpha > 0 ? wrap.data : null;
  const wk = wd ? wrap.alpha / (255 * 255) : 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] === 0) continue;
    let r = lr[data[i]];
    let g = lg[data[i + 1]];
    let b = lb[data[i + 2]];
    if (doSat) {
      const y = (r * 54 + g * 183 + b * 19) >> 8; // 밝기(정수 근사)
      r = y + (((r - y) * satQ) >> 8);
      g = y + (((g - y) * satQ) >> 8);
      b = y + (((b - y) * satQ) >> 8);
    }
    if (wd && wd[i + 3] > 0) {
      // 스크린: c + 배경 × (1 - c) × 세기
      const t = wd[i + 3] * wk;
      r += wd[i] * (255 - r) * t;
      g += wd[i + 1] * (255 - g) * t;
      b += wd[i + 2] * (255 - b) * t;
    }
    if (ga > 0) {
      const x = p % width;
      const yy = (p - x) / width;
      const nz = tile[((yy + oy) % ts) * ts + ((x + ox) % ts)];
      r = overlay(r, nz, ga);
      g = overlay(g, nz, ga);
      b = overlay(b, nz, ga);
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

// 오버레이 혼합(0..255). 잡음이 128이면 원래 값 그대로
export function overlay(base, noise, alpha) {
  const o = base < 128 ? (2 * base * noise) / 255 : 255 - (2 * (255 - base) * (255 - noise)) / 255;
  return base + (o - base) * alpha;
}

// 통계가 눈에 띄게 바뀌었는지(이때만 캐릭터를 다시 칠한다)
export function statsChanged(a, b, eps = 0.012) {
  if (!a || !b) return true;
  return (
    Math.abs(a.mean[0] - b.mean[0]) > eps ||
    Math.abs(a.mean[1] - b.mean[1]) > eps ||
    Math.abs(a.mean[2] - b.mean[2]) > eps ||
    Math.abs((a.p2 ?? a.p5) - (b.p2 ?? b.p5)) > eps ||
    Math.abs(a.p5 - b.p5) > eps ||
    Math.abs(a.p95 - b.p95) > eps ||
    Math.abs((a.p98 ?? a.p95) - (b.p98 ?? b.p95)) > eps ||
    Math.abs(a.sat - b.sat) > eps
  );
}

// 통계를 시간에 따라 부드럽게(깜빡임 방지)
export function lerpStats(a, b, t) {
  if (!a) return b;
  const L = (x, y) => x + (y - x) * t;
  const mean = [L(a.mean[0], b.mean[0]), L(a.mean[1], b.mean[1]), L(a.mean[2], b.mean[2])];
  return {
    mean,
    lum: L(a.lum, b.lum),
    p2: L(a.p2 ?? a.p5, b.p2 ?? b.p5),
    p5: L(a.p5, b.p5),
    p95: L(a.p95, b.p95),
    p98: L(a.p98 ?? a.p95, b.p98 ?? b.p95),
    sat: L(a.sat, b.sat),
    n: b.n,
  };
}

// 바닥 접촉 그림자 세기 배율: 어두운 장면일수록 약하게
export function shadowLight(sceneLum) {
  return clamp(sceneLum / 0.45, 0.35, 1);
}
