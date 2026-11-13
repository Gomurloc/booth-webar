// 캐릭터 배치 모델. 순수 모듈(DOM 없음).
//
// 배치 하나 = { cx, feetY, heightFrac, flip, locked, front }
// - cx: 발 지점의 가로 위치(보기 정규 0..1)
// - feetY: 발바닥 높이(보기 정규, 1을 조금 넘어도 된다)
// - heightFrac: 머리 꼭대기~발바닥 높이 / 보기 높이
// - flip: 그림 좌우 반전, locked: 부스에서 손님이 못 움직이게 잠금
// - front: 'person'이면 사람이 캐릭터 앞에 서면 캐릭터를 가린다, 'character'면 캐릭터가 늘 앞
// 그림 정보(art)는 캐릭터.json 한 줄 + 그림 비율: { aspect(가로/세로 px), top, feet:{x,y} }

const DEFAULTS = {
  landscape: { feetY: 0.95, heightFrac: 0.78, cx: { record: 0.22, aria: 0.78 } },
  portrait: { feetY: 0.93, heightFrac: 0.6, cx: { record: 0.2, aria: 0.8 } },
};

export const LIMITS = { minHeight: 0.12, maxHeight: 1.4, minFeetY: 0.2, maxFeetY: 1.2, minVisible: 0.3 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 기본 자리. 이름을 모르는 캐릭터는 순서대로 고르게 벌려 세운다
export function defaultPlacement(id, orientation, index = 0, count = 1) {
  const d = DEFAULTS[orientation] ?? DEFAULTS.landscape;
  const cx = d.cx[id] ?? (index + 1) / (count + 1);
  return { cx, feetY: d.feetY, heightFrac: d.heightFrac, flip: false, locked: false, front: 'person' };
}

// 저장된 값이 깨져 있어도 쓸 수 있게 고친다
export function sanitizePlacement(p, fallback) {
  const num = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
  const src = p && typeof p === 'object' ? p : {};
  return {
    cx: num(src.cx, fallback.cx),
    feetY: clamp(num(src.feetY, fallback.feetY), LIMITS.minFeetY, LIMITS.maxFeetY),
    heightFrac: clamp(num(src.heightFrac, fallback.heightFrac), LIMITS.minHeight, LIMITS.maxHeight),
    flip: typeof src.flip === 'boolean' ? src.flip : fallback.flip,
    locked: typeof src.locked === 'boolean' ? src.locked : fallback.locked,
    front: src.front === 'character' ? 'character' : 'person',
  };
}

// 그림 사각(투명 여백 포함)의 보기 정규 상자와 발 지점. viewAspect = 보기 가로/세로
export function artBox(p, art, viewAspect) {
  const h = p.heightFrac / (art.feet.y - art.top);
  const w = (h * art.aspect) / viewAspect;
  const feetX = p.flip ? 1 - art.feet.x : art.feet.x;
  const x0 = p.cx - feetX * w;
  const y0 = p.feetY - art.feet.y * h;
  return { x0, y0, x1: x0 + w, y1: y0 + h, w, h, fx: p.cx, fy: p.feetY };
}

// 화면 밖으로 너무 나가지 않게: 가로로 최소 30%는 보이고, 크기와 높이는 범위 안
export function clampPlacement(p, art, viewAspect) {
  const q = { ...p };
  q.heightFrac = clamp(q.heightFrac, LIMITS.minHeight, LIMITS.maxHeight);
  q.feetY = clamp(q.feetY, LIMITS.minFeetY, LIMITS.maxFeetY);
  const b = artBox(q, art, viewAspect);
  const left = q.cx - b.x0; // 발 지점에서 그림 왼쪽 끝까지
  const minCx = LIMITS.minVisible * b.w - b.w + left;
  const maxCx = 1 - LIMITS.minVisible * b.w + left;
  q.cx = clamp(q.cx, minCx, maxCx);
  return q;
}

// 뒤에 선(발이 위쪽인) 캐릭터부터 그린다
export function drawOrder(items) {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.placement.feetY - b.it.placement.feetY || a.i - b.i)
    .map((e) => e.it);
}

// 보기 정규 점이 어떤 캐릭터 위인지. 맨 앞(나중에 그린) 캐릭터가 이긴다. items: [{id, box}] 그리는 순서
export function hitTest(items, x, y, pad = 0) {
  for (let i = items.length - 1; i >= 0; i--) {
    const b = items[i].box;
    if (x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return items[i].id;
  }
  return null;
}

export function moveBy(p, dx, dy) {
  return { ...p, cx: p.cx + dx, feetY: p.feetY + dy };
}

// 발 지점은 그대로 두고 키만 바꾼다
export function scaleBy(p, factor) {
  return { ...p, heightFrac: clamp(p.heightFrac * factor, LIMITS.minHeight, LIMITS.maxHeight) };
}

// 크기 손잡이(그림 오른쪽 위 모서리)를 끌 때: 발에서 손잡이까지 세로 거리 비율만큼 키를 바꾼다
export function scaleFromHandle(start, startHandleY, pointerY) {
  const d0 = start.feetY - startHandleY;
  const d1 = start.feetY - pointerY;
  if (d0 <= 1e-6) return start;
  return scaleBy(start, Math.max(d1, 1e-3) / d0);
}

// 가로로 보이는 비율(0..1)
export function visibleFraction(x0, x1) {
  const w = x1 - x0;
  if (w <= 0) return 0;
  return clamp((Math.min(1, x1) - Math.max(0, x0)) / w, 0, 1);
}

// 마스크(값 0..1, w×h)에서 사람 영역 상자와 덮은 비율. 정규 좌표(마스크 공간). 사람이 없으면 box는 null
// 잡티로 상자가 커지지 않게 한 줄(열)에 일정 개수 이상 켜진 줄만 센다
export function maskBox(mask, w, h, threshold = 0.5) {
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  let on = 0;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[o + x] >= threshold) {
        rows[y]++;
        cols[x]++;
        on++;
      }
    }
  }
  const coverage = on / (w * h);
  if (coverage < 0.004) return { box: null, coverage };
  const minRow = Math.max(2, Math.round(w * 0.006));
  const minCol = Math.max(2, Math.round(h * 0.006));
  let y0 = 0;
  while (y0 < h && rows[y0] < minRow) y0++;
  let y1 = h - 1;
  while (y1 > y0 && rows[y1] < minRow) y1--;
  let x0 = 0;
  while (x0 < w && cols[x0] < minCol) x0++;
  let x1 = w - 1;
  while (x1 > x0 && cols[x1] < minCol) x1--;
  if (y0 >= h || x0 >= w) return { box: null, coverage };
  return { box: { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h }, coverage };
}

// 최근 상자들의 변마다 중앙값. 분할 마스크는 프레임마다 발끝·손끝이 들쭉날쭉해서(가짜 카메라에서 발이 가끔 빠짐)
// 한 프레임 상자로 세우면 발 높이가 튄다. 절반 넘게 사람이 안 잡혔으면 null
export function medianBox(boxes) {
  const ok = boxes.filter(Boolean);
  if (!ok.length || ok.length * 2 < boxes.length) return null;
  const med = (k) => {
    const v = ok.map((b) => b[k]).sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  return { x0: med('x0'), y0: med('y0'), x1: med('x1'), y1: med('y1') };
}

// 옆에 세우기: 사람들(합친 상자) 옆에 캐릭터를 세운다.
// people: 보기 정규 상자 {x0,y0,x1,y1}. chars: [{id, placement, art}] (캐릭터.json 순서)
// 발이 보이면(y1 < 0.97) 발 높이와 키를 사람에 맞추고, 아니면 각자 지금 높이·키를 둔다.
// 하나면 빈 자리가 넓은 쪽, 둘 이상이면 첫째는 왼쪽·둘째는 오른쪽으로 번갈아 서되
// 반대로 섰을 때 더 많이 보이면 바꾼다. 화면에 60%도 안 남으면 사람 쪽으로 밀어 겹치게 둔다(가림이 처리).
export function autoPlace({ people, chars, heightRatio = 1, viewAspect, gap = 0.02, minVisible = 0.6 }) {
  const feetVisible = people.y1 < 0.97;
  const sized = chars.map((c) => {
    const p = { ...c.placement };
    if (feetVisible) {
      p.feetY = people.y1;
      p.heightFrac = clamp((people.y1 - people.y0) * heightRatio, 0.2, 1.3);
    }
    const b = artBox(p, c.art, viewAspect);
    return { id: c.id, p, w: b.w, left: p.cx - b.x0 };
  });

  // 한쪽에 줄 세우기. 사람에게서 가까운 순서대로 바깥으로
  const lineUp = (list, side) => {
    const out = [];
    let edge = side === 'right' ? people.x1 + gap : people.x0 - gap;
    for (const s of list) {
      let x0 = side === 'right' ? edge : edge - s.w;
      // 최소 minVisible만큼은 화면 안에 남긴다
      x0 = clamp(x0, -(1 - minVisible) * s.w, 1 - minVisible * s.w);
      out.push({ ...s, x0 });
      edge = side === 'right' ? x0 + s.w + gap : x0 - gap;
    }
    return out;
  };
  const arrange = (leftList, rightList) => [...lineUp(leftList, 'left'), ...lineUp(rightList, 'right')];
  const score = (placed) => placed.reduce((sum, s) => sum + visibleFraction(s.x0, s.x0 + s.w), 0);

  let placed;
  if (sized.length === 1) {
    const roomLeft = people.x0;
    const roomRight = 1 - people.x1;
    placed = roomRight >= roomLeft ? arrange([], sized) : arrange(sized, []);
  } else {
    const even = sized.filter((_, i) => i % 2 === 0);
    const odd = sized.filter((_, i) => i % 2 === 1);
    const a = arrange(even, odd);
    const b = arrange(odd, even);
    placed = score(b) > score(a) + 1e-6 ? b : a;
  }

  const result = {};
  for (const s of placed) result[s.id] = { ...s.p, cx: s.x0 + s.left };
  return result;
}

// 보이는 자르기가 바뀌었을 때(전체 화면을 풀거나 창 크기가 바뀌어 화면 비율이 달라짐) 배치를 장면에 붙여 둔 채 옮긴다.
// 배치는 보기 정규 좌표라 그대로 두면 바닥 표시에 맞춰 둔 발이 장면에서 떠 버린다.
// from·to는 영상 비율 자르기(cropNorm), mirror는 지금 보기의 거울 반전. 발 지점은 영상 위 같은 점, 키는 영상 위 같은 길이
export function remapPlacement(p, from, to, mirror) {
  const ux = mirror ? 1 - p.cx : p.cx;
  const vx = from.x + ux * from.w;
  const vy = from.y + p.feetY * from.h;
  const nu = (vx - to.x) / to.w;
  return { ...p, cx: mirror ? 1 - nu : nu, feetY: (vy - to.y) / to.h, heightFrac: (p.heightFrac * from.h) / to.h };
}

// 옆에 세우기 애니메이션용
export function lerpPlacement(a, b, t) {
  return {
    ...b,
    cx: a.cx + (b.cx - a.cx) * t,
    feetY: a.feetY + (b.feetY - a.feetY) * t,
    heightFrac: a.heightFrac + (b.heightFrac - a.heightFrac) * t,
  };
}

export function easeInOut(t) {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}
