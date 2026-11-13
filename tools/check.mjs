// 헤드리스 크롬 + 가짜 카메라로 허브 전체를 한 바퀴 돌려 본다(폰 화면 390x844, 3배, 터치).
// 장면마다 tools/out/에 화면을 찍고, 끝에 요약(JSON)을 찍는다. 콘솔 오류가 있으면 장면 결과에 적는다.
//
// 장면(--only 로 골라 돌린다: 예 --only dont,unmute)
// - landing     첫 화면, 가로 넘침 없음
// - nojs        스크립트가 꺼져도 첫 화면에 세 게임 링크가 있는지
// - inapp       카카오톡 안 브라우저(UA)면 바깥 브라우저로 여는 안내가 뜨는지
// - otr         포스터 인식 → 카드 → 사진 앱으로(허브가 카메라를 놓았는지, 사진 앱이 카메라를 켰는지) → "다른 게임"으로 허브
// - dont        포스터 인식 → 카드 → 포스터 위 영상(재생 중) → 포스터를 놓침(가운데 보기) → 끝 → 다른 게임
// - all6        ?targets=all6 로 사용금지 포스터 인식
// - unmute      포스터 인식 → 카드 → 테스트 끝까지 → 결과 카드 PNG 저장(내려받기), 공유 시트 경로도
// - unmute-edit 팀이 test.json을 고친 경우(감정 빠짐, 설명이 긺) 결과 카드, 그리고 네 결과 카드 모두
// - manual      카메라 없이 직접 고르기: 사용금지(화면 가운데 보기), OFF THE RECORD, UNMUTE
// - wall        포스터 없는 벽: 8초 뒤 "아래에서 고르세요"
// - wall3       세 장이 나란히 걸린 벽: 앞에서 잡은 포스터가 가장자리에 남아도 가운데 포스터 카드로 바뀌는지
// - race        인식 준비 중에 사용금지를 직접 고름(준비가 끝나도 영상이 그대로인지), 준비 중에 닫음
// - back        폰의 뒤로 가기: 카메라 화면·영상은 닫히고 허브를 떠나지 않는지, 사진 앱에서 뒤로 가면 허브 첫 화면
// - slow        느린 회선(1.5Mbps, 지연 150ms)에서 첫 화면 → 사용금지 직접 열기: 불러오는 중 표시, 멈춤 횟수, 끝날 때까지
// - slow-card   느린 회선에서 카메라 → 카드 → 사용금지 열기
// - cam-errors  카메라 오류 이름(거절·장치 없음·사용 중)마다 안내 종류
// - denied      가짜 권한 창 없이 시작(헤드리스는 NotSupportedError) → 카메라를 쓸 수 없다는 안내
// - layout      360x780 화면(단추 글자 끊김, UNMUTE 저장 단추, 사진 앱 링크), 노치 흉내(안전 영역 47/34px), 가로 화면 사용금지
// - narrow      좁은 폰(320x568) + 움직임 줄이기: 가로 넘침, 사진 앱 윗줄 겹침
// - cycle       인식 켜기·끄기 3번: 카메라·캔버스·style이 쌓이지 않는지
// - fail-load   인식 도구 파일을 막음 → 첫 화면 안내 + 단추
// - fail-gl     WebGL 셰이더 연결 실패를 흉내(iOS 27 보고와 같은 종류) → 안내 + 단추
//
// 쓰는 법: node tools/check.mjs [--only a,b] [--cams <y4m 폴더>] [--pw <playwright 폴더>]
//   --pw(또는 환경 변수 PW_DIR): Playwright 패키지 폴더(…/node_modules/playwright). 저장소에는 설치하지 않는다.
//   --cams(또는 HUB_CAMS): 가짜 카메라 영상 폴더. 기본은 임시 폴더의 hubcam. tools/make_cams.py로 먼저 만든다(경로는 ASCII만: 크롬 제약).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'out');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const CAMS = arg('--cams', process.env.HUB_CAMS || path.join(os.tmpdir(), 'hubcam'));
const PW_DIR = arg('--pw', process.env.PW_DIR);
const ONLY = arg('--only', null)?.split(',');
const GPU = ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ko-KR' };
const DONT_PERIOD = 16; // dont.y4m 길이(초)
const SLOW = { offline: false, latency: 150, downloadThroughput: (1.5e6 / 8) | 0, uploadThroughput: (1e6 / 8) | 0 };

if (!PW_DIR) {
  console.error('Playwright 폴더를 알려 주세요: --pw <…/node_modules/playwright> 또는 환경 변수 PW_DIR');
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(path.join(PW_DIR, 'index.mjs')).href);
await fs.mkdir(OUT, { recursive: true });
const server = await startServer(0);
const BASE = `http://localhost:${server.address().port}`;
const summary = { base: BASE, scenarios: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(cam, { fakeUi = true } = {}) {
  return chromium.launch({
    headless: true,
    args: [
      ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : []),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${path.join(CAMS, cam + '.y4m')}`,
      '--autoplay-policy=user-gesture-required',
      ...GPU,
    ],
  });
}

async function newPage(browser, rec, init, opts = {}) {
  const context = await browser.newContext({ ...PHONE, acceptDownloads: true, ...opts });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') rec.errors.push(`console: ${m.text()}`);
    else if (t === 'warning') rec.warnings.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => rec.failedRequests.push(`${r.url().replace(BASE, '')} ${r.failure()?.errorText}`));
  return { context, page };
}

async function shot(page, rec, name) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  rec.shots.push(path.relative(ROOT, file));
}

const hub = (page, expr, a) => page.evaluate(expr, a);

async function waitState(page, states, timeout = 60_000) {
  const list = [].concat(states);
  await page.waitForFunction((l) => l.includes(window.__hub?.state), list, { timeout });
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// 허브에서 시작 단추 → 인식 루프가 돌 때까지
async function startScan(page, rec, extra = '') {
  await page.goto(BASE + '/' + extra);
  await page.locator('#start').click();
  const t0 = Date.now();
  await waitState(page, ['scanning', 'card'], 120_000);
  rec.readyMs = Date.now() - t0;
}

async function waitCard(page, game, timeout = 60_000) {
  const t0 = Date.now();
  await page.waitForFunction((g) => window.__hub?.card?.game === g, game, { timeout });
  return Date.now() - t0;
}

const evts = (page) => hub(page, () => window.__hub.events.filter((e) => e.type !== 'found' && e.type !== 'lost').map((e) => `${e.t} ${e.type} ${e.game ?? e.kind ?? e.index ?? e.depth ?? ''}`));

// 사용금지 영상의 기다림·재생 시각을 적어 둔다(느린 회선 확인용)
async function watchVideo(page) {
  await page.evaluate(() => {
    const v = document.getElementById('dont-video');
    window.__vw = { waiting: [], playing: [], ended: null, t0: performance.now() };
    v.addEventListener('waiting', () => window.__vw.waiting.push([Math.round(performance.now() - window.__vw.t0), Number(v.currentTime.toFixed(2))]));
    v.addEventListener('playing', () => window.__vw.playing.push([Math.round(performance.now() - window.__vw.t0), Number(v.currentTime.toFixed(2))]));
    v.addEventListener('ended', () => (window.__vw.ended = Math.round(performance.now() - window.__vw.t0)));
  });
}

async function throttle(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', SLOW);
  return cdp;
}

// 안전 영역(노치) 흉내: CSS 변수를 덮어쓴다(헤드리스 크롬은 env(safe-area-inset-*)가 0)
const SAFE = () => {
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = ':root { --safe-t: 47px !important; --safe-b: 34px !important; }';
    document.head.append(s);
  });
};

async function playUnmute(page, picks) {
  await page.locator('#start').click();
  for (let i = 0; i < picks.length; i++) {
    await page.waitForFunction((n) => document.getElementById('q-count')?.textContent.startsWith(n + ' /'), i + 1);
    await page.locator('.answer').nth(picks[i]).click();
  }
  await page.waitForFunction(() => window.__unmute.screen === 'result' && window.__unmute.cardReady, null, { timeout: 20_000 });
}

const scenarios = {
  async landing(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await shot(page, rec, 'landing');
    rec.noHScroll = await noHorizontalScroll(page);
    rec.rows = await page.locator('.game-row').count();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shot(page, rec, 'landing-bottom');
    await context.close();
  },

  async nojs(browser, rec) {
    const { page, context } = await newPage(browser, rec, null, { javaScriptEnabled: false });
    await page.goto(BASE + '/');
    rec.links = await page.locator('#game-list a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    if (rec.links.length !== 3) throw new Error('링크가 셋이 아님');
    await shot(page, rec, 'nojs-landing');
    await context.close();
  },

  async inapp(browser, rec) {
    const ua = 'Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 KAKAOTALK 10.8.0';
    const { page, context } = await newPage(browser, rec, null, { userAgent: ua });
    await page.goto(BASE + '/');
    rec.visible = await page.locator('#inapp').isVisible();
    rec.href = await page.locator('#inapp-open').getAttribute('href');
    if (!rec.visible || !rec.href?.startsWith('kakaotalk://web/openExternal?url=')) throw new Error('안내가 없음');
    await shot(page, rec, 'inapp-kakao');
    await context.close();
  },

  async otr(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await startScan(page, rec);
    await shot(page, rec, 'otr-1-scanning');
    rec.cardMs = await waitCard(page, 'otr');
    await sleep(400);
    await shot(page, rec, 'otr-2-card');
    rec.hubTracksBefore = await hub(page, () => window.__hub.cameraTracks());
    await page.locator('#card-open').click();
    // 클릭 직후(이동 전 250ms 사이) 허브 카메라가 꺼졌는지
    rec.hubTracksAfterClick = await hub(page, () => window.__hub.cameraTracks()).catch(() => 'navigated');
    await page.waitForURL(/\/otr\/$/, { timeout: 10_000 });
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    await sleep(2500);
    rec.otrCamera = await page.evaluate(() => {
      const v = document.getElementById('카메라');
      return { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, live: v.srcObject?.getVideoTracks?.()[0]?.readyState };
    });
    rec.otrState = await page.evaluate(() => document.body.dataset.state);
    rec.otrLinkVisible = await page.locator('#허브로').isVisible();
    await shot(page, rec, 'otr-3-photo-app');
    await page.locator('#허브로').click();
    await page.waitForURL(BASE + '/', { timeout: 10_000 });
    await page.waitForFunction(() => window.__hub?.state === 'landing');
    await shot(page, rec, 'otr-4-back-to-hub');
    await context.close();
  },

  async dont(browser, rec, extra = '') {
    const { page, context } = await newPage(browser, rec);
    await startScan(page, rec, extra);
    rec.cardMs = await waitCard(page, 'dont');
    await sleep(300);
    await shot(page, rec, 'dont-1-card' + (extra ? '-all6' : ''));
    if (extra) {
      // all6: 열면 포스터 위로 가고, 겹칠 수 있는 메인 포스터라 엉뚱한 안내가 없어야 한다
      await page.locator('#card-open').click();
      await page.waitForFunction(() => window.__hub.dont().open && window.__hub.dont().time > 0.5, null, { timeout: 20_000 });
      rec.afterOpen = await hub(page, () => window.__hub.dont());
      await context.close();
      return;
    }
    // 가짜 카메라 영상의 앞부분(포스터가 보이는 0.3~1.8초)에서 연다 → 영상이 도는 사이 5초부터 포스터를 놓친다
    const camTime = () =>
      page.evaluate((P) => {
        const v = document.querySelector('#ar-view video');
        return { t: v ? v.currentTime % P : -1, vis: window.__hub.events.filter((e) => e.type === 'found' || e.type === 'lost').slice(-1)[0]?.type === 'found' };
      }, DONT_PERIOD);
    const deadline = Date.now() + DONT_PERIOD * 4 * 1000;
    for (;;) {
      const c = await camTime();
      if (c.vis && c.t > 0.3 && c.t < 1.8) break;
      if (Date.now() > deadline) throw new Error('포스터가 보이는 순간을 못 잡음');
      await sleep(80);
    }
    await page.locator('#card-open').click();
    rec.openAt = await camTime();
    await page.waitForFunction(
      () => {
        const d = window.__hub.dont();
        return d.mode === 'ar' && d.opacity > 0.98 && d.time > 1.2;
      },
      null,
      { timeout: 15_000 },
    );
    rec.afterOpen = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'dont-2-overlay-playing');
    // 영상 앞부분은 포스터와 똑같아 겹친 자리가 안 보인다. 고개를 돌린 장면(5.8초)으로 잠깐 넘겨 겹친 자리를 찍고 되돌린다
    await page.evaluate(() => (document.getElementById('dont-video').currentTime = 5.8));
    await page.waitForFunction(() => window.__hub.dont().time > 5.9 && window.__hub.dont().mode === 'ar' && !window.__hub.dont().loading, null, { timeout: 8000 });
    await sleep(250);
    rec.alignShot = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'dont-2b-overlay-turned');
    await page.evaluate(() => (document.getElementById('dont-video').currentTime = 2));
    await page.waitForFunction(() => window.__hub.dont().mode === 'pinned', null, { timeout: 15_000 });
    await sleep(700);
    rec.afterLoss = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'dont-3-after-tracking-loss');
    await page.waitForSelector('#dont-end:not([hidden])', { timeout: 20_000 });
    await sleep(500);
    rec.atEnd = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'dont-4-end');
    await page.locator('#dont-other').click();
    await waitState(page, ['scanning', 'card']);
    rec.afterOther = await hub(page, () => window.__hub.state);
    rec.events = await evts(page);
    await shot(page, rec, 'dont-5-back-to-scan');
    await context.close();
  },

  async all6(browser, rec) {
    return scenarios.dont(browser, rec, '?targets=all6');
  },

  async unmute(browser, rec) {
    // 내려받기 경로를 보려고 공유 API를 없앤다(데스크톱 크롬은 공유 시트가 있어 멈출 수 있다)
    const { page, context } = await newPage(browser, rec, () => {
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    });
    await startScan(page, rec);
    rec.cardMs = await waitCard(page, 'unmute');
    await sleep(300);
    await shot(page, rec, 'unmute-1-card');
    await page.locator('#card-open').click();
    rec.hubTracksAfterClick = await hub(page, () => window.__hub.cameraTracks()).catch(() => 'navigated');
    await page.waitForURL(/\/unmute\/$/, { timeout: 10_000 });
    await page.waitForFunction(() => window.__unmute?.screen === 'intro', null, { timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(500);
    await shot(page, rec, 'unmute-2-intro');
    rec.draftBadgeVisible = await page.locator('#draft').isVisible();
    rec.noHScrollIntro = await noHorizontalScroll(page);
    await page.locator('#start').click();
    // 답: 1번 질문은 첫 답, 그 뒤로는 보라(violet) 쪽을 많이 고른다
    const picks = [0, 2, 0, 1, 1, 3];
    for (let i = 0; i < picks.length; i++) {
      await page.waitForFunction((n) => document.getElementById('q-count')?.textContent.startsWith(n + ' /'), i + 1);
      if (i === 2) {
        await sleep(400);
        rec.q3 = await page.locator('#q-text').textContent();
        await shot(page, rec, 'unmute-3-question3');
      }
      await page.locator('.answer').nth(picks[i]).click();
    }
    await page.waitForFunction(() => window.__unmute.screen === 'result' && window.__unmute.cardReady, null, { timeout: 20_000 });
    await sleep(1600); // 색이 돌아오는 전환
    rec.result = await page.evaluate(() => window.__unmute.result);
    rec.noHScrollResult = await noHorizontalScroll(page);
    rec.saveBottom = await page.evaluate(() => Math.round(document.getElementById('save').getBoundingClientRect().bottom));
    await shot(page, rec, 'unmute-4-result');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.locator('#save').click()]);
    const png = path.join(OUT, 'unmute-card-' + download.suggestedFilename());
    await download.saveAs(png);
    rec.savedCard = path.relative(ROOT, png);
    rec.savedBytes = (await fs.stat(png)).size;
    rec.toast = await page.locator('#toast').textContent();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(300);
    await shot(page, rec, 'unmute-5-result-bottom');
    await context.close();

    // 공유 시트 경로: share를 가로채 넘어온 파일만 적는다
    const s = await newPage(browser, rec, () => {
      window.__shared = null;
      Object.defineProperty(navigator, 'canShare', { value: (d) => !!d?.files?.length, configurable: true });
      Object.defineProperty(navigator, 'share', {
        value: (d) => {
          const f = d.files[0];
          window.__shared = { name: f.name, type: f.type, size: f.size, n: d.files.length, active: navigator.userActivation?.isActive };
          return Promise.resolve();
        },
        configurable: true,
      });
    });
    await s.page.goto(BASE + '/unmute/?draft=1');
    await s.page.waitForFunction(() => window.__unmute?.screen === 'intro');
    rec.draftBadgeWithParam = await s.page.locator('#draft').isVisible();
    await playUnmute(s.page, [0, 0, 0, 0, 0, 0]);
    await s.page.locator('#save').click();
    rec.share = await s.page.evaluate(() => window.__shared);
    rec.shareResult = await s.page.evaluate(() => window.__unmute.result);
    await s.context.close();
  },

  // 팀이 test.json을 고쳤을 때(감정을 지우고 설명을 길게) 카드, 그리고 네 결과 카드를 모두 그려 본다
  async 'unmute-edit'(browser, rec) {
    const { page, context } = await newPage(browser, rec, () => {
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    });
    const orig = JSON.parse(await fs.readFile(path.join(ROOT, 'unmute', 'test.json'), 'utf8'));
    await page.route('**/unmute/test.json', async (route) => {
      const t = structuredClone(orig);
      const m = t.types.find((x) => x.id === 'magenta');
      delete m.emotion;
      m.description = '음악이 시작되면 몸이 먼저 반응하는 사람. 멈춰 있던 거리에 다시 뛰는 박동을 돌려줘요. 비트가 떨어지는 순간 누구보다 먼저 손을 들고, 꺼져 있던 스피커를 하나씩 다시 켜요. 그리고 마지막 한 줄까지 길게 이어지는 설명.';
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(t) });
    });
    await page.goto(BASE + '/unmute/');
    await page.waitForFunction(() => window.__unmute?.screen === 'intro');
    await playUnmute(page, [0, 1, 2, 3, 0, 2]); // 마젠타
    rec.result = await page.evaluate(() => window.__unmute.result);
    rec.emotionHidden = await page.locator('#r-emotion').isHidden();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.locator('#save').click()]);
    await download.saveAs(path.join(OUT, 'unmute-edit-card.png'));
    rec.shots.push('tools/out/unmute-edit-card.png');
    await page.unroute('**/unmute/test.json');
    // 원래 test.json으로 네 결과 카드
    const cards = await page.evaluate(async () => {
      const { drawCard, canvasToPng } = await import('./card.js');
      const test = await (await fetch('test.json', { cache: 'no-cache' })).json();
      const out = {};
      for (const type of test.types) {
        const c = await drawCard({ test, type, posterSrc: 'art/poster.jpg' });
        const b = await canvasToPng(c);
        out[type.id] = await new Promise((r) => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(b);
        });
      }
      return out;
    });
    for (const [id, url] of Object.entries(cards)) {
      const f = path.join(OUT, `card-${id}.png`);
      await fs.writeFile(f, Buffer.from(url.split(',')[1], 'base64'));
      rec.shots.push(path.relative(ROOT, f));
    }
    await context.close();
  },

  async manual(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await page.goto(BASE + '/');
    await page.locator('.game-row[data-game="dont"]').click();
    await page.waitForFunction(
      () => {
        const d = window.__hub.dont();
        return d.open && d.mode === 'screen' && d.time > 2;
      },
      null,
      { timeout: 15_000 },
    );
    rec.dontScreen = await hub(page, () => window.__hub.dont());
    rec.depthWhileOpen = await hub(page, () => window.__hub.depth);
    await shot(page, rec, 'manual-1-dont-screen');
    await page.waitForSelector('#dont-end:not([hidden])', { timeout: 20_000 });
    await sleep(500);
    await shot(page, rec, 'manual-2-dont-end');
    // 다시 보기 → 닫기
    await page.locator('#dont-replay').click();
    await page.waitForFunction(() => window.__hub.dont().time > 0.5 && !window.__hub.dont().paused);
    rec.replayOk = true;
    await page.locator('#dont-close').click();
    await waitState(page, 'landing');
    await sleep(200);
    rec.depthAfterClose = await hub(page, () => window.__hub.depth);
    await page.locator('.game-row[data-game="otr"]').click();
    await page.waitForURL(/\/otr\/$/);
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    rec.otrOk = true;
    await page.goto(BASE + '/');
    await page.locator('.game-row[data-game="unmute"]').click();
    await page.waitForURL(/\/unmute\/$/);
    await page.waitForFunction(() => window.__unmute?.screen === 'intro');
    rec.unmuteOk = true;
    await context.close();
  },

  async wall(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await startScan(page, rec);
    await sleep(1000);
    await shot(page, rec, 'wall-1-scanning');
    await page.waitForFunction(() => document.body.dataset.hint === 'on', null, { timeout: 15_000 });
    rec.found = await hub(page, () => window.__hub.events.filter((e) => e.type === 'found').length);
    await shot(page, rec, 'wall-2-hint');
    // 아래 단추로 바로 사용금지 → 포스터가 없으니 가운데 보기
    await page.locator('.chip[data-game="dont"]').click();
    await page.waitForFunction(() => window.__hub.dont().mode === 'pinned' && window.__hub.dont().time > 1);
    rec.chipDont = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'wall-3-chip-dont-pinned');
    await page.locator('#dont-close').click();
    await waitState(page, ['scanning', 'card']);
    await page.locator('#scan-back').click();
    await waitState(page, 'landing');
    rec.tracksAfterBack = await hub(page, () => window.__hub.cameraTracks());
    await context.close();
  },

  async wall3(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await startScan(page, rec);
    rec.unmuteCardMs = await waitCard(page, 'unmute', 40_000);
    await sleep(200);
    await shot(page, rec, 'wall3-1-unmute-card');
    const t0 = Date.now();
    await page.waitForFunction(() => window.__hub?.card?.game === 'dont', null, { timeout: 30_000 });
    rec.dontCardAfterMs = Date.now() - t0;
    await sleep(300);
    await shot(page, rec, 'wall3-2-dont-card');
    rec.events = await evts(page);
    rec.releases = await hub(page, () => window.__hub.events.filter((e) => e.type === 'release').map((e) => e.index));
    await context.close();
  },

  async race(browser, rec) {
    // .mind 받기를 6초 늦춰 인식 준비를 길게 만든다
    const delayMind = async (page) =>
      page.route('**/targets/*.mind', async (route) => {
        await sleep(6000);
        await route.continue();
      });
    {
      const { page, context } = await newPage(browser, rec);
      await delayMind(page);
      await page.goto(BASE + '/');
      const t0 = Date.now();
      await page.locator('#start').click();
      await page.waitForFunction(() => window.__hub.cameraTracks() > 0, null, { timeout: 10_000 });
      rec.cameraLiveMs = Date.now() - t0; // 카메라가 받기보다 먼저 켜지는지
      rec.stateAtCamera = await hub(page, () => window.__hub.state);
      await sleep(400);
      await shot(page, rec, 'race-1-starting-camera');
      await page.locator('.chip[data-game="dont"]').click();
      rec.atOpen = await hub(page, () => ({ state: window.__hub.state, mode: window.__hub.dont().mode }));
      await page.waitForFunction(() => window.__hub.events.some((e) => e.type === 'ready'), null, { timeout: 60_000 });
      await sleep(300);
      rec.afterReady = await hub(page, () => ({ state: window.__hub.state, mode: window.__hub.dont().mode, depth: window.__hub.depth }));
      if (rec.afterReady.state !== 'dont') throw new Error('준비가 끝나자 상태가 바뀜: ' + rec.afterReady.state);
      // 포스터가 다시 보이면 포스터 위로 올라가야 한다(가짜 카메라 0~5초에 포스터, 16초마다). 영상이 먼저 끝나면 다시 보기
      const until = Date.now() + 40_000;
      for (;;) {
        const d = await hub(page, () => window.__hub.dont());
        if (d.mode === 'ar' && d.opacity > 0.9) break;
        if (Date.now() > until) throw new Error('포스터 위로 올라가지 않음');
        if (await page.locator('#dont-replay').isVisible()) await page.locator('#dont-replay').click();
        await sleep(200);
      }
      rec.wentAr = await hub(page, () => window.__hub.dont());
      await shot(page, rec, 'race-2-chip-dont-then-ready');
      await page.locator('#dont-close').click();
      await sleep(300);
      rec.afterClose = await hub(page, () => ({ state: window.__hub.state, depth: window.__hub.depth }));
      rec.events1 = await evts(page);
      await context.close();
    }
    {
      // 준비 중에 열었다 바로 닫음 → 카메라 화면(starting)에서 기다렸다가 scanning
      const { page, context } = await newPage(browser, rec);
      await delayMind(page);
      await page.goto(BASE + '/');
      await page.locator('#start').click();
      await page.waitForFunction(() => window.__hub.cameraTracks() > 0, null, { timeout: 10_000 });
      await page.locator('.chip[data-game="dont"]').click();
      await sleep(800);
      await page.locator('#dont-close').click();
      rec.closedBeforeReady = await hub(page, () => window.__hub.state);
      await waitState(page, ['scanning', 'card'], 60_000);
      await sleep(500);
      rec.arSize = await hub(page, () => window.__hub.arSize());
      rec.stateAfter = await hub(page, () => window.__hub.state);
      await shot(page, rec, 'race-3-closed-before-ready');
      if (!rec.arSize.canvas || rec.arSize.canvas[0] < 300) throw new Error('카메라 화면 크기가 0');
      await context.close();
    }
  },

  async back(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    // ① 카메라 화면에서 뒤로 → 허브 첫 화면(허브를 떠나지 않음)
    await page.goto(BASE + '/');
    await startScan(page, rec);
    rec.depthScan = await hub(page, () => window.__hub.depth);
    await page.goBack();
    await waitState(page, 'landing', 10_000);
    rec.step1 = { url: page.url(), state: await hub(page, () => window.__hub.state), tracks: await hub(page, () => window.__hub.cameraTracks()) };
    // ② 첫 화면에서 사용금지 → 뒤로 → 첫 화면
    await page.locator('.game-row[data-game="dont"]').click();
    await page.waitForFunction(() => window.__hub.dont().open);
    await page.goBack();
    await waitState(page, 'landing', 10_000);
    rec.step2 = { url: page.url(), dontOpen: await hub(page, () => window.__hub.dont().open) };
    // ③ 카메라 → 아래 단추 사용금지 → 뒤로(영상만 닫힘) → 뒤로(첫 화면)
    await page.locator('#start').click();
    await waitState(page, ['scanning', 'card'], 60_000);
    await page.locator('.chip[data-game="dont"]').click();
    await page.waitForFunction(() => window.__hub.dont().open);
    rec.depthScanDont = await hub(page, () => window.__hub.depth);
    await page.goBack();
    await waitState(page, ['scanning', 'card'], 10_000);
    rec.step3a = { state: await hub(page, () => window.__hub.state), dontOpen: await hub(page, () => window.__hub.dont().open) };
    await page.goBack();
    await waitState(page, 'landing', 10_000);
    rec.step3b = { url: page.url(), state: await hub(page, () => window.__hub.state) };
    // ④ 카메라 → 카드 → 사진 앱 → 뒤로 → 허브 첫 화면
    await page.locator('#start').click();
    await waitCard(page, 'otr');
    await page.locator('#card-open').click();
    await page.waitForURL(/\/otr\/$/, { timeout: 10_000 });
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    await page.goBack();
    await page.waitForURL(BASE + '/', { timeout: 10_000 });
    await page.waitForFunction(() => window.__hub?.state === 'landing');
    rec.step4 = { url: page.url(), state: await hub(page, () => window.__hub.state), depth: await hub(page, () => window.__hub.depth), historyLength: await page.evaluate(() => history.length) };
    await shot(page, rec, 'back-4-from-otr');
    await context.close();
  },

  async slow(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await throttle(context, page);
    await page.goto(BASE + '/');
    await page.waitForSelector('.game-row[data-game="dont"]');
    await sleep(1800); // 첫 화면 미리 받기가 시작된 뒤
    await watchVideo(page);
    const t0 = Date.now();
    await page.locator('.game-row[data-game="dont"]').click();
    await sleep(1500);
    rec.at1500 = await hub(page, () => window.__hub.dont());
    rec.loadText = await page.locator('#dont-load-text').textContent();
    await shot(page, rec, 'slow-1-loading');
    await page.waitForSelector('#dont-end:not([hidden])', { timeout: 120_000 });
    rec.toEndMs = Date.now() - t0;
    rec.video = await page.evaluate(() => window.__vw);
    rec.holds = await hub(page, () => window.__hub.dont().holds);
    rec.warmCancelled = await hub(page, () => window.__hub.events.some((e) => e.type === 'warm-cancel'));
    await sleep(500);
    await shot(page, rec, 'slow-2-end');
    await context.close();
  },

  async 'slow-card'(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await throttle(context, page);
    await startScan(page, rec);
    rec.cardMs = await waitCard(page, 'dont', 60_000);
    await watchVideo(page);
    const t0 = Date.now();
    await page.locator('#card-open').click();
    await sleep(1200);
    rec.at1200 = await hub(page, () => window.__hub.dont());
    await shot(page, rec, 'slow-card-1-loading');
    await page.waitForSelector('#dont-end:not([hidden])', { timeout: 120_000 });
    rec.toEndMs = Date.now() - t0;
    rec.video = await page.evaluate(() => window.__vw);
    rec.holds = await hub(page, () => window.__hub.dont().holds);
    await context.close();
  },

  async 'cam-errors'(browser, rec) {
    rec.kinds = {};
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
      const { page, context } = await newPage(browser, rec);
      await context.addInitScript(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('흉내', '${name}'));`);
      await page.goto(BASE + '/');
      await page.locator('#start').click();
      await page.waitForFunction(() => window.__hub.fail, null, { timeout: 15_000 });
      rec.kinds[name] = { kind: await hub(page, () => window.__hub.fail), notice: await page.locator('#notice').textContent() };
      if (name === 'NotAllowedError') await shot(page, rec, 'cam-error-denied');
      await context.close();
    }
    if (rec.kinds.NotAllowedError.kind !== 'denied' || rec.kinds.NotFoundError.kind !== 'nocamera' || rec.kinds.NotReadableError.kind !== 'camera') throw new Error('안내 종류가 틀림');
  },

  // 가짜 권한 창 없이 띄운 헤드리스 크롬: getUserMedia가 NotSupportedError로 끝난다 → "카메라를 쓸 수 없어요" 안내.
  // (헤드리스는 권한 창이 없어서 진짜 "허용 안 함"은 흉내 낼 수 없다. 거절은 cam-errors에서 NotAllowedError로 본다)
  async denied(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await page.goto(BASE + '/');
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__hub.fail, null, { timeout: 30_000 });
    rec.fail = await hub(page, () => window.__hub.fail);
    rec.events = await evts(page);
    rec.notice = await page.locator('#notice').textContent();
    rec.cause = await hub(page, () => window.__hub.events.find((e) => e.type === 'fail')?.cause);
    await shot(page, rec, 'denied-noui');
    if (rec.fail !== 'nocamera') throw new Error('안내 종류가 틀림: ' + rec.fail);
    await context.close();
  },

  async layout(browser, rec) {
    // 360x780(갤럭시 S 계열)
    {
      const { page, context } = await newPage(browser, rec, null, { viewport: { width: 360, height: 780 } });
      await page.goto(BASE + '/');
      await page.evaluate(() => document.fonts.ready);
      await shot(page, rec, 'p360-1-landing');
      rec.p360 = { noHScroll: await noHorizontalScroll(page) };
      await page.locator('#start').click();
      await waitState(page, ['scanning', 'card'], 60_000);
      await page.evaluate(() => (document.body.dataset.hint = 'on'));
      await sleep(300);
      rec.p360.chipLines = await page.locator('.chip span').evaluateAll((ss) => ss.map((s) => `${s.textContent}:${s.getClientRects().length}/${Math.round(s.getBoundingClientRect().height)}`));
      await shot(page, rec, 'p360-2-scan-chips');
      await page.locator('#scan-back').click();
      await page.goto(BASE + '/unmute/');
      await page.waitForFunction(() => window.__unmute?.screen === 'intro');
      await playUnmute(page, [0, 1, 2, 3, 0, 2]);
      await sleep(1500);
      rec.p360.saveBottom = await page.evaluate(() => Math.round(document.getElementById('save').getBoundingClientRect().bottom));
      await shot(page, rec, 'p360-3-unmute-result');
      await page.goto(BASE + '/otr/');
      await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
      rec.p360.otrHeader = await page.evaluate(() => {
        const a = document.getElementById('워드마크').getBoundingClientRect();
        const b = document.getElementById('허브로');
        const r = b.getBoundingClientRect();
        const t = b.querySelector('.허브링크-글');
        return { wordmarkRight: Math.round(a.right), linkLeft: Math.round(r.left), overlap: a.right > r.left, textVisible: t.getClientRects().length > 0, scrollW: b.scrollWidth, w: Math.round(r.width) };
      });
      await shot(page, rec, 'p360-4-otr');
      await context.close();
    }
    // 노치 흉내 390x844 + 안전 영역 47/34
    {
      const { page, context } = await newPage(browser, rec, SAFE);
      await page.goto(BASE + '/');
      await page.locator('#start').click();
      await waitState(page, ['scanning', 'card'], 60_000);
      await page.evaluate(() => (document.body.dataset.hint = 'on'));
      await sleep(400);
      const geo = () =>
        page.evaluate(() => {
          const r = (id) => document.querySelector(id).getBoundingClientRect();
          return { backBottom: Math.round(r('#scan-back').bottom), guideBottom: Math.round(r('#scan-guide').bottom), frameTop: Math.round(r('.frame').top), frameBottom: Math.round(r('.frame').bottom), sheetTop: Math.round(r('#sheet').top) };
        });
      rec.notch = { scanning: await geo() };
      await shot(page, rec, 'notch-1-scanning-hint');
      await page.goto(BASE + '/unmute/');
      await page.waitForFunction(() => window.__unmute?.screen === 'intro');
      await playUnmute(page, [0, 2, 0, 1, 1, 3]);
      await sleep(1500);
      rec.notch.saveBottom = await page.evaluate(() => Math.round(document.getElementById('save').getBoundingClientRect().bottom));
      await shot(page, rec, 'notch-2-unmute-result');
      await context.close();
    }
    // 가로 화면 844x390: 사용금지 화면 보기
    {
      const { page, context } = await newPage(browser, rec, null, { viewport: { width: 844, height: 390 } });
      await page.goto(BASE + '/');
      await page.locator('.game-row[data-game="dont"]').click();
      await page.waitForFunction(() => window.__hub.dont().time > 1.5);
      rec.landscape = await page.evaluate(() => {
        const r = document.querySelector('.dont-stage').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      await shot(page, rec, 'land-1-dont-screen');
      await page.waitForSelector('#dont-end:not([hidden])', { timeout: 20_000 });
      await sleep(500);
      rec.landscape.end = await page.evaluate(() => {
        const r = document.getElementById('dont-end').getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
      });
      await shot(page, rec, 'land-2-dont-end');
      await context.close();
    }
  },

  // 좁은 폰(320x568) + 움직임 줄이기: 가로 넘침, 사진 앱 윗줄(워드마크와 링크가 겹치지 않는지)
  async narrow(browser, rec) {
    const context = await browser.newContext({ ...PHONE, viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && rec.errors.push(`console: ${m.text()}`));
    page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
    await page.goto(BASE + '/');
    await page.waitForLoadState('networkidle');
    rec.hubNoHScroll = await noHorizontalScroll(page);
    await shot(page, rec, 'narrow-1-landing');
    await page.locator('.game-row[data-game="dont"]').click();
    await page.waitForFunction(() => window.__hub.dont().time > 1);
    await shot(page, rec, 'narrow-2-dont');
    await page.locator('#dont-close').click();
    await page.goto(BASE + '/unmute/');
    await page.waitForFunction(() => window.__unmute?.screen === 'intro');
    rec.unmuteNoHScroll = await noHorizontalScroll(page);
    await shot(page, rec, 'narrow-3-unmute');
    await page.goto(BASE + '/otr/');
    await page.waitForFunction(() => window.__booth?.ready === true, null, { timeout: 60_000 });
    rec.otrHeader = await page.evaluate(() => {
      const a = document.getElementById('워드마크').getBoundingClientRect();
      const b = document.getElementById('허브로').getBoundingClientRect();
      return { wordmarkRight: Math.round(a.right), linkLeft: Math.round(b.left), linkWidth: Math.round(b.width), overlap: a.right > b.left };
    });
    rec.otrNoHScroll = await noHorizontalScroll(page);
    await shot(page, rec, 'narrow-4-otr');
    await context.close();
  },

  async cycle(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await page.goto(BASE + '/');
    rec.rounds = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('#start').click();
      await waitState(page, ['scanning', 'card'], 60_000);
      await sleep(500);
      await page.locator('#scan-back').click();
      await waitState(page, 'landing');
      await sleep(1800); // 워커·텐서 정리(1.5초 뒤)
      rec.rounds.push(
        await page.evaluate(() => ({
          styles: document.head.querySelectorAll('style').length,
          canvases: document.querySelectorAll('#ar-view canvas').length,
          videos: document.querySelectorAll('#ar-view video').length,
          tracks: window.__hub.cameraTracks(),
          depth: window.__hub.depth,
          tensors: window._tfengine?.state?.numTensors ?? null, // tfjs가 전역에 두는 엔진(묶음 안의 tfjs)
        })),
      );
    }
    if (new Set(rec.rounds.map((r) => r.styles)).size !== 1) throw new Error('style이 쌓임');
    await context.close();
  },

  async 'fail-load'(browser, rec) {
    const { page, context } = await newPage(browser, rec);
    await page.route('**/vendor/mindar-three.js', (r) => r.abort());
    await page.goto(BASE + '/');
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__hub.fail, null, { timeout: 30_000 });
    rec.fail = await hub(page, () => window.__hub.fail);
    rec.state = await hub(page, () => window.__hub.state);
    rec.notice = await page.locator('#notice').textContent();
    rec.tracksAfter = await hub(page, () => window.__hub.cameraTracks());
    await shot(page, rec, 'fail-load');
    await context.close();
  },

  async 'fail-gl'(browser, rec) {
    // tfjs WebGL 셰이더 연결을 실패시킨다(보고된 iOS 27 오류와 같은 자리)
    const { page, context } = await newPage(browser, rec, () => {
      for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
        if (!C) continue;
        const orig = C.prototype.getProgramParameter;
        C.prototype.getProgramParameter = function (p, pname) {
          if (pname === 0x8b82) return false; // LINK_STATUS
          return orig.call(this, p, pname);
        };
      }
    });
    await page.goto(BASE + '/');
    const t0 = Date.now();
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__hub.fail, null, { timeout: 60_000 });
    rec.failMs = Date.now() - t0;
    rec.fail = await hub(page, () => window.__hub.fail);
    rec.state = await hub(page, () => window.__hub.state);
    rec.events = await hub(page, () => window.__hub.events.map((e) => `${e.type} ${e.kind ?? ''} ${(e.cause ?? '').slice(0, 80)}`));
    rec.tracksAfter = await hub(page, () => window.__hub.cameraTracks());
    await shot(page, rec, 'fail-gl');
    await context.close();
  },
};

const CAM_FOR = {
  landing: 'wall', nojs: 'wall', inapp: 'wall', otr: 'otr', dont: 'dont', all6: 'dont', unmute: 'unmute', 'unmute-edit': 'wall',
  manual: 'wall', wall: 'wall', wall3: 'wall3', race: 'dont', back: 'otr', slow: 'wall', 'slow-card': 'dont',
  'cam-errors': 'wall', denied: 'wall:noui', layout: 'wall', narrow: 'wall', cycle: 'wall', 'fail-load': 'wall', 'fail-gl': 'wall',
};
const names = Object.keys(scenarios).filter((n) => !ONLY || ONLY.includes(n));
const byCam = {};
for (const n of names) (byCam[CAM_FOR[n]] ??= []).push(n);

let failed = 0;
for (const [camKey, list] of Object.entries(byCam)) {
  const [cam, flag] = camKey.split(':');
  const browser = await launch(cam, { fakeUi: flag !== 'noui' });
  for (const n of list) {
    const rec = { ok: false, errors: [], warnings: [], failedRequests: [], shots: [] };
    summary.scenarios[n] = rec;
    const t0 = Date.now();
    try {
      await scenarios[n](browser, rec);
      rec.ok = true;
    } catch (e) {
      rec.exception = String(e?.message ?? e).split('\n').slice(0, 4).join(' | ');
      failed++;
    }
    rec.sec = Math.round((Date.now() - t0) / 100) / 10;
    console.log(`${rec.ok ? '통과' : '실패'}  ${n}  ${rec.sec}s  오류 ${rec.errors.length}${rec.exception ? '  ' + rec.exception : ''}`);
  }
  await browser.close();
}
server.close();
await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(failed ? 1 : 0);
