// 결과 카드(공유용 PNG) 그리기. 1080x1350(4:5, 인스타 피드 비율).
// 지킬 것
// - 사파리 캔버스에는 ctx.filter가 없다. 흐림·흑백 같은 필터를 쓰지 않고 그라데이션·합성만 쓴다.
// - 한글 웹 글꼴은 글자 묶음별로 나눠 받는다. 그릴 글자를 넘겨 document.fonts.load로 먼저 받는다.
// - 캔버스는 한 장만(약 5.8MB 메모리). iOS 캔버스 한도 안이다.
export const CARD_W = 1080;
export const CARD_H = 1350;
const FONT = "'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
const NIGHT = '#070818';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('그림을 못 불러옴: ' + src));
    img.src = src;
  });
}

// 한국어 줄바꿈: 띄어쓰기 단위로 넘기고, 한 낱말이 폭보다 길면 글자 단위로 자른다
export function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
        continue;
      }
      line = '';
      for (const ch of word) {
        if (ctx.measureText(line + ch).width > maxWidth && line) {
          out.push(line);
          line = ch;
        } else line += ch;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function drawCard({ test, type, posterSrc }) {
  // 팀이 test.json에서 빼도 되는 칸은 빈칸으로 둔다(undefined가 그려지지 않게)
  const label = test.result?.label ?? '';
  const emotion = type.emotion ?? '';
  const desc = type.description ?? '';
  const footL = test.card?.footerLeft ?? '';
  const footR = test.card?.footerRight ?? '';
  const texts = [label, type.name, emotion, desc, footL, footR, '…'].join(' ');
  await Promise.all([
    document.fonts?.load(`700 96px ${FONT}`, texts),
    document.fonts?.load(`500 34px ${FONT}`, texts),
    document.fonts?.load(`400 26px ${FONT}`, texts),
  ]).catch(() => {}); // 글꼴을 못 받으면 시스템 글꼴로 그린다
  const poster = await loadImage(posterSrc);

  const c = document.createElement('canvas');
  c.width = CARD_W;
  c.height = CARD_H;
  const g = c.getContext('2d');
  g.fillStyle = NIGHT;
  g.fillRect(0, 0, CARD_W, CARD_H);

  // 위: 메인 포스터 윗부분(로고·도시·두 인물). 포스터 폭에 맞추고 아래쪽은 밤색으로 녹인다
  const artH = 900;
  const s = CARD_W / poster.naturalWidth;
  const srcY = 40 / s; // 포스터 위 여백을 조금 자른다
  g.drawImage(poster, 0, srcY, poster.naturalWidth, artH / s, 0, 0, CARD_W, artH);
  // 결과 색을 아래쪽(인물·디제잉 장비)에만 살짝 입힌다. 위(로고·도시)는 포스터 색 그대로 둔다
  // (전체를 칠하면 포스터에 없는 색, 예를 들어 앰버는 도시와 머리색이 갈색으로 바뀐다)
  g.save();
  g.globalCompositeOperation = 'soft-light';
  const tint = g.createLinearGradient(0, artH * 0.35, 0, artH);
  tint.addColorStop(0, type.color + '00');
  tint.addColorStop(1, type.color + 'b3');
  g.fillStyle = tint;
  g.fillRect(0, 0, CARD_W, artH);
  g.restore();
  const fadeTop = artH * 0.6;
  const fade = g.createLinearGradient(0, fadeTop, 0, artH);
  fade.addColorStop(0, 'rgba(7,8,24,0)');
  fade.addColorStop(0.7, 'rgba(7,8,24,0.9)');
  fade.addColorStop(1, NIGHT);
  g.fillStyle = fade;
  g.fillRect(0, fadeTop, CARD_W, artH - fadeTop + 1);

  // 결과 색 빛 번짐(캔버스 전체에 칠해야 가장자리에 띠가 안 생긴다)
  const glow = g.createRadialGradient(CARD_W / 2, 1000, 40, CARD_W / 2, 1000, 620);
  glow.addColorStop(0, type.color + '55');
  glow.addColorStop(1, type.color + '00');
  g.fillStyle = glow;
  g.fillRect(0, 0, CARD_W, CARD_H);

  const cx = CARD_W / 2;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  // 표제
  g.fillStyle = '#c4c8ea';
  g.font = `500 34px ${FONT}`;
  g.fillText(label, cx, 820);

  // 결과 이름(네온)
  g.font = `700 104px ${FONT}`;
  let size = 104;
  while (g.measureText(type.name).width > CARD_W - 140 && size > 60) {
    size -= 4;
    g.font = `700 ${size}px ${FONT}`;
  }
  g.save();
  g.shadowColor = type.color;
  for (const blur of [60, 28, 10]) {
    g.shadowBlur = blur;
    g.fillStyle = '#ffffff';
    g.fillText(type.name, cx, 945);
  }
  g.restore();

  // 감정 알약(없으면 건너뛰고 설명을 올린다)
  let descTop = 1108;
  if (emotion) {
    g.font = `600 32px ${FONT}`;
    const pillW = g.measureText(emotion).width + 64;
    roundRect(g, cx - pillW / 2, 985, pillW, 58, 29);
    g.lineWidth = 3;
    g.strokeStyle = type.color;
    g.stroke();
    g.fillStyle = type.color;
    g.fillText(emotion, cx, 1025);
  } else {
    descTop = 1040;
  }

  // 설명: 3줄 안에 들도록 글자를 조금씩 줄이고, 그래도 넘치면 마지막 줄 끝을 …로 줄인다
  const maxW = CARD_W - 160;
  const maxLines = emotion ? 3 : 4;
  let dsize = 34;
  let lines = [];
  for (dsize of [34, 31, 28]) {
    g.font = `400 ${dsize}px ${FONT}`;
    lines = wrapLines(g, desc, maxW);
    if (lines.length <= maxLines) break;
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  g.fillStyle = '#eef0ff';
  const lh = Math.round(dsize * 1.5);
  lines.forEach((ln, i) => g.fillText(ln, cx, descTop + i * lh));

  // 아래 글
  g.font = `500 24px ${FONT}`;
  g.fillStyle = '#8d92bb';
  g.textAlign = 'left';
  g.fillText(footL, 64, CARD_H - 52);
  g.textAlign = 'right';
  g.fillText(footR, CARD_W - 64, CARD_H - 52);

  // 네온 테두리
  g.save();
  roundRect(g, 22, 22, CARD_W - 44, CARD_H - 44, 34);
  g.strokeStyle = type.color;
  g.lineWidth = 4;
  g.shadowColor = type.color;
  g.shadowBlur = 24;
  g.stroke();
  g.restore();
  return c;
}

// 캔버스 → PNG Blob. toBlob이 null을 주면(메모리 부족) dataURL로 한 번 더
export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) return resolve(blob);
      try {
        const url = canvas.toDataURL('image/png');
        const bin = atob(url.slice(url.indexOf(',') + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (e) {
        reject(e);
      }
    }, 'image/png');
  });
}
