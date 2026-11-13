// 사진 앱 포스터 AR(otr/?ar=1) 확인: 헤드리스 크롬(폰 390x844, 3배, 터치) + 가짜 카메라(tools/make_ar_cams.py 꼴의 y4m + 정답 json).
// 가짜 카메라 영상 왼쪽 위의 프레임 번호 막대를 페이지 안에서 읽어, 앱이 투영한 캐릭터 바닥 자리와 정답(영상을 그릴 때 쓴 같은 세계)의
// 거리를 프레임마다 적는다.
//
// 자이로 흉내(실제 센서처럼): 센서는 "지금" 방향을 알리고, 카메라 프레임은 찍힌 시각(captureTime)을 달고 늦게 온다.
// 그래서 매 프레임 지금 보이는 영상 프레임 번호 k와 그 프레임이 찍힌 시각으로 지금 시각의 방향을 정답에서 보간해 보낸다.
// lead(프레임)를 주면 카메라가 그만큼 더 늦는 폰을 흉내 낸다(가짜 카메라의 captureTime에는 이 지연이 안 담긴다).
// noise(도, 축마다 정규 잡음)·drift(도/초, 방위가 흐름)·pauses(클립 초 구간, 이벤트를 안 보냄 = 크로미움이 가만히 있는 폰에 하는 것)
//
// 장면(--only 로 골라 돌린다)
// - main     3U_Main: 인식 → 걸어 나오기(중간·다 나옴) → 아래로 기울임·좌우로 돌림 뒤 → 사진
// - occl     3U_Main: 걸어 나온 뒤 사람 대역이 포스터 앞에 서서 가림(추적 놓침) + 폰을 조금씩 돌림 → 자이로로 버티는지, 사람 가림, 사진
// - nogyro   occl과 같은 영상, 자이로 없이: 놓치면 화면에 그대로 멈추는지
// - still    occl과 같은 영상, 크로미움처럼 0.1도 넘게 바뀔 때만 자이로 이벤트(가만히 있으면 끊김): 캐릭터가 튀지 않는지
// - rotate   occl과 같은 영상, 사람이 포스터 앞에 선 동안 인식기를 다시 만듦(세로↔가로 돌림과 같은 길, keep): 자리·걸어 나오기가 남는지
// - second   3U_Second: 포스터 가운데에서 걸어 나오기 → 사진
// - close    rv_backup(1.4m에서 잡고 3m까지 물러남): 포스터 안에서 기다리며 "두세 걸음 뒤로" → 물러나면 걸어 나오기 → 사진
// - strafe   rv_main: 옆으로 걸으며 돌림 + 3배 스크린샷 멈춤(놓침) → 다시 붙는 데 걸린 시간
// - lag      rv_main, 카메라가 2프레임(67ms) 늦는 폰: ?camlag=67로 보정한 것과 안 한 것
// - noise    rv_main, 자이로 잡음 0.15도·방위 흐름 0.2도/초: 가만히 있을 때 떨림
// - cover    rv_cover(3U_Second, 앞사람이 포스터 40%를 가린 채 시작) → 비키면 잡히는지, 자이로 없이 사진
// - near     3U_Main, 캐릭터를 카메라 0.3m 앞에 세움(서는 거리 2.3m): 흐려져 사라지고 그림 판이 커지지 않는지
// - ios      iOS 허락 흉내: 사용자 동작 없이는 거절 → '움직임 허용' 단추 → 누르면 허락·자이로 들어옴. 허브에서 받은 허락이면 단추 없음
// - scanhint 다른 포스터만 보이는 영상: 5초 넘게 못 찾으면 "포스터 전체가 보이게"
// - plain    원래 사진 앱(otr/): 반복 영상 캐릭터가 GPU 경로로 움직이는지 → 사진
// - hub      허브: 시작 → 포스터 카드 → 사진 찍으러 가기가 otr/?ar=1로 가는지, 직접 고르기는 otr/
// 쓰는 법: node tools/check_ar.mjs --pw <…/node_modules/playwright> [--cams <y4m 폴더;폴더2>] [--out <결과 폴더>] [--only main,occl]
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const CAMS = arg('--cams', process.env.HUB_CAMS || path.join(os.tmpdir(), 'hubcam')).split(';');
const OUT = arg('--out', path.join(ROOT, 'tools', 'out', 'ar'));
const PW_DIR = arg('--pw', process.env.PW_DIR);
const ONLY = arg('--only', null)?.split(',');
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ko-KR' };
const SETTINGS_KEY = 'otr-booth-photo.phone.v1';
if (!PW_DIR) {
  console.error('Playwright 폴더를 알려 주세요: --pw <…/node_modules/playwright>');
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(path.join(PW_DIR, 'index.mjs')).href);
await fs.mkdir(OUT, { recursive: true });
const server = await startServer(0);
const BASE = `http://localhost:${server.address().port}`;
const summary = { base: BASE, scenarios: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function camFile(cam, ext) {
  for (const d of CAMS) {
    const f = path.join(d, cam + ext);
    if (fss.existsSync(f)) return f;
  }
  throw new Error(`가짜 카메라 ${cam}${ext}가 ${CAMS.join(', ')}에 없음`);
}

async function launch(cam) {
  return chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camFile(cam, '.y4m')}`, '--autoplay-policy=no-user-gesture-required', ...GPU],
  });
}

// 페이지 안: 프레임 번호 막대 읽기 → 자이로 넣기 → 기록
function sampler({ truth, gyro, lead, noise, drift, pauses, gate, thresh }) {
  const T = truth;
  const log = [];
  window.__arlog = log;
  window.__arframe = -1;
  window.__gyroSent = 0;
  const c = document.createElement('canvas');
  c.width = T.bar.x + T.bar.bits * T.bar.w + 4;
  c.height = T.bar.y + T.bar.h + 4;
  const g = c.getContext('2d', { willReadFrequently: true });
  let frames = 0;
  let since = performance.now();
  let last = performance.now();
  window.__fps = 0;
  // 영상 프레임이 찍힌 시각(rVFC). 막대로 읽은 프레임 k와 짝짓는다
  let lastCap = null;
  let hooked = null;
  let kNow = -1;
  let capNow = null;
  let msPerFrame = 1000 / T.fps;
  const hook = (v) => {
    if (hooked === v || typeof v.requestVideoFrameCallback !== 'function') return;
    hooked = v;
    const cb = (now, m) => {
      lastCap = m?.captureTime ?? now;
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  const gauss = () => {
    let u = 0;
    let w = 0;
    while (!u) u = Math.random();
    while (!w) w = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
  };
  const lerpAngle = (a, b, t) => {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return a + d * t;
  };
  const orientAt = (f) => {
    const n = T.frames.length - 1;
    const x = Math.max(0, Math.min(n, f));
    const i = Math.min(n - 1, Math.floor(x));
    const t = x - i;
    const A = T.frames[i];
    const B = T.frames[i + 1] ?? A;
    return { alpha: lerpAngle(A.alpha, B.alpha, t), beta: A.beta + (B.beta - A.beta) * t, gamma: A.gamma + (B.gamma - A.gamma) * t };
  };
  const tick = () => {
    requestAnimationFrame(tick);
    frames++;
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (now - since >= 1000) {
      window.__fps = (frames * 1000) / (now - since);
      frames = 0;
      since = now;
    }
    const v = document.getElementById('카메라');
    if (!v || v.readyState < 2 || v.videoWidth !== T.w) return;
    hook(v);
    g.drawImage(v, 0, 0, c.width, c.height, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let k = 0;
    for (let b = 0; b < T.bar.bits; b++) {
      const x = Math.round(T.bar.x + b * T.bar.w + T.bar.w / 2);
      const y = Math.round(T.bar.y + T.bar.h / 2);
      if (d[(y * c.width + x) * 4 + 1] > 128) k |= 1 << b;
    }
    const fr = T.frames[k];
    if (!fr) return;
    if (k !== kNow) {
      const cap = lastCap ?? now;
      if (kNow >= 0 && capNow != null && k > kNow && k - kNow < 6) msPerFrame = msPerFrame * 0.8 + ((cap - capNow) / (k - kNow)) * 0.2;
      kNow = k;
      capNow = cap;
    }
    window.__arframe = k;
    // 지금 시각의 방향 = 프레임 k(찍힌 때 capNow)에서 지난 시간만큼 + 카메라가 더 늦는 만큼(lead)
    const f = k + lead + Math.min(1.5, Math.max(0, (now - capNow) / msPerFrame));
    let paused = pauses.some(([a, b]) => f / T.fps >= a && f / T.fps < b);
    const allowed = !gate || window[gate];
    if (gyro && !paused && allowed) {
      const o = orientAt(f);
      const dr = (drift || 0) * (now / 1000);
      const ev = {
        alpha: (o.alpha + dr + (noise || 0) * gauss() + 360) % 360,
        beta: o.beta + (noise || 0) * gauss(),
        gamma: o.gamma + (noise || 0) * gauss(),
      };
      // 크로미움 흉내: 마지막으로 보낸 값에서 세 각이 모두 thresh도 안 바뀌었으면 안 보낸다
      const ls = window.__lastSent;
      const da = ls ? Math.abs(((ev.alpha - ls.alpha + 540) % 360) - 180) : Infinity;
      if (thresh && ls && da < thresh && Math.abs(ev.beta - ls.beta) < thresh && Math.abs(ev.gamma - ls.gamma) < thresh) {
        paused = true;
        window.__gyroSkipped = (window.__gyroSkipped ?? 0) + 1;
      } else {
        window.__lastSent = ev;
        window.__gyroSent++;
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { ...ev, absolute: false }));
      }
    }
    const bo = window.__booth;
    if (!bo?.ready) return;
    const ar = bo.ar;
    log.push({ t: now, dt, k, s: ar.status, gyro: ar.gyro, chars: ar.chars, gt: fr.chars, fps: window.__fps, render: bo.perf.renderMs, q: ar.q ?? null, age: ar.anchorAge, wait: ar.waiting, hint: bo.hint, paused, items: ar.items?.length ?? 0, pa: ar.poseAge, tc: ar.trackCount, tm: ar.perf?.trackMainMs, tr: ar.perf?.tracks, lag: ar.camLag });
    if (log.length > 9000) log.shift();
  };
  requestAnimationFrame(tick);
}

// iOS 허락 흉내: 이미 허락(granted)이면 바로 granted, 아니면 사용자 동작(클릭) 안에서만 granted(허락 창에서 '허용'을 누른 것으로 친다),
// 동작 밖이면 NotAllowedError. 허락 전에는 sampler가 자이로를 안 보낸다(gate = '__iosPerm')
function iosStub(mode) {
  window.__iosPerm = mode === 'granted';
  window.__permCalls = [];
  DeviceOrientationEvent.requestPermission = () => {
    const active = !!navigator.userActivation?.isActive;
    window.__permCalls.push({ active, t: performance.now() });
    if (window.__iosPerm) return Promise.resolve('granted');
    if (active) {
      window.__iosPerm = true;
      return Promise.resolve('granted');
    }
    return Promise.reject(new DOMException('Requesting device orientation access requires a user gesture to prompt', 'NotAllowedError'));
  };
}

async function newPage(browser, rec, cam, { gyro = true, lead = 0, noise = 0, drift = 0, pauses = [], thresh = 0, world = null, reduced = false, ios = null } = {}) {
  const truth = cam ? JSON.parse(await fs.readFile(camFile(cam, '.json'), 'utf8')) : null;
  const context = await browser.newContext({ ...PHONE, acceptDownloads: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  if (ios) await context.addInitScript(iosStub, ios);
  if (world) {
    // 직원 설정창 값(이 폰만): 클립을 그린 카메라 화각 등
    await context.addInitScript(
      ({ key, w }) => {
        try {
          localStorage.setItem(key, JSON.stringify({ ar: { posterHeight: null, standOff: null, posterWidth: null, fov: null, chars: {}, ...w } }));
        } catch {}
      },
      { key: SETTINGS_KEY, w: world },
    );
  }
  if (truth) {
    const frames = truth.frames.map((f) => ({ alpha: f.alpha, beta: f.beta, gamma: f.gamma, chars: f.chars }));
    await context.addInitScript(sampler, { truth: { w: truth.w, h: truth.h, bar: truth.bar, fps: truth.fps, frames }, gyro, lead, noise, drift, pauses, thresh, gate: ios ? '__iosPerm' : null });
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') rec.errors.push(`console: ${m.text()}`);
    else if (t === 'warning') rec.warnings.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => rec.failedRequests.push(`${r.url().replace(BASE, '')} ${r.failure()?.errorText}`));
  return { context, page, truth };
}

// fast: 걸어 나오기처럼 빨리 지나가는 순간은 CSS 크기 JPEG로(3배 PNG는 찍는 데 0.5초 넘게 걸린다)
async function shot(page, rec, name, { fast = false } = {}) {
  rec.at = rec.at ?? {};
  rec.at[name] = await page.evaluate(() => {
    const b = window.__booth;
    const a = b?.ar;
    return {
      frame: window.__arframe,
      ar: a ? { status: a.status, anchorAge: a.anchorAge && Math.round(a.anchorAge), waiting: a.waiting, gyro: a.gyro, depthM: a.depthM && +a.depthM.toFixed(2), fit: a.fit, items: (a.items || []).map((i) => ({ id: i.id, cx: +i.placement.cx.toFixed(3), feetY: +i.placement.feetY.toFixed(3), h: +i.placement.heightFrac.toFixed(3), alpha: +(+i.fx.alpha).toFixed(2) })) } : null,
      hint: b?.hint ?? null,
      fps: Math.round(window.__fps),
    };
  });
  const file = path.join(OUT, name + (fast ? '.jpg' : '.png'));
  await page.screenshot(fast ? { path: file, type: 'jpeg', quality: 90, scale: 'css' } : { path: file });
  rec.shots.push(file);
}

const frameAt = (truth, sec) => Math.round(sec * truth.fps);
async function waitFrame(page, truth, sec, timeout = 40_000) {
  const k = frameAt(truth, sec);
  await page.waitForFunction((kk) => window.__arframe >= kk, k, { timeout, polling: 30 });
}

async function openAr(page, rec, extra = '', { waitLive = true } = {}) {
  const t0 = Date.now();
  await page.goto(BASE + '/otr/?ar=1' + extra);
  await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
  rec.readyMs = Date.now() - t0;
  await page.waitForFunction(() => ['scanning', 'live', 'hold', 'failed'].includes(window.__booth.ar.status), null, { timeout: 60_000 });
  rec.arReadyMs = Date.now() - t0;
  rec.arReadyFrame = await page.evaluate(() => window.__arframe);
  if (!waitLive) return;
  await page.waitForFunction(() => window.__booth.ar.status === 'live' || window.__booth.ar.status === 'failed', null, { timeout: 60_000 });
  rec.lockMs = Date.now() - t0;
  rec.lockFrame = await page.evaluate(() => window.__arframe);
  const st = await page.evaluate(() => window.__booth.ar);
  if (st.status === 'failed') throw new Error('AR 실패: ' + st.error);
  rec.lockIndex = st.index;
  rec.depthM = st.depthM;
}

async function waitAnchorAge(page, ms, timeout = 20_000) {
  await page.waitForFunction((m) => (window.__booth.ar.anchorAge ?? 0) >= m && !window.__booth.ar.waiting, ms, { timeout, polling: 16 });
}

// 사진: 카운트다운 없이 찍고 결과 JPEG를 저장
async function photo(page, rec, name) {
  await page.evaluate(() => window.__booth.shoot({ countdown: 0 }));
  await page.waitForFunction(() => window.__booth.state === 'result' && window.__booth.lastPhotoBlob(), null, { timeout: 30_000 });
  await sleep(300);
  const b64 = await page.evaluate(async () => {
    const blob = window.__booth.lastPhotoBlob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const file = path.join(OUT, name + '.jpg');
  await fs.writeFile(file, Buffer.from(b64, 'base64'));
  rec.photos = [...(rec.photos ?? []), file];
  await shot(page, rec, name + '-result');
  await page.locator('#다시찍기').click();
  await page.waitForFunction(() => window.__booth.state === 'live');
}

// 기록 → 바닥 자리 오차(영상 px). 상태(live/hold)별 중앙값·90%·최대
function errors(log, filt = () => true) {
  const by = {};
  for (const e of log) {
    if (!filt(e) || !e.chars) continue;
    for (const id of Object.keys(e.gt)) {
      const a = e.chars[id]?.feet;
      const b = e.gt[id]?.feet;
      if (!a || !b) continue;
      (by[e.s] ??= []).push(Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(by)) {
    v.sort((x, y) => x - y);
    out[k] = { n: v.length, median: +v[v.length >> 1].toFixed(1), p90: +v[Math.floor(v.length * 0.9)].toFixed(1), max: +v[v.length - 1].toFixed(1) };
  }
  return out;
}

// 프레임 사이 발 자리 떨림(영상 px): 같은 상태가 이어지는 동안 이웃 기록끼리
function jitter(log, filt = () => true) {
  const d = [];
  let prev = null;
  for (const e of log) {
    if (!filt(e) || !e.chars) {
      prev = null;
      continue;
    }
    if (prev && prev.s === e.s && e.k !== prev.k) {
      for (const id of Object.keys(e.chars)) {
        const a = e.chars[id]?.feet;
        const b = prev.chars[id]?.feet;
        const ga = e.gt[id]?.feet;
        const gb = prev.gt[id]?.feet;
        if (a && b && ga && gb) d.push(Math.hypot(a[0] - b[0] - (ga[0] - gb[0]), a[1] - b[1] - (ga[1] - gb[1])));
      }
    }
    prev = e;
  }
  if (!d.length) return null;
  d.sort((x, y) => x - y);
  return { n: d.length, median: +d[d.length >> 1].toFixed(1), p90: +d[Math.floor(d.length * 0.9)].toFixed(1), max: +d[d.length - 1].toFixed(1) };
}

async function perf(page) {
  return page.evaluate(() => ({ fps: window.__fps, ar: window.__booth.ar.perf, camLag: window.__booth.ar.camLag, q: window.__booth.ar.q, qGate: window.__booth.ar.qGate, app: window.__booth.perf, anim: window.__booth.anim, stats: window.__booth.stats.map((s) => ({ id: s.id, gpu: s.gpu })) }));
}

async function saveLog(page, rec) {
  const log = await page.evaluate(() => window.__arlog);
  await fs.writeFile(path.join(OUT, `${rec.name}-log.json`), JSON.stringify(log.map((e) => ({ t: Math.round(e.t), k: e.k, s: e.s, q: e.q, w: e.wait, h: e.hint, c: e.chars, gt: e.gt, pa: e.pa, tc: e.tc, tm: e.tm, tr: e.tr, lag: e.lag }))));
  return log;
}

// 상태가 바뀐 프레임들
function timeline(log) {
  const out = [];
  let last = null;
  for (const e of log) {
    const s = `${e.s}${e.wait ? '·기다림' : ''}${e.gyro ? '' : '(자이로 없음)'}`;
    if (s !== last) {
      out.push(`${e.k}:${s}`);
      last = s;
    }
  }
  return out;
}

// 1초마다 화면 fps와 합성 시간(ms)
function perfTimeline(log) {
  const out = [];
  let next = 0;
  for (const e of log) {
    if (e.t < next) continue;
    next = e.t + 1000;
    out.push(`${e.k}:${Math.round(e.fps)}fps/${(e.render ?? 0).toFixed(1)}ms`);
  }
  return out;
}

function hints(log) {
  const out = [];
  let last;
  for (const e of log) {
    if (e.hint !== last) {
      out.push(`${e.k}:${e.hint ?? '-'}`);
      last = e.hint;
    }
  }
  return out;
}

const range = (truth, a, b) => (e) => e.k >= frameAt(truth, a) && e.k < frameAt(truth, b);

const scenarios = {
  async main(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'ar_main');
    await openAr(page, rec);
    await waitAnchorAge(page, 250);
    await shot(page, rec, 'ar-main-1-stepout-early', { fast: true });
    await waitAnchorAge(page, 750);
    await shot(page, rec, 'ar-main-2-stepout-mid', { fast: true });
    await waitAnchorAge(page, 2300);
    await shot(page, rec, 'ar-main-3-landed');
    rec.perfLanded = await perf(page);
    await waitFrame(page, truth, 9.6);
    await shot(page, rec, 'ar-main-4-panned-right');
    await waitFrame(page, truth, 11.6);
    await shot(page, rec, 'ar-main-5-panned-left');
    rec.perfPan = await perf(page);
    await waitFrame(page, truth, 12.2);
    await photo(page, rec, 'ar-main-photo');
    const log = await saveLog(page, rec);
    rec.err = errors(log);
    rec.errAfterLock = errors(log, (e) => e.k >= rec.lockFrame + 30);
    rec.jitterLive = jitter(log, (e) => e.k >= rec.lockFrame + 30 && e.s === 'live');
    rec.statusTimeline = timeline(log);
    rec.hints = hints(log);
    rec.perfTimeline = perfTimeline(log);
    await context.close();
  },

  async occl(browser, rec, { gyro = true, tag = 'occl', pauses = [], thresh = 0 } = {}) {
    const { page, context, truth } = await newPage(browser, rec, 'ar_occl', { gyro, pauses, thresh });
    await openAr(page, rec);
    await waitAnchorAge(page, 2300);
    await shot(page, rec, `ar-${tag}-1-landed`);
    await waitFrame(page, truth, 7.0);
    await shot(page, rec, `ar-${tag}-2-walking-in`);
    await waitFrame(page, truth, 8.6);
    await shot(page, rec, `ar-${tag}-3-person-in-front`);
    await waitFrame(page, truth, 9.7);
    await shot(page, rec, `ar-${tag}-4-panned-away`);
    rec.perfOccl = await perf(page);
    await waitFrame(page, truth, 11.3);
    await photo(page, rec, `ar-${tag}-photo`); // 사람이 포스터 앞(캐릭터 사이)에 선 채
    await waitFrame(page, truth, 15.2);
    await shot(page, rec, `ar-${tag}-5-person-left-relocked`);
    const log = await saveLog(page, rec);
    rec.err = errors(log);
    rec.errStanding = errors(log, range(truth, 8.5, 12));
    rec.errPannedAway = errors(log, range(truth, 9.4, 10));
    rec.errAfterLeave = errors(log, (e) => e.k >= frameAt(truth, 14.2));
    if (pauses.length || thresh) {
      // 이벤트가 끊긴 동안의 오차와, 가장 길게 끊긴 시간(초)
      rec.errPaused = errors(log, (e) => e.paused);
      let run = null;
      let longest = 0;
      for (const e of log) {
        if (e.paused) run ??= e.t;
        else if (run != null) {
          longest = Math.max(longest, e.t - run);
          run = null;
        }
      }
      rec.longestGapSec = +(longest / 1000).toFixed(2);
      rec.gyro = await page.evaluate(() => ({ sent: window.__gyroSent, skipped: window.__gyroSkipped ?? 0, appEvents: window.__booth.ar.gyroEvents }));
    }
    rec.statusTimeline = timeline(log);
    rec.perfTimeline = perfTimeline(log);
    await context.close();
  },

  async nogyro(browser, rec) {
    return scenarios.occl(browser, rec, { gyro: false, tag: 'nogyro' });
  },

  // 크로미움 흉내: 마지막으로 보낸 값에서 0.1도 넘게 바뀔 때만 이벤트를 보낸다(가만히 받친 폰은 이벤트가 끊긴다)
  async still(browser, rec) {
    return scenarios.occl(browser, rec, { tag: 'still', thresh: 0.1 });
  },

  // 사람이 포스터 앞에 선 동안 인식기를 새로 만든다(폰을 세로↔가로로 돌렸을 때와 같은 길: 영상 크기만 바뀜 → keep)
  async rotate(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'ar_occl');
    await openAr(page, rec);
    await waitAnchorAge(page, 2300);
    await waitFrame(page, truth, 8.8);
    rec.before = await page.evaluate(() => ({ status: window.__booth.ar.status, items: window.__booth.ar.items.length, anchorAge: window.__booth.ar.anchorAge }));
    rec.restart = await page.evaluate(async () => {
      const ar = window.__booth.arObject();
      ar.ctrls.clear(); // 처음 보는 크기처럼 새로 만들게
      const t0 = performance.now();
      await ar.restart({ keep: true });
      const ms = performance.now() - t0;
      const t1 = performance.now();
      await ar.restart({ keep: true }); // 두 번째는 붙잡아 둔 인식기를 다시 쓴다
      return { firstMs: Math.round(ms), secondMs: Math.round(performance.now() - t1), ctrls: ar.ctrls.size, rebuilds: ar.perf.rebuilds };
    });
    rec.after = await page.evaluate(() => ({ status: window.__booth.ar.status, items: window.__booth.ar.items.length, anchorAge: window.__booth.ar.anchorAge, waiting: window.__booth.ar.waiting }));
    await shot(page, rec, 'ar-rotate-1-after-rebuild');
    await waitFrame(page, truth, 15.2);
    await shot(page, rec, 'ar-rotate-2-relocked');
    const log = await saveLog(page, rec);
    rec.errAfterRebuild = errors(log, range(truth, 9.0, 12));
    rec.errAfterLeave = errors(log, (e) => e.k >= frameAt(truth, 14.2));
    rec.statusTimeline = timeline(log);
    if (rec.after.items !== rec.before.items || rec.after.anchorAge < rec.before.anchorAge) throw new Error('다시 만든 뒤 캐릭터·걸어 나오기가 남지 않음');
    await context.close();
  },

  async second(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'ar_second');
    await openAr(page, rec);
    await waitAnchorAge(page, 700);
    await shot(page, rec, 'ar-second-1-stepout-mid', { fast: true });
    await waitAnchorAge(page, 2300);
    await shot(page, rec, 'ar-second-2-landed');
    await waitFrame(page, truth, 8.6);
    await shot(page, rec, 'ar-second-3-panned');
    await photo(page, rec, 'ar-second-photo');
    const log = await saveLog(page, rec);
    rec.err = errors(log);
    rec.statusTimeline = timeline(log);
    rec.perfTimeline = perfTimeline(log);
    await context.close();
  },

  // 가까이(1.4m)에서 잡음 → 포스터 안에서 기다리며 "두세 걸음 뒤로" → 3m까지 물러나면 걸어 나오기 → 사람이 서서 사진
  async close(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'rv_backup', { world: { fov: 65 } });
    await openAr(page, rec);
    await sleep(900);
    await shot(page, rec, 'ar-close-1-waiting-in-poster', { fast: true });
    rec.waitingAt1s = await page.evaluate(() => ({ waiting: window.__booth.ar.waiting, hint: window.__booth.hint, fit: window.__booth.ar.fit }));
    await page.waitForFunction(() => !window.__booth.ar.waiting, null, { timeout: 30_000 });
    rec.releaseFrame = await page.evaluate(() => window.__arframe);
    rec.releaseSec = +(rec.releaseFrame / truth.fps).toFixed(2);
    rec.releaseDepthM = await page.evaluate(() => window.__booth.ar.depthM);
    await waitAnchorAge(page, 900);
    await shot(page, rec, 'ar-close-2-stepping-out', { fast: true });
    await waitAnchorAge(page, 2000);
    await shot(page, rec, 'ar-close-3-landed');
    await waitFrame(page, truth, 12.8);
    await shot(page, rec, 'ar-close-4-visitor');
    await waitFrame(page, truth, 13.6);
    await photo(page, rec, 'ar-close-photo');
    const log = await saveLog(page, rec);
    rec.errLanded = errors(log, (e) => e.k >= rec.releaseFrame + 40);
    rec.statusTimeline = timeline(log);
    rec.hints = hints(log);
    if (!rec.waitingAt1s.waiting) throw new Error('가까이서 잡았는데 기다리지 않고 걸어 나옴');
    await context.close();
  },

  // 옆으로 걸으며 돌림 + 3배 스크린샷 멈춤(검토에서 7.4초에 놓친 뒤 끝까지 못 붙음)
  async strafe(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'rv_main', { world: { fov: 67 } });
    await openAr(page, rec);
    await waitAnchorAge(page, 2200);
    await shot(page, rec, 'ar-strafe-1-landed');
    await waitFrame(page, truth, 6.8);
    await shot(page, rec, 'ar-strafe-2-tilted');
    await waitFrame(page, truth, 9.0);
    await shot(page, rec, 'ar-strafe-3-strafed');
    await waitFrame(page, truth, 9.8);
    await shot(page, rec, 'ar-strafe-4-panned-away');
    await waitFrame(page, truth, 10.9);
    await shot(page, rec, 'ar-strafe-5-back');
    await waitFrame(page, truth, 12.6);
    await shot(page, rec, 'ar-strafe-6-closer');
    await photo(page, rec, 'ar-strafe-photo');
    const log = await saveLog(page, rec);
    rec.err = errors(log, (e) => e.k >= rec.lockFrame + 45);
    rec.errStrafe = errors(log, range(truth, 6.6, 9.1));
    rec.errFastPan = errors(log, range(truth, 9.15, 10.8));
    rec.errCloser = errors(log, range(truth, 10.8, 12.4));
    rec.statusTimeline = timeline(log);
    // 놓친(hold) 구간 길이(초)
    const holds = [];
    let start = null;
    for (const e of log) {
      if (e.s === 'hold' && start == null) start = e;
      if (e.s !== 'hold' && start) {
        holds.push(+((e.t - start.t) / 1000).toFixed(2));
        start = null;
      }
    }
    if (start) holds.push(`${((log[log.length - 1].t - start.t) / 1000).toFixed(2)}(끝까지)`);
    rec.holdSecs = holds;
    rec.perfEnd = await perf(page);
    await context.close();
  },

  // 카메라가 2프레임(67ms) 늦는 폰: 보정(?camlag=67)한 것과 안 한 것
  async lag(browser, rec) {
    const out = {};
    for (const [tag, extra] of [['보정', '&camlag=67'], ['보정 없음', '']]) {
      const r = { errors: [], warnings: [], failedRequests: [], shots: [] };
      const { page, context, truth } = await newPage(browser, r, 'rv_main', { world: { fov: 67 }, lead: 2 });
      await openAr(page, r, extra);
      await waitFrame(page, truth, 12.4);
      const log = await page.evaluate(() => window.__arlog);
      out[tag] = { lockFrame: r.lockFrame, errStill: errors(log, range(truth, 5.0, 6.4)), errFastPan: errors(log, range(truth, 9.15, 10.8)), errAll: errors(log, (e) => e.k >= r.lockFrame + 45), camLag: await page.evaluate(() => window.__booth.ar.camLag) };
      rec.errors.push(...r.errors);
      await context.close();
    }
    rec.result = out;
  },

  // 자이로 잡음 0.15도(축마다)·방위 흐름 0.2도/초: 가만히 있을 때(5.0~6.4초) 떨림과 오차
  async noise(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'rv_main', { world: { fov: 67 }, noise: 0.15, drift: 0.2 });
    await openAr(page, rec);
    await waitFrame(page, truth, 12.4);
    const log = await saveLog(page, rec);
    rec.errStill = errors(log, range(truth, 5.0, 6.4));
    rec.jitterStill = jitter(log, range(truth, 5.0, 6.4));
    rec.errAll = errors(log, (e) => e.k >= rec.lockFrame + 45);
    rec.statusTimeline = timeline(log);
    await context.close();
  },

  // 앞사람이 포스터 오른쪽 40%를 가린 채 시작(3.5초에 비킴), 자이로 없이
  async cover(browser, rec) {
    const { page, context, truth } = await newPage(browser, rec, 'rv_cover', { world: { fov: 60 }, gyro: false });
    await page.goto(BASE + '/otr/?ar=1');
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    await waitFrame(page, truth, 2.5).catch(() => {});
    await shot(page, rec, 'ar-cover-0-covered-scanning', { fast: true });
    await page.waitForFunction(() => window.__booth.ar.status === 'live', null, { timeout: 60_000 });
    rec.lockSec = +((await page.evaluate(() => window.__arframe)) / truth.fps).toFixed(2);
    await waitAnchorAge(page, 2200);
    await shot(page, rec, 'ar-cover-1-landed');
    await waitFrame(page, truth, 10.4);
    await photo(page, rec, 'ar-cover-photo');
    const log = await saveLog(page, rec);
    rec.err = errors(log, (e) => e.k >= frameAt(truth, rec.lockSec) + 36);
    rec.jitterLive = jitter(log, (e) => e.s === 'live' && e.k >= frameAt(truth, rec.lockSec) + 36);
    rec.statusTimeline = timeline(log);
    rec.hints = hints(log);
    await context.close();
  },

  // 캐릭터를 카메라 바로 앞에 세운다(서는 거리 1.9m·2.3m, 카메라는 벽에서 약 2.6m): 흐려져 사라지고 그림 판이 커지지 않는지.
  // 움직임 줄이기로 연다(기다림 없이 바로 바닥 자리에 나타난다)
  async near(browser, rec) {
    const out = {};
    for (const so of [1.9, 2.3]) {
      const r = { errors: [], warnings: [], failedRequests: [], shots: [] };
      const { page, context } = await newPage(browser, r, 'ar_main', { world: { standOff: so }, reduced: true });
      await openAr(page, r);
      await sleep(2500);
      const tag = `ar-near-${so}`;
      await shot(page, r, tag);
      out[so] = { at: r.at[tag], gl: (await page.evaluate(() => window.__booth.anim.gl)) };
      rec.shots.push(...r.shots);
      rec.errors.push(...r.errors);
      await context.close();
    }
    rec.result = out;
  },

  async ios(browser, rec) {
    // 허락이 없음: 사용자 동작 없이 부르면 거절 → '움직임 허용' 단추 → 누르면 허락, 자이로 들어옴
    {
      const { page, context } = await newPage(browser, rec, 'ar_main', { ios: 'prompt' });
      await openAr(page, rec);
      await sleep(800);
      rec.prompt = await page.evaluate(() => ({ chip: !document.getElementById('움직임허용').hidden, gyro: window.__booth.ar.gyro, orient: window.__booth.ar.orient, calls: window.__permCalls }));
      await shot(page, rec, 'ar-ios-1-chip');
      await page.locator('#움직임허용').click();
      await page.waitForFunction(() => window.__booth.ar.gyro === true, null, { timeout: 5000 });
      await sleep(300);
      rec.afterChip = await page.evaluate(() => ({ chip: !document.getElementById('움직임허용').hidden, gyro: window.__booth.ar.gyro, orient: window.__booth.ar.orient, calls: window.__permCalls }));
      await shot(page, rec, 'ar-ios-2-granted');
      await context.close();
      if (!rec.prompt.chip || rec.afterChip.chip || !rec.afterChip.gyro) throw new Error('움직임 허용 단추 흐름이 다름');
    }
    // 셔터 탭은 허락을 묻지 않는다(카운트다운 중에 창이 뜨지 않게). 셔터가 아닌 탭(다시 찍기)은 묻는다
    {
      const { page, context } = await newPage(browser, rec, 'ar_main', { ios: 'prompt' });
      await openAr(page, rec);
      await sleep(500);
      const n0 = await page.evaluate(() => window.__permCalls.length);
      await page.locator('#셔터').tap();
      await page.waitForFunction(() => window.__booth.state === 'result', null, { timeout: 20_000 });
      rec.shutterCalls = (await page.evaluate(() => window.__permCalls.length)) - n0;
      await page.locator('#다시찍기').tap();
      await page.waitForFunction(() => window.__booth.state === 'live');
      await sleep(300);
      rec.againTap = await page.evaluate(() => ({ calls: window.__permCalls.filter((c) => c.active).length, orient: window.__booth.ar.orient }));
      await context.close();
      if (rec.shutterCalls !== 0) throw new Error('셔터 탭에서 허락을 물음');
      if (rec.againTap.orient !== 'granted') throw new Error('셔터가 아닌 탭에서 허락을 받지 못함');
    }
    // 허브에서 이미 받은 허락: 단추 없이 자이로
    {
      const { page, context } = await newPage(browser, rec, 'ar_main', { ios: 'granted' });
      await openAr(page, rec);
      await sleep(800);
      rec.granted = await page.evaluate(() => ({ chip: !document.getElementById('움직임허용').hidden, gyro: window.__booth.ar.gyro, orient: window.__booth.ar.orient, calls: window.__permCalls.length }));
      await context.close();
      if (rec.granted.chip || !rec.granted.gyro) throw new Error('이미 허락했는데 단추가 보이거나 자이로가 없음');
    }
  },

  // 다른 포스터만 보이는 영상: 5초 넘게 못 찾으면 안내가 바뀐다
  async scanhint(browser, rec) {
    const { page, context } = await newPage(browser, rec, null);
    await openAr(page, rec, '', { waitLive: false });
    await sleep(1500);
    rec.early = await page.evaluate(() => window.__booth.hint);
    await sleep(5000);
    rec.later = await page.evaluate(() => window.__booth.hint);
    await shot(page, rec, 'ar-scanhint');
    await context.close();
    if (rec.later !== '포스터 전체가 보이게 비춰 주세요') throw new Error('안내가 바뀌지 않음: ' + rec.later);
  },

  // 원래 사진 앱(otr/, 포스터 AR 없음)에서도 캐릭터가 반복 영상으로 움직이는지, 사진에 그때 프레임이 들어가는지
  async plain(browser, rec) {
    const { page, context } = await newPage(browser, rec, 'ar_main', { gyro: false });
    await page.goto(BASE + '/otr/');
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    await page.waitForFunction(() => window.__booth.anim.sprites.every((s) => s.ready), null, { timeout: 30_000 });
    const f0 = await page.evaluate(() => window.__booth.anim.sprites.map((s) => s.frame));
    await sleep(1500);
    rec.anim = await page.evaluate(() => window.__booth.anim);
    rec.framesAdvanced = rec.anim.sprites.map((s, i) => s.frame - f0[i]);
    rec.gpu = await page.evaluate(() => window.__booth.stats.map((s) => ({ id: s.id, gpu: s.gpu })));
    rec.ar = await page.evaluate(() => document.body.dataset.ar);
    await shot(page, rec, 'plain-1-live');
    await sleep(700);
    await shot(page, rec, 'plain-2-live-later');
    await photo(page, rec, 'plain-photo');
    await context.close();
  },

  async hub(browser, rec) {
    const { page, context } = await newPage(browser, rec, 'ar_main');
    await page.goto(BASE + '/');
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__hub?.card?.game === 'otr', null, { timeout: 60_000 });
    await shot(page, rec, 'ar-hub-1-card');
    await page.locator('#card-open').click();
    await page.waitForURL(/\/otr\/\?ar=1$/, { timeout: 10_000 });
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    rec.url = page.url().replace(BASE, '');
    await page.waitForFunction(() => window.__booth.ar.status !== 'loading', null, { timeout: 60_000 });
    rec.arStatus = await page.evaluate(() => window.__booth.ar.status);
    await shot(page, rec, 'ar-hub-2-photo-app');
    // 직접 고르기는 원래 사진 앱
    await page.goto(BASE + '/');
    await page.locator('.game-row[data-game="otr"]').click();
    await page.waitForURL(/\/otr\/$/, { timeout: 10_000 });
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    rec.manual = { url: page.url().replace(BASE, ''), ar: await page.evaluate(() => document.body.dataset.ar) };
    await context.close();
  },
};

const CAM_FOR = {
  main: 'ar_main',
  occl: 'ar_occl',
  nogyro: 'ar_occl',
  still: 'ar_occl',
  rotate: 'ar_occl',
  second: 'ar_second',
  close: 'rv_backup',
  strafe: 'rv_main',
  lag: 'rv_main',
  noise: 'rv_main',
  cover: 'rv_cover',
  near: 'ar_main',
  ios: 'ar_main',
  scanhint: 'dont',
  plain: 'ar_main',
  hub: 'ar_main',
};
let failed = 0;
for (const n of Object.keys(scenarios).filter((x) => !ONLY || ONLY.includes(x))) {
  const rec = { name: n, ok: false, errors: [], warnings: [], failedRequests: [], shots: [] };
  summary.scenarios[n] = rec;
  const t0 = Date.now();
  let browser = null;
  try {
    browser = await launch(CAM_FOR[n]);
    await scenarios[n](browser, rec);
    rec.ok = true;
  } catch (e) {
    rec.exception = String(e?.message ?? e).split('\n').slice(0, 4).join(' | ');
    failed++;
  }
  rec.sec = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`${rec.ok ? '통과' : '실패'}  ${n}  ${rec.sec}s  오류 ${rec.errors.length}${rec.exception ? '  ' + rec.exception : ''}`);
  await browser?.close();
  await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
}
server.close();
console.log(JSON.stringify(summary, null, 1));
process.exit(failed ? 1 : 0);
