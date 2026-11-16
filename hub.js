// 허브 진입점. 상태: landing(첫 화면) → starting(카메라·인식 준비) → scanning(포스터 찾는 중) → card(찾은 게임 카드)
//   → dont(허브 안에서 사용금지 영상) 또는 leaving(카메라를 놓고 otr/·unmute/로 이동).
// 직접 고르기 단추는 어느 상태에서나 바로 그 게임으로 간다(인식이 안 돼도 쓸 수 있게).
// 주소 옵션: ?targets=all6 이면 포스터 여섯 장 모두 인식(기본은 메인 셋).
// 뒤로 가기: 카메라 화면·사용금지 영상을 열 때 방문 기록을 하나씩 쌓아서, 폰의 뒤로 가기가 허브를 떠나지 않고
//   맨 위 화면을 닫게 한다(안드로이드 뒤로 가기 제스처).
import { GAMES, GAME_ORDER, TARGET_SETS } from './games.js';
import { HubAR, loadVendor, prefetchTargets, cancelPrefetch } from './ar.js';
import { DontPlayer } from './dont/dont.js';

const query = new URLSearchParams(location.search);
const SET = TARGET_SETS[query.get('targets')] ?? TARGET_SETS.main3;
const HINT_MS = 8000; // 이만큼 못 찾으면 "아래에서 고르세요"를 또렷하게
const LEAVE_DELAY_MS = 250; // 카메라를 놓은 뒤 다음 페이지로(iOS가 카메라를 다 놓을 틈)
const DISMISS_RELEASE_MS = 2500; // "다른 포스터예요"를 누른 포스터를 다시 찾지 않는 시간
const DISMISS_KEEP_MS = 10_000; // 그 포스터의 카드를 다시 띄우지 않는 시간
const CARD_SWAP_GUARD_MS = 1500; // 카드를 누르는 중에는 다른 게임 카드로 바꾸지 않는다

const FAIL_TEXT = {
  insecure: '카메라는 https 주소에서만 켜져요. 아래에서 게임을 고르세요.',
  nocamera: '이 기기나 브라우저에서는 카메라를 쓸 수 없어요. 아래에서 게임을 고르세요.',
  denied: '카메라 권한이 거절됐어요. 브라우저 설정에서 이 사이트의 카메라를 허용하거나 아래에서 게임을 고르세요.',
  camera: '카메라를 켜지 못했어요. 카메라를 쓰는 다른 앱을 닫고 다시 시도하거나 아래에서 게임을 고르세요.',
  load: '포스터 인식 도구를 받지 못했어요. 인터넷 연결을 확인하거나 아래에서 게임을 고르세요.',
  timeout: '이 기기에서는 포스터 인식이 안 돼요. 아래에서 게임을 고르세요.',
  failed: '이 기기에서는 포스터 인식이 안 돼요. 아래에서 게임을 고르세요.',
};
// 포스터 인식기 자체가 안 되는 실패(카메라 문제가 아님). 이때는 직접 고르기도 사진 앱을 포스터 AR 없이 연다
const AR_BROKEN = ['load', 'timeout', 'failed'];

// 카카오톡·네이버·인스타그램 등 앱 안의 브라우저(웹뷰). 카메라·공유가 막혀 있는 경우가 많다
const UA = navigator.userAgent;
const IN_APP = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|\bLine\/|DaumApps|everytimeApp|; wv\)/i.test(UA);

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  landing: $('landing'),
  notice: $('notice'),
  inapp: $('inapp'),
  inappOpen: $('inapp-open'),
  start: $('start'),
  startLabel: $('start-label'),
  list: $('game-list'),
  scan: $('scan'),
  arView: $('ar-view'),
  back: $('scan-back'),
  status: $('status-text'),
  sheet: $('sheet'),
  sheetHint: $('sheet-hint'),
  chips: $('game-chips'),
  cardThumb: $('card-thumb'),
  cardName: $('card-name'),
  cardLine: $('card-line'),
  cardWhat: $('card-what'),
  cardOpen: $('card-open'),
  cardDismiss: $('card-dismiss'),
};

const hub = {
  state: 'landing',
  ar: null,
  token: 0,
  card: null, // { game, index, at }
  dismissed: new Map(), // "다른 포스터예요"를 누른 대상 → 누른 시각
  hintTimer: 0,
  lastSheetTouch: 0,
  events: [],
  fail: null,
};
// 방문 기록: depth = 허브가 쌓은 기록 수(카메라 화면 1 + 사용금지 영상 1), skip = 허브가 직접 되돌려서 무시할 popstate 수
// afterSkip: 기록을 줄인 뒤(popstate를 받은 뒤) 할 일. 다른 페이지로 가기 전에 쌓인 기록을 한 칸으로 줄일 때 쓴다
const nav = { depth: 0, skip: 0, afterSkip: null };

const dont = new DontPlayer({ onExit: () => afterContent(), onSite: (href) => leave(href) }); // 끝 화면 팀 사이트 단추: 카메라를 놓고 간다

// ── 시험용 고리 ───────────────────────────────
window.__hub = {
  get state() {
    return hub.state;
  },
  get card() {
    return hub.card;
  },
  get fail() {
    return hub.fail;
  },
  get depth() {
    return nav.depth;
  },
  events: hub.events,
  dont: () => dont.debug(),
  arRunning: () => !!hub.ar?.running,
  cameraTracks: () => hub.ar?.stream?.getTracks().filter((t) => t.readyState === 'live').length ?? 0,
  arSize: () => {
    const c = el.arView.querySelector('canvas');
    const v = el.arView.querySelector('video');
    return { canvas: c ? [c.clientWidth, c.clientHeight] : null, video: v ? [v.clientWidth, v.clientHeight] : null };
  },
};

function setState(s) {
  const prev = hub.state;
  hub.state = s;
  el.body.dataset.state = s;
  el.scan.hidden = s === 'landing';
  if (s !== 'scanning' && s !== 'card' && s !== 'starting') clearTimeout(hub.hintTimer);
  // 카메라 화면이 다시 보이면 크기를 다시 잰다(숨겨진 사이 화면 크기·방향이 바뀌었을 수 있다)
  if ((s === 'scanning' || s === 'card') && (prev === 'dont' || prev === 'landing')) requestAnimationFrame(() => hub.ar?.resize());
  syncHistory();
}

function log(type, data) {
  hub.events.push({ t: Math.round(performance.now()), type, ...data });
  if (hub.events.length > 200) hub.events.splice(0, 50);
}

// ── 방문 기록(뒤로 가기) ───────────────────────
function uiDepth() {
  const scanLayer = !!hub.ar || hub.state === 'starting' || hub.state === 'scanning' || hub.state === 'card';
  return (scanLayer ? 1 : 0) + (dont.isOpen ? 1 : 0);
}

function syncHistory() {
  if (hub.state === 'leaving') return;
  const want = uiDepth();
  try {
    if (want > nav.depth) {
      for (let d = nav.depth + 1; d <= want; d++) history.pushState({ hubDepth: d }, '');
      nav.depth = want;
    } else if (want < nav.depth) {
      nav.skip++;
      history.go(want - nav.depth);
      nav.depth = want;
    }
  } catch {
    /* 기록을 못 쓰는 환경: 뒤로 가기만 허브 밖으로 나간다 */
  }
}

window.addEventListener('popstate', (e) => {
  if (nav.skip > 0) {
    nav.skip--;
    if (nav.skip === 0 && nav.afterSkip) {
      const f = nav.afterSkip;
      nav.afterSkip = null;
      f();
    }
    return;
  }
  // 다른 페이지로 가는 중(그 페이지가 아직 안 뜸)에 뒤로 가기: 브라우저가 이동을 취소하므로 허브 첫 화면으로 돌아온다.
  // 팀 사이트처럼 다른 도메인은 뜨는 데 오래 걸려 행사장 회선에서 자주 겪는다(예전에는 "이동하는 중…"에 멈췄다)
  if (hub.state === 'leaving') {
    clearTimeout(hub.leaveTimer);
    nav.afterSkip = null;
    nav.depth = e.state?.hubDepth ?? 0;
    log('back', { depth: nav.depth, leaving: true });
    setState('landing');
    return;
  }
  nav.depth = e.state?.hubDepth ?? 0;
  log('back', { depth: nav.depth });
  // 맨 위 화면부터 닫는다
  if (dont.isOpen && uiDepth() > nav.depth) {
    dont.close();
    afterContent();
  }
  if (uiDepth() > nav.depth && hub.state !== 'landing') {
    stopScan();
    hideCard();
    setState('landing');
  }
  syncHistory(); // 앞으로 가기 등으로 어긋났으면 맞춘다
});

// ── 게임 단추 ─────────────────────────────────
function gameButton(id, cls) {
  const g = GAMES[id];
  let b;
  if (cls === 'game-row') {
    // 첫 화면 목록은 링크(스크립트 없이 쓰던 것과 같은 모양). 누름은 허브가 가로챈다
    b = document.createElement('a');
    // 사용금지 링크는 영상 주소 그대로(?v= 판 번호까지. tools/stamp_media.mjs가 index.html에 붙인다)
    b.href = g.arHref ?? g.href ?? document.getElementById('dont-video')?.getAttribute('src') ?? 'video/dont.mp4';
  } else {
    b = document.createElement('button');
    b.type = 'button';
  }
  b.className = cls;
  b.dataset.game = id;
  const img = document.createElement('img');
  img.src = g.thumb;
  img.alt = '';
  img.decoding = 'async';
  b.append(img);
  if (cls === 'game-row') {
    const t = document.createElement('span');
    t.innerHTML = '<span class="name"></span><span class="what"></span><span class="line"></span>';
    t.querySelector('.name').textContent = g.name;
    t.querySelector('.what').textContent = g.what;
    t.querySelector('.line').textContent = g.line;
    b.append(t);
    b.insertAdjacentHTML('beforeend', '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>');
    b.setAttribute('aria-label', `${g.name}: ${g.what}`);
  } else {
    const t = document.createElement('span');
    t.textContent = g.name;
    b.append(t);
    b.setAttribute('aria-label', `${g.name} 열기`);
  }
  // 사용금지는 소리 있는 재생이 이 클릭 안에서 시작돼야 해서 click에서 바로 연다.
  // 사진 앱도 직접 고르기로 열 때 포스터 AR로 연다(포스터를 비추면 캐릭터가 걸어 나오고, 못 찾으면 "포스터 없이"로 넘어갈 수 있다).
  // 다만 이 기기에서 포스터 인식이 이미 안 된다고 나왔으면(hub.fail) 사진 앱에서 같은 인식기를 다시 기다리지 않게 원래 사진 앱으로
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (g.arHref && !AR_BROKEN.includes(hub.fail)) openArGame(id);
    else openGame(id);
  });
  const li = document.createElement('li');
  li.append(b);
  return li;
}

el.list.replaceChildren(...GAME_ORDER.map((id) => gameButton(id, 'game-row')));
el.chips.replaceChildren(...GAME_ORDER.map((id) => gameButton(id, 'chip')));

// 아래 띠 높이를 CSS에 알려 안내 틀을 남은 공간 가운데에 둔다
new ResizeObserver(() => {
  el.scan.style.setProperty('--sheet-h', el.sheet.offsetHeight + 'px');
}).observe(el.sheet);
el.sheet.addEventListener('pointerdown', () => (hub.lastSheetTouch = performance.now()), { passive: true });

// ── 인식 켜기·끄기 ────────────────────────────
function showNotice(text) {
  el.notice.textContent = text ?? '';
  el.notice.hidden = !text;
}

function phaseText(phase, p) {
  switch (phase) {
    case 'download':
      return p > 0 && p < 1 ? `인식 준비 중… ${Math.round(p * 100)}%` : '인식 준비 중…';
    case 'camera':
      return '카메라를 켜는 중… 권한을 물으면 허용해 주세요';
    case 'prepare':
      return '포스터 인식을 준비하는 중…';
    default:
      return '준비 중…';
  }
}

async function startScan() {
  if (hub.ar) return;
  const token = ++hub.token;
  showNotice(null);
  hub.fail = null;
  hub.dismissed.clear();
  hideCard();
  el.body.dataset.hint = 'off';
  setState('starting');
  el.status.textContent = phaseText('camera');
  log('start');
  const ar = new HubAR({
    container: el.arView,
    targetsUrl: SET.file,
    targets: SET.targets,
    onFound: (i) => onFound(i),
    onLost: (i, info) => onLost(i, info),
    onRelease: (i) => log('release', { index: i }),
    // 카드를 찾는 동안만, 화면 가장자리에 걸린 포스터를 놓아주고 가운데 포스터를 찾는다
    autoRelease: () => hub.state === 'scanning' || hub.state === 'card',
    onPhase: (phase, p) => {
      if (token === hub.token) el.status.textContent = phaseText(phase, p);
    },
    onFail: (e) => {
      if (token === hub.token) arFailed(e);
    },
  });
  hub.ar = ar;
  startHintTimer(); // 준비가 오래 걸려도 8초 뒤엔 아래 단추를 또렷하게
  try {
    await ar.start();
  } catch (e) {
    if (token !== hub.token) return; // 사용자가 먼저 껐다
    hub.ar = null;
    arFailed(e);
    return;
  }
  if (token !== hub.token) {
    ar.stop();
    return;
  }
  dont.attach(ar, SET.targets);
  log('ready');
  // 준비하는 사이 직접 고르기로 사용금지를 열었으면 그대로 둔다(영상은 이제 포스터를 찾으면 위로 올라간다)
  if (hub.state === 'starting') setState('scanning');
}

function stopScan() {
  hub.token++;
  clearTimeout(hub.hintTimer);
  dont.detach();
  hub.ar?.stop();
  hub.ar = null;
}

function arFailed(err) {
  const kind = err?.kind ?? 'failed';
  hub.fail = kind;
  log('fail', { kind, cause: String(err?.cause?.name ?? err?.cause?.message ?? err?.cause ?? '') });
  stopScan();
  el.startLabel.textContent = '다시 시도';
  showNotice(FAIL_TEXT[kind] ?? FAIL_TEXT.failed);
  // 영상을 보는 중이었으면 화면 가운데 보기로 이어 가고, 닫을 때 첫 화면으로 간다
  if (hub.state !== 'dont') {
    hideCard();
    setState('landing');
    el.notice.scrollIntoView({ block: 'center' });
  } else {
    syncHistory();
  }
}

function startHintTimer() {
  clearTimeout(hub.hintTimer);
  hub.hintTimer = setTimeout(() => {
    if (hub.state === 'scanning' || hub.state === 'starting' || hub.state === 'card') el.body.dataset.hint = 'on';
  }, HINT_MS);
}

// ── 인식 이벤트 ───────────────────────────────
function isDismissed(i) {
  const at = hub.dismissed.get(i);
  if (at == null) return false;
  if (performance.now() - at > DISMISS_KEEP_MS) {
    hub.dismissed.delete(i);
    return false;
  }
  return true;
}

function onFound(i) {
  const t = SET.targets[i];
  log('found', { index: i, game: t?.game });
  if (!t) return;
  if (hub.state === 'dont') return dont.onFound(i);
  if (hub.state !== 'scanning' && hub.state !== 'card') return;
  if (isDismissed(i)) {
    // "다른 포스터예요"를 누른 포스터: 계속 놓아줘서 옆의 다른 포스터를 찾게 한다
    hub.ar?.release(i, DISMISS_RELEASE_MS);
    return;
  }
  hub.dismissed.clear(); // 다른 포스터로 옮겼다: 앞에서 고른 것은 잊는다
  // 카드 단추를 누르는 중에 다른 게임 카드로 바뀌지 않게
  if (hub.state === 'card' && hub.card?.game !== t.game && performance.now() - hub.lastSheetTouch < CARD_SWAP_GUARD_MS) return;
  showCard(t.game, i);
}

function onLost(i, info) {
  log('lost', { index: i, forced: !!info?.forced });
  if (!info?.forced) hub.dismissed.delete(i); // 정말로 놓쳤다가 다시 찾으면 다시 묻는다
  if (hub.state === 'dont') dont.onLost(i);
  // 카드는 그대로 둔다(폰을 내려 단추를 누르는 사이에 놓쳐도 된다)
}

// ── 카드 ──────────────────────────────────────
function showCard(gameId, index) {
  const g = GAMES[gameId];
  const same = hub.card?.game === gameId;
  hub.card = { game: gameId, index, at: performance.now() };
  if (same && hub.state === 'card') return;
  el.cardThumb.src = g.thumb;
  el.cardName.textContent = g.name;
  el.cardLine.textContent = g.line;
  el.cardWhat.textContent = g.what;
  el.cardOpen.textContent = g.open;
  el.sheet.dataset.view = 'card';
  setState('card');
  if (gameId === 'dont') dont.preload();
  el.cardOpen.focus({ preventScroll: true });
  log('card', { game: gameId, index });
}

function hideCard() {
  hub.card = null;
  el.sheet.dataset.view = 'chips';
}

el.cardOpen.addEventListener('click', () => {
  if (!hub.card) return;
  const g = GAMES[hub.card.game];
  if (!g?.arHref) return openGame(hub.card.game);
  openArGame(hub.card.game, el.cardOpen);
});

// 사진 앱 포스터 AR로 연다(포스터 카드, 직접 고르기 둘 다). 포스터를 놓쳤을 때 캐릭터를 세계에 붙여 두는 데 자이로를 쓴다.
// iOS는 탭 안에서만 허락을 물을 수 있어서 지금 묻고(같은 주소라 사진 앱에서도 쓴다), 답한 뒤에 간다
function openArGame(id, btn = null) {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function' && hub.state !== 'leaving') {
    let asked;
    try {
      asked = D.requestPermission();
    } catch {
      asked = null;
    }
    if (asked?.then) {
      if (btn) btn.disabled = true;
      asked.catch(() => {}).finally(() => {
        if (btn) btn.disabled = false;
        openGame(id, { ar: true });
      });
      return;
    }
  }
  openGame(id, { ar: true });
}
el.cardDismiss.addEventListener('click', () => {
  const c = hub.card;
  if (c && hub.ar?.isVisible(c.index)) {
    hub.dismissed.set(c.index, performance.now());
    hub.ar.release(c.index, DISMISS_RELEASE_MS); // 잡고 있던 포스터를 놓아야 다른 포스터를 찾는다
  }
  hideCard();
  setState('scanning');
});

// ── 게임 열기 ─────────────────────────────────
// ar: 사진 앱을 포스터 AR로 연다(포스터 카드, 그리고 2026-11-14부터 직접 고르기도. openArGame)
function openGame(id, { ar = false } = {}) {
  const g = GAMES[id];
  if (!g || hub.state === 'leaving') return;
  log('open', { game: id, via: hub.state });
  if (id === 'dont') {
    hideCard();
    clearTimeout(hub.hintTimer);
    if (!hub.ar) stopWarm(); // 첫 화면 미리 받기가 영상과 회선을 나눠 쓰지 않게
    dont.open(); // 클릭 안에서 바로 재생(소리)
    setState('dont');
    return;
  }
  leave(ar && g.arHref ? g.arHref : g.href);
}

// 다른 페이지 콘텐츠: 인식과 카메라를 놓고 간다(그쪽 페이지가 카메라를 새로 연다).
// 카메라 화면에서 가면 그 방문 기록을 갈아 끼운다(그 페이지에서 뒤로 가면 허브 첫 화면)
function leave(href) {
  hideCard();
  const hadCamera = !!hub.ar;
  stopScan();
  setState('leaving');
  el.status.textContent = '이동하는 중…';
  const go = () => (nav.depth > 0 ? location.replace(href) : location.assign(href));
  const t0 = performance.now();
  const delay = hadCamera ? LEAVE_DELAY_MS : 0;
  const fire = () => {
    clearTimeout(hub.leaveTimer);
    hub.leaveTimer = setTimeout(go, Math.max(0, delay - (performance.now() - t0)));
  };
  if (nav.depth > 1) {
    // 카메라 화면 위에 영상까지 열려 기록이 두 칸이면, 한 칸으로 줄인 뒤(popstate를 받은 뒤) 그 칸을 갈아 끼운다.
    // 그대로 갈아 끼우면 돌아왔을 때 첫 화면 기록이 두 개가 되어 뒤로 가기가 한 번 헛돈다.
    // 바로 이어서 이동을 부르면 기록 이동이 그 이동을 취소할 수 있어 popstate를 기다린다(안 오면 0.4초 뒤 그냥 간다)
    try {
      nav.skip++;
      nav.afterSkip = fire;
      history.go(1 - nav.depth);
      nav.depth = 1;
      hub.leaveTimer = setTimeout(() => {
        if (nav.afterSkip !== fire) return;
        nav.afterSkip = null; // skip은 그대로 둔다: 늦게 온 popstate를 뒤로 가기로 잘못 읽지 않게
        fire();
      }, 400);
      return;
    } catch {
      nav.afterSkip = null;
    }
  }
  fire();
}

// 사용금지 영상을 닫았을 때
function afterContent() {
  if (hub.ar?.running) {
    // 지금 보이는 포스터는 카드를 다시 띄우지 않는다(방금 본 게임)
    const now = performance.now();
    for (const i of hub.ar.visible) hub.dismissed.set(i, now);
    setState('scanning');
    startHintTimer();
  } else if (hub.ar) {
    // 인식 준비가 아직 안 끝났다: 카메라 화면으로 돌아가 준비를 기다린다
    setState('starting');
  } else {
    setState('landing');
  }
}

// ── 첫 화면 ───────────────────────────────────
el.start.addEventListener('click', () => startScan());
el.back.addEventListener('click', () => {
  stopScan();
  hideCard();
  setState('landing');
});

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  showNotice(window.isSecureContext ? FAIL_TEXT.nocamera : FAIL_TEXT.insecure);
  el.start.disabled = true;
}

// 앱 안의 브라우저: 바깥 브라우저로 여는 길을 안내한다(카카오톡은 바로 여는 주소가 있다)
if (IN_APP) {
  el.inapp.hidden = false;
  let href = null;
  if (/KAKAOTALK/i.test(UA)) href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
  else if (/Android/i.test(UA)) href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
  if (href) {
    el.inappOpen.href = href;
    el.inappOpen.hidden = false;
  }
}

// 첫 화면을 읽는 동안 포스터 정보(.mind)와 인식 도구를 차례로 미리 받아 둔다(실패해도 시작할 때 다시 받는다).
// 사용금지를 바로 열면 .mind 받기를 멈추고 인식 도구는 받지 않는다(영상에 회선을 비켜 준다).
// 차례로 받는 까닭: import()로 받는 인식 도구는 중간에 멈출 수 없다
const warmState = { handle: 0, idle: false, stopped: false };
function warm() {
  warmState.handle = 0;
  prefetchTargets(SET.file).promise.then(
    () => warmState.stopped || hub.state === 'dont' || loadVendor().catch(() => {}),
    () => {},
  );
}
function stopWarm() {
  warmState.stopped = true;
  if (warmState.handle) {
    if (warmState.idle) cancelIdleCallback(warmState.handle);
    else clearTimeout(warmState.handle);
    warmState.handle = 0;
  }
  if (cancelPrefetch(SET.file)) log('warm-cancel');
}
if (!el.start.disabled) {
  if ('requestIdleCallback' in window) {
    warmState.idle = true;
    warmState.handle = requestIdleCallback(warm, { timeout: 1500 });
  } else warmState.handle = setTimeout(warm, 800);
}

// 다른 앱으로 가면 카메라를 놓는다(배터리·iOS가 카메라를 끊는 문제). 영상은 멈추고 끝 화면에서 다시 보게 한다
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (hub.state === 'dont') {
    dont.suspend();
    if (hub.ar) stopScan();
    syncHistory();
  } else if (hub.ar || hub.state === 'starting') {
    stopScan();
    hideCard();
    setState('landing');
  }
});

// 뒤로 가기로 돌아오면(bfcache) 첫 화면부터
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  clearTimeout(hub.leaveTimer);
  nav.depth = history.state?.hubDepth ?? 0;
  nav.skip = 0;
  nav.afterSkip = null;
  if (hub.state !== 'landing') {
    stopScan();
    dont.close();
    hideCard();
    setState('landing');
  }
});

// 새로 고침 등으로 쌓아 둔 기록 위에서 열렸으면 그 자리를 첫 화면 기록으로 바꾼다
if (history.state?.hubDepth) history.replaceState({ hubDepth: 0 }, '');
setState('landing');
