// 포스터 AR의 세계 계산. 순수 모듈(DOM 없음)이라 노드에서도 그대로 시험한다.
//
// 좌표계
// - 포스터 좌표(미터): 포스터 가운데가 원점, x 오른쪽, y 위, z 벽에서 앞(카메라 쪽). 바닥은 y = -포스터 가운데 높이.
// - 대상 좌표(MindAR GL 물체 좌표, 대상 그림 픽셀): x 왼쪽 끝부터, y 아래 끝부터 위로, z 앞으로. 포스터 폭 = 대상 그림 폭(px).
// - 카메라 좌표(GL): x 오른쪽, y 위, 카메라는 -z를 본다. 단위는 대상 그림 픽셀(MindAR가 준 자세 그대로).
// - 입력 픽셀: 인식에 넣은 축소 프레임(영상 전체를 같은 비율로 줄인 것)의 픽셀. 왼쪽 위가 0, y 아래로.
// 행렬은 MindAR·three와 같은 4×4 열 우선(column-major) 배열, 3×3 회전은 행 우선 [[..],[..],[..]].

export const POSTER_WIDTH_M = 0.5; // B2 포스터 폭(인쇄물) 기본값. 대상 그림 폭이 이 길이라고 본다. 실제 값은 캐릭터.json의 ar.posterWidth

// ── 4×4 ──────────────────────────────────────────
export function apply4(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// 3×3 회전 R(행 우선)을 4×4 G 앞에 곱한다: [R 0; 0 1] × G
export function rotate4(R, G) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    const a = G[c * 4];
    const b = G[c * 4 + 1];
    const d = G[c * 4 + 2];
    out[c * 4] = R[0][0] * a + R[0][1] * b + R[0][2] * d;
    out[c * 4 + 1] = R[1][0] * a + R[1][1] * b + R[1][2] * d;
    out[c * 4 + 2] = R[2][0] * a + R[2][1] * b + R[2][2] * d;
    out[c * 4 + 3] = G[c * 4 + 3];
  }
  return out;
}

// MindAR GL 자세 행렬 → MindAR 내부 자세(modelViewTransform 3×4). controller._glModelViewMatrix의 역.
// 예측한 자세에서 추적을 다시 시작할 때 쓴다(포스터가 가려졌다 보이면 찾기 없이 바로 붙는다)
export function glToMvt(G, markerH) {
  const m01 = -G[4];
  const m11 = G[5];
  const m21 = G[6];
  return [
    [G[0], m01, -G[8], G[12] - m01 * markerH],
    [-G[1], m11, G[9], -G[13] - m11 * markerH],
    [-G[2], m21, G[10], -G[14] - m21 * markerH],
  ];
}

// ── 카메라 ───────────────────────────────────────
// 긴 변 화각(도)으로 초점 거리(px). 폰 세로 영상은 세로가 긴 변
export function intrinsics(w, h, longFovDeg) {
  const f = Math.max(w, h) / 2 / Math.tan(((longFovDeg * Math.PI) / 180) / 2);
  return { f, cx: w / 2, cy: h / 2, w, h };
}

// 카메라 좌표 → 입력 픽셀. 카메라 뒤(또는 너무 가까움)면 null
export function projectInput(c, K) {
  if (c[2] > -1e-3) return null;
  const iz = 1 / -c[2];
  return [K.cx + K.f * c[0] * iz, K.cy - K.f * c[1] * iz];
}

// 포스터 좌표(m) → 대상 좌표(px)
export function posterToObject(p, dims, posterW = POSTER_WIDTH_M) {
  const k = dims[0] / posterW;
  return [dims[0] / 2 + p[0] * k, dims[1] / 2 + p[1] * k, p[2] * k];
}

// ── 기기 방향(자이로) ──────────────────────────────
const rad = (d) => (d * Math.PI) / 180;

function mul3(A, B) {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return o;
}

export function transpose3(A) {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

// deviceorientation(도) → 지구←기기 회전. W3C 규격: R = Rz(alpha)·Rx(beta)·Ry(gamma)
// 기기 축: x 화면 오른쪽, y 화면 위(세로로 든 폰의 위쪽), z 화면에서 사용자 쪽
export function orientationMatrix(alpha, beta, gamma) {
  const a = rad(alpha);
  const b = rad(beta);
  const g = rad(gamma);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

// 기기←카메라(GL 축) 회전. 화면 방향(screen.orientation.angle, 도)만큼 영상이 돌아 나오고,
// 앞 카메라는 기기 쪽(+z)을 보며 원본 영상(거울 반전 전)의 오른쪽이 기기 -x다
function devFromCam(screenAngle = 0, front = false) {
  const t = rad(screenAngle);
  const c = Math.cos(t);
  const s = Math.sin(t);
  // 기기←화면 = Rz(angle)ᵀ
  const m = [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
  return front ? mul3(m, [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]) : m;
}

// 지구←카메라(GL 축) 회전
export function cameraMatrix(alpha, beta, gamma, screenAngle = 0, front = false) {
  return mul3(orientationMatrix(alpha, beta, gamma), devFromCam(screenAngle, front));
}

// 같은 것을 기기 방향 사원수로(자이로 기록에서 보간한 값)
export function cameraMatrixQ(q, screenAngle = 0, front = false) {
  return mul3(quatToMatrix(q), devFromCam(screenAngle, front));
}

// 자이로 없이 화면 방향만 바뀐 것(폰을 세로↔가로로 돌림): 기기는 그대로라고 보고 화면 각만 넣은 회전.
// 둘 사이 cameraDelta가 영상이 돌아간 만큼의 z축 회전이 된다
export function screenMatrix(screenAngle = 0, front = false) {
  return devFromCam(screenAngle, front);
}

// ── 사원수 [w, x, y, z] (자이로 기록·보간·평균) ──
function qmul(p, q) {
  return [
    p[0] * q[0] - p[1] * q[1] - p[2] * q[2] - p[3] * q[3],
    p[0] * q[1] + p[1] * q[0] + p[2] * q[3] - p[3] * q[2],
    p[0] * q[2] - p[1] * q[3] + p[2] * q[0] + p[3] * q[1],
    p[0] * q[3] + p[1] * q[2] - p[2] * q[1] + p[3] * q[0],
  ];
}

const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// deviceorientation(도) → 지구←기기 사원수. orientationMatrix와 같은 Rz(alpha)·Rx(beta)·Ry(gamma)
export function quatFromOrientation(alpha, beta, gamma) {
  const a = rad(alpha) / 2;
  const b = rad(beta) / 2;
  const g = rad(gamma) / 2;
  return qmul(qmul([Math.cos(a), 0, 0, Math.sin(a)], [Math.cos(b), Math.sin(b), 0, 0]), [Math.cos(g), 0, Math.sin(g), 0]);
}

export function quatToMatrix(q) {
  const [w, x, y, z] = qnorm(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

// 같은 반구로 맞춘다(q와 -q는 같은 회전: 섞기 전에 맞춰야 한다)
export function qalign(ref, q) {
  return qdot(ref, q) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

// 구면 보간(가까우면 선형 보간 후 정규화)
export function qslerp(a, b, t) {
  const bb = qalign(a, b);
  const d = Math.min(1, qdot(a, bb));
  if (d > 0.9995) return qnorm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d);
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return a.map((v, i) => v * ka + bb[i] * kb);
}

// 가까운 회전 여럿의 평균(반구를 맞춰 더한 뒤 정규화). 몇 도 안의 흔들림에는 충분히 정확하다
export function qmean(list) {
  const ref = list[0];
  const s = [0, 0, 0, 0];
  for (const q of list) {
    const a = qalign(ref, q);
    for (let i = 0; i < 4; i++) s[i] += a[i];
  }
  return qnorm(s);
}

// 카메라가 R0 → R1로 돌았을 때, 그 전 카메라 좌표의 점을 지금 카메라 좌표로 옮기는 회전: R1ᵀ·R0
export function cameraDelta(R0, R1) {
  return mul3(transpose3(R1), R0);
}

// 포스터를 세워 바로잡기: 포스터는 수직 벽에 똑바로 걸려 있다고 보고, 자이로가 알려 주는 중력(위) 방향으로
// 포스터의 위쪽 축을 맞추고 앞쪽(법선)을 수평으로 만든다. 가운데 자리와 벽의 방향(좌우로 돈 각)은 그대로 둔다.
// 화면에서 작은 포스터(폭 150px 안팎)는 앞뒤로 기운 각을 잘 못 재서(평면 자세의 모호함) 1.4m 아래 바닥 자리가
// 수십 px씩 어긋났다. G: GL 자세(대상 px 좌표 → 카메라), R: 지구←카메라 회전(cameraMatrix), dims: 대상 크기.
// az(라디안, 지구 좌표에서 벽 법선의 방위)를 주면 벽이 바라보는 방향도 그 값으로 맞춘다(wallAzimuth로 잰 것의 평균)
export function upright(G, R, dims, az = null) {
  const up = [R[2][0], R[2][1], R[2][2]]; // 카메라 좌표의 위(지구 z)
  const col = (i) => [G[i * 4], G[i * 4 + 1], G[i * 4 + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const z0 = norm(col(2));
  const d = dot(z0, up);
  let z = norm([z0[0] - d * up[0], z0[1] - d * up[1], z0[2] - d * up[2]]); // 수평으로 만든 법선
  if (!Number.isFinite(z[0]) || Math.abs(d) > 0.7) return G; // 포스터가 바닥·천장에 누운 것처럼 보이면(오인식) 그대로
  if (az != null) {
    // 지구 좌표의 수평 방향 (cos az, sin az, 0)을 카메라 좌표로(Rᵀ)
    const e = [Math.cos(az), Math.sin(az), 0];
    z = norm([R[0][0] * e[0] + R[1][0] * e[1], R[0][1] * e[0] + R[1][1] * e[1], R[0][2] * e[0] + R[1][2] * e[1]]);
  }
  const y = up;
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]; // x = y × z
  const k = Math.hypot(...col(0)); // 축 길이(MindAR 자세는 1)
  const c = apply4(G, [dims[0] / 2, dims[1] / 2, 0]);
  const hx = dims[0] / 2;
  const hy = dims[1] / 2;
  return [
    x[0] * k, x[1] * k, x[2] * k, 0,
    y[0] * k, y[1] * k, y[2] * k, 0,
    z[0] * k, z[1] * k, z[2] * k, 0,
    c[0] - k * (hx * x[0] + hy * y[0]), c[1] - k * (hx * x[1] + hy * y[1]), c[2] - k * (hx * x[2] + hy * y[2]), 1,
  ];
}

// 벽 법선의 방위(지구 좌표, 라디안). 포스터가 거의 눕혀 보이면 null
export function wallAzimuth(G, R) {
  const l = Math.hypot(G[8], G[9], G[10]) || 1;
  const z = [G[8] / l, G[9] / l, G[10] / l];
  const e = [R[0][0] * z[0] + R[0][1] * z[1] + R[0][2] * z[2], R[1][0] * z[0] + R[1][1] * z[1] + R[1][2] * z[2]];
  if (Math.hypot(e[0], e[1]) < 0.7) return null;
  return Math.atan2(e[1], e[0]);
}

// ── 흔들림 거르기(One Euro, MindAR와 같은 식. 시간은 ms) ──
const smoothing = (te, cutoff) => {
  const r = 2 * Math.PI * cutoff * te;
  return r / (r + 1);
};

export class OneEuro {
  constructor({ minCutOff = 0.001, beta = 1000, dCutOff = 0.001 } = {}) {
    Object.assign(this, { minCutOff, beta, dCutOff });
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = null;
    this.t = 0;
  }

  filter(t, x) {
    if (!this.x || t <= this.t) {
      this.x = x.slice();
      this.dx = x.map(() => 0);
      this.t = t;
      return x.slice();
    }
    const te = t - this.t;
    const ad = smoothing(te, this.dCutOff);
    const out = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const d = (x[i] - this.x[i]) / te;
      const dHat = ad * d + (1 - ad) * this.dx[i];
      const a = smoothing(te, this.minCutOff + this.beta * Math.abs(dHat));
      out[i] = a * x[i] + (1 - a) * this.x[i];
      this.dx[i] = dHat;
    }
    this.x = out;
    this.t = t;
    return out.slice();
  }
}

// ── 화면 배치 ────────────────────────────────────
// 보기 정규 좌표의 발·머리 점 → 배치 값. 키는 발~머리 길이(화면 픽셀로 잰 것을 보기 높이로 나눔),
// tilt는 그 선이 화면 세로에서 기운 각(라디안, 시계 방향 +). 카메라를 기울여 들면 캐릭터도 같이 기운다
export function placementFromPoints(feet, head, viewW, viewH) {
  const dx = (head.x - feet.x) * viewW;
  const dy = (head.y - feet.y) * viewH;
  const len = Math.hypot(dx, dy);
  return { cx: feet.x, feetY: feet.y, heightFrac: len / viewH, tilt: Math.atan2(dx, -dy) };
}

export function lerpPlacementAR(a, b, t) {
  const L = (x, y) => x + (y - x) * t;
  let dt = b.tilt - a.tilt;
  if (dt > Math.PI) dt -= 2 * Math.PI;
  if (dt < -Math.PI) dt += 2 * Math.PI;
  return { ...b, cx: L(a.cx, b.cx), feetY: L(a.feetY, b.feetY), heightFrac: L(a.heightFrac, b.heightFrac), tilt: a.tilt + dt * t };
}

// ── 걸어 나오기 ───────────────────────────────────
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export const STEP_OUT_MS = 1500;
// 포스터 그림 자리에서 다 드러난 순간(번쩍임이 끝나고 아직 앞으로 나오기 전). 착지 자리가 화면에 다 안 들어오면
// (폰이 포스터에 너무 가까움) 여기서 멈춰 기다렸다가 뒤로 물러나면 이어 간다
export const STEP_WAIT_U = 0.2;

// 걸어 나오기 한 순간(u = 0..1). from: 포스터 그림 속 자리 { feet:[x,y,z], height }(m), to: 바닥 자리.
// 반환: 그 순간의 발 지점·키(m), 불투명도, 뒤 빛(glow, 0..1), 앞 번쩍임(flash), 그림자 세기 배율, 위에서부터 드러난 비율(reveal)
// - 0~0.2   포스터 그림 자리에서 번쩍이며 위에서부터 드러난다(포스터에 납작하게 붙은 채). 0.2에서 멈춰 기다릴 수 있다
// - 0.18~0.86 포스터에서 떨어져 나와(앞으로 먼저) 살짝 떠올랐다가 바닥 자리로 내려오며 사람 크기로 커진다
// - 0.8~1   내려앉는다: 발밑 그림자가 짙어지고 빛이 사라지며 아주 조금 눌렸다 편다
// reduced(움직임 줄이기)면 바닥 자리에서 그대로 서서히 나타난다
export function stepOut(u, from, to, reduced = false) {
  const t = clamp01(u);
  if (reduced) {
    const a = smooth(0, 0.6, t);
    return { feet: to.feet.slice(), height: to.height, alpha: a, glow: 0, flash: 0, shadow: a, reveal: 1 };
  }
  const reveal = smooth(0.0, 0.2, t);
  const s = easeInOut(clamp01((t - 0.18) / 0.68));
  const zOut = easeOut(clamp01((t - 0.12) / 0.5)); // 앞으로는 먼저 나온다(벽에서 떨어짐)
  const hop = 0.1 * Math.sin(Math.PI * s); // 살짝 떠올랐다 내려온다(m)
  const feet = [
    from.feet[0] + (to.feet[0] - from.feet[0]) * s,
    from.feet[1] + (to.feet[1] - from.feet[1]) * s + hop,
    from.feet[2] + (to.feet[2] - from.feet[2]) * zOut,
  ];
  const land = clamp01((t - 0.84) / 0.16);
  const squash = 1 - 0.035 * Math.sin(Math.PI * land);
  const height = (from.height + (to.height - from.height) * s) * squash;
  const glow = clamp01(smooth(0, 0.1, t) * (1 - smooth(0.35, 0.8, t))); // 뒤에서 번지는 빛(날아오는 동안 사그라든다)
  const flash = clamp01(smooth(0, 0.05, t) * (1 - smooth(0.08, STEP_WAIT_U, t))); // 처음 잠깐 캐릭터 위로 번쩍(포스터 안에서 기다리는 자리 전에 끝난다)
  return { feet, height, alpha: smooth(0, 0.16, t), glow, flash, shadow: smooth(0.72, 1, t), reveal };
}
