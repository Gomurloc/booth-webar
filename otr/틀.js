// 사진 틀 셋. 배치 계산(layoutFrame)은 순수 함수이고, 그리기(drawFrame)는 받은 ctx에만 그린다(전역 DOM 없음).
// - plain(그대로): 사진 전체 + 왼쪽 아래 작은 워드마크와 날짜
// - print(인화지): 흰 인화지(크림색 아님). 사진은 3:2(가로) 또는 2:3(세로)로 주인공들 가운데에 맞춰 자르고
//   옆·위 여백은 폭의 5%, 아래 여백은 폭의 18%. 아래 여백에 제목·부제·날짜.
//   주인공(머리~발)이 3:2·2:3 자르기보다 길면 발을 자르지 않고 사진 칸을 그만큼 좁게 넣는다(남는 폭은 종이 옆 여백).
//   발과 발밑 그림자가 사진 같다는 핵심 단서라서다
// - offrec(기록 밖): 회백색만 쓰는 회사 카메라 화면. 모서리 꺾쇠, 꺼진(속 빈) REC 점과 "기록 없음", 주사선
// 금색·청록 UI는 쓰지 않는다(캐릭터가 금 레코드를 들고 있어 청록과 한 화면에 두지 않는다).

export const FRAMES = [
  { id: 'plain', label: '그대로' },
  { id: 'print', label: '인화지' },
  { id: 'offrec', label: '기록 밖' },
];

export const FONT = {
  mono: '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  sans: '"IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
};

const PAPER = '#f6f6f3';
const INK = '#1b1d22';
const ASH_RGB = '201, 209, 220';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');

export function formatDate(d) {
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export function formatStamp(d) {
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function isFrame(id) {
  return FRAMES.some((f) => f.id === id);
}

// 틀 배치. srcW×srcH는 합성된 원본 사진, subject는 주인공(캐릭터+사람) 상자(원본 정규 좌표) 또는 null.
// 반환: { outW, outH, landscape, photo:{sx,sy,sw,sh,dx,dy,dw,dh}, caption? }
export function layoutFrame(id, srcW, srcH, subject = null) {
  const landscape = srcW >= srcH;
  if (id !== 'print') {
    return {
      id,
      outW: srcW,
      outH: srcH,
      landscape,
      photo: { sx: 0, sy: 0, sw: srcW, sh: srcH, dx: 0, dy: 0, dw: srcW, dh: srcH },
    };
  }
  const aspect = landscape ? 3 / 2 : 2 / 3;
  // 종이 안 사진 칸(cw×ch): 원본 안에 들어가는 가장 큰 3:2·2:3. 종이 크기와 캡션은 이것으로 정한다
  let cw = srcW;
  let ch = srcW / aspect;
  if (ch > srcH) {
    ch = srcH;
    cw = srcH * aspect;
  }
  cw = Math.floor(cw);
  ch = Math.floor(ch);
  const s = subject ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const subjH = (s.y1 - s.y0) * srcH;
  // 원본에서 잘라 올 사각(sw×sh). 보통은 사진 칸과 같다.
  // 주인공이 더 길면 머리 위·발 아래 4%씩까지 넣도록 키우고 사진 칸에 맞춰 줄여 넣는다. 그만큼 칸보다 좁아지는데,
  // 3:2·2:3의 0.825배(세로 0.55)보다 좁아지지는 않게 하고, 그래도 다 안 들어가면 머리 쪽을 살린다
  let sw = cw;
  let sh = ch;
  if (subject && subjH * 1.08 > ch) {
    sh = Math.min(srcH, subjH * 1.08);
    sw = Math.min(srcW, sh * aspect);
    const minAspect = aspect * 0.825;
    if (sw / sh < minAspect) sh = sw / minAspect;
    sw = Math.floor(sw);
    sh = Math.floor(sh);
  }
  const sx = clamp(((s.x0 + s.x1) / 2) * srcW - sw / 2, 0, srcW - sw);
  const wantY = subjH <= sh ? ((s.y0 + s.y1) / 2) * srcH - sh / 2 : s.y0 * srcH - sh * 0.04;
  const sy = clamp(wantY, 0, srcH - sh);
  const dh = ch;
  const dw = Math.min(cw, Math.round((sw * ch) / sh));
  const outW = Math.round(cw / 0.9);
  const side = Math.round((outW - cw) / 2);
  const bottom = Math.round(outW * 0.18);
  const outH = side + ch + bottom;
  return {
    id,
    outW,
    outH,
    landscape,
    photo: { sx: Math.round(sx), sy: Math.round(sy), sw, sh, dx: side + Math.round((cw - dw) / 2), dy: side, dw, dh },
    caption: { left: side, right: outW - side, top: side + ch, height: bottom },
  };
}

// 글자 사이 간격을 직접 넣어 쓴다(ctx.letterSpacing은 사파리 일부에서 없다). align: 'left' | 'right'
export function drawTracked(ctx, text, x, y, tracking, align = 'left') {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cx = align === 'right' ? x - total : x;
  const saved = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + tracking;
  });
  ctx.textAlign = saved;
  return total;
}

// 틀 그리기. ctx 캔버스는 layout.outW×outH로 맞춰 두고 부른다.
// opts: { title, subline, date(Date), noise(잡음 타일 캔버스, 인화지 결에 씀) }
export function drawFrame(ctx, layout, base, opts) {
  const { photo: p } = layout;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.textBaseline = 'alphabetic';
  if (layout.id === 'print') drawPrint(ctx, layout, base, opts);
  else {
    ctx.drawImage(base, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    if (layout.id === 'offrec') drawOffRecord(ctx, layout, opts);
    else drawPlain(ctx, layout, opts);
  }
  ctx.restore();
}

function drawPlain(ctx, layout, { title, date }) {
  const short = Math.min(layout.outW, layout.outH);
  const m = short * 0.03;
  const fs = short * 0.026;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = fs * 0.5;
  ctx.shadowOffsetY = fs * 0.06;
  ctx.font = `400 ${fs * 0.68}px ${FONT.mono}`;
  const dateY = layout.outH - m;
  drawTracked(ctx, formatDate(date), m, dateY, fs * 0.68 * 0.08);
  ctx.font = `500 ${fs}px ${FONT.mono}`;
  drawTracked(ctx, title, m, dateY - fs * 0.68 * 1.55, fs * 0.12);
}

function drawPrint(ctx, layout, base, { title, subline, date, noise }) {
  const { outW, outH, photo: p, caption: c } = layout;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, outW, outH);
  // 종이 결: 잡음 타일을 아주 옅게 오버레이
  if (noise) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = ctx.createPattern(noise, 'repeat');
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  }
  ctx.drawImage(base, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);

  const u = outW;
  const titleSize = u * 0.03;
  const baseY = c.top + c.height * 0.44;
  ctx.fillStyle = INK;
  ctx.font = `500 ${titleSize}px ${FONT.mono}`;
  drawTracked(ctx, title, c.left, baseY, titleSize * 0.12);
  ctx.font = `400 ${u * 0.021}px ${FONT.mono}`;
  drawTracked(ctx, formatDate(date), c.right, baseY, u * 0.021 * 0.06, 'right');
  if (subline) {
    ctx.globalAlpha = 0.72;
    ctx.font = `400 ${u * 0.019}px ${FONT.sans}`;
    ctx.fillText(subline, c.left, baseY + u * 0.036);
    ctx.globalAlpha = 1;
  }
}

function drawOffRecord(ctx, layout, { title, date }) {
  const { outW: W, outH: H } = layout;
  const short = Math.min(W, H);
  const k = short / 1080;
  // 가장자리를 어둡게: 밝은 벽 앞에서도 회백 글자·꺾쇠가 읽히게
  const vig = ctx.createRadialGradient(W / 2, H / 2, short * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
  vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vig.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
  // 주사선
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  const step = Math.max(2, Math.round(3 * k));
  const line = Math.max(1, Math.round(k));
  for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, line);

  const ash = (a) => `rgba(${ASH_RGB}, ${a})`;
  const m = short * 0.04;
  const L = short * 0.075;
  const lw = Math.max(2, short * 0.004);
  ctx.strokeStyle = ash(0.85);
  ctx.lineWidth = lw;
  ctx.lineCap = 'square';
  const corner = (x, y, dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
    ctx.stroke();
  };
  corner(m, m, 1, 1);
  corner(W - m, m, -1, 1);
  corner(m, H - m, 1, -1);
  corner(W - m, H - m, -1, -1);

  const fs = short * 0.03;
  const inX = m + L * 0.42;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = fs * 0.5;
  // ● REC: 점은 속이 빈 회색 고리(녹화 꺼짐). 빨간 점은 쓰지 않는다
  const topY = m + L * 0.42 + fs;
  const r = fs * 0.3;
  ctx.lineWidth = Math.max(1.5, fs * 0.09);
  ctx.strokeStyle = ash(0.8);
  ctx.beginPath();
  ctx.arc(inX + r, topY - fs * 0.36, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = ash(0.92);
  ctx.font = `500 ${fs}px ${FONT.mono}`;
  const recW = drawTracked(ctx, 'REC', inX + r * 2 + fs * 0.45, topY, fs * 0.12);
  ctx.fillStyle = ash(0.72);
  ctx.font = `500 ${fs * 0.86}px ${FONT.sans}`;
  ctx.fillText('기록 없음', inX + r * 2 + fs * 0.45 + recW + fs * 0.9, topY);

  const botY = H - m - L * 0.42;
  ctx.fillStyle = ash(0.92);
  ctx.font = `500 ${fs}px ${FONT.mono}`;
  drawTracked(ctx, title, inX, botY, fs * 0.12);
  ctx.font = `400 ${fs * 0.86}px ${FONT.mono}`;
  drawTracked(ctx, formatStamp(date), W - inX, botY, fs * 0.86 * 0.06, 'right');
}
