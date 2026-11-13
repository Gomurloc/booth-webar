// 화면 변환. 순수 모듈이라 DOM을 건드리지 않는다(노드 시험이 그대로 가져다 쓴다).
//
// 좌표계 셋
// - 영상 픽셀: 카메라 원본(거울 반전 전). 사람 마스크도 반전 전 공간에 있다.
// - 보기 정규 좌표: 사진 영역(= 화면에 보이는 자르기)의 0..1. 캐릭터 배치는 이 좌표로 저장해서
//   미리보기 캔버스와 원본 해상도 촬영 캔버스에 똑같이 들어맞는다.
// - 대상 픽셀: 보기 정규 좌표 × 그리는 캔버스 크기.
// 거울 반전은 이 파일의 변환 한 곳에서만 처리한다. 마스크·배치·그리기가 모두 여기를 거친다.

// 영상이 보기를 꽉 채우도록(cover) 가운데를 잘라 낸 사각. 영상 픽셀 단위
export function coverCrop(videoW, videoH, viewW, viewH) {
  const videoAspect = videoW / videoH;
  const viewAspect = viewW / viewH;
  if (videoAspect > viewAspect) {
    const w = videoH * viewAspect;
    return { x: (videoW - w) / 2, y: 0, w, h: videoH };
  }
  const h = videoW / viewAspect;
  return { x: 0, y: (videoH - h) / 2, w: videoW, h };
}

export function makeView({ videoW, videoH, viewW, viewH, mirror }) {
  return { videoW, videoH, viewW, viewH, mirror: !!mirror, crop: coverCrop(videoW, videoH, viewW, viewH) };
}

// 원본 해상도 촬영용 보기: 이미 잘라 낸(반전 전) 프레임 캔버스 전체가 사진 영역이다
export function stillView(w, h, mirror) {
  return { videoW: w, videoH: h, viewW: w, viewH: h, mirror: !!mirror, crop: { x: 0, y: 0, w, h } };
}

// 보이는 자르기를 영상 크기에 대한 비율로(해상도가 바뀌어도 같은 값). 배치를 장면에 붙여 두는 기준
export function cropNorm(view) {
  const c = view.crop;
  return { x: c.x / view.videoW, y: c.y / view.videoH, w: c.w / view.videoW, h: c.h / view.videoH };
}

export function sameCrop(a, b, eps = 1e-3) {
  return !!a && !!b && Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps;
}

export function videoToView(view, vx, vy) {
  const u = (vx - view.crop.x) / view.crop.w;
  return { x: view.mirror ? 1 - u : u, y: (vy - view.crop.y) / view.crop.h };
}

export function viewToVideo(view, x, y) {
  const u = view.mirror ? 1 - x : x;
  return { x: view.crop.x + u * view.crop.w, y: view.crop.y + y * view.crop.h };
}

// 영상 픽셀 상자 {x0,y0,x1,y1} → 보기 정규 상자. 반전되면 좌우 끝이 바뀐다
export function videoBoxToView(view, box) {
  const a = videoToView(view, box.x0, box.y0);
  const b = videoToView(view, box.x1, box.y1);
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

// 마스크는 보이는 자르기 사각만 덮는다(반전 전). 마스크 정규 상자 → 보기 정규 상자
export function maskBoxToView(view, box) {
  const c = view.crop;
  return videoBoxToView(view, {
    x0: c.x + box.x0 * c.w,
    y0: c.y + box.y0 * c.h,
    x1: c.x + box.x1 * c.w,
    y1: c.y + box.y1 * c.h,
  });
}

// 보기 정규 사각 rect{x,y,w,h}를 그리려면 원본의 어디를 읽어야 하나.
// 보기 밖은 잘라 내고 그만큼 대상 사각도 줄인다(원본 밖을 가리키는 drawImage는 사파리에서 안 그려진 적이 있다).
// 반환: 원본 픽셀 sx,sy,sw,sh + 실제로 채울 보기 정규 사각 dx,dy,dw,dh + flip(좌우로 뒤집어 그릴지). 겹침이 없으면 null
export function sourceRectFor(view, rect) {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(1, rect.x + rect.w);
  const y1 = Math.min(1, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const u0 = view.mirror ? 1 - x1 : x0;
  const c = view.crop;
  return {
    sx: c.x + u0 * c.w,
    sy: c.y + y0 * c.h,
    sw: (x1 - x0) * c.w,
    sh: (y1 - y0) * c.h,
    dx: x0,
    dy: y0,
    dw: x1 - x0,
    dh: y1 - y0,
    flip: view.mirror,
  };
}

// 촬영 캔버스 크기: 긴 변 4096, 넓이 16.7MP(iOS 캔버스 한계)를 넘지 않게 줄인다. 키우지는 않는다
export function captureSize(w, h, maxLong = 4096, maxArea = 16_777_216) {
  const s = Math.min(1, maxLong / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
}

// 캔버스 픽셀 크기 = CSS 크기 × 기기 배율(최대 2). 3배 폰에서 픽셀을 다 쓰면 그리기가 느려진다
export function canvasPixelSize(cssW, cssH, dpr) {
  const k = Math.min(Math.max(dpr || 1, 1), 2);
  return { w: Math.max(1, Math.round(cssW * k)), h: Math.max(1, Math.round(cssH * k)) };
}

export function orientationOf(w, h) {
  return w >= h ? 'landscape' : 'portrait';
}
