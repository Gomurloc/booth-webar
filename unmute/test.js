// UNMUTE 성향 테스트. 내용(질문·답·결과·점수)은 모두 test.json에서 읽는다(UNMUTE 팀이 고치는 파일).
// 흐름: 처음 → 질문 n개 → 결과(카드 이미지 저장·공유).
// 배경 포스터는 회색으로 시작해 질문이 진행될수록 색이 조금씩 돌아오고, 결과에서 다 돌아온다.
import { drawCard, canvasToPng } from './card.js';

const POSTER = 'art/poster.jpg';
// 카카오톡·네이버·인스타그램 등 앱 안의 브라우저: 내려받기가 아무 일도 안 하는 경우가 많다
const IN_APP = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|\bLine\/|DaumApps|everytimeApp|; wv\)/i.test(navigator.userAgent);
const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  draft: $('draft'),
  intro: $('intro'),
  kicker: $('intro-kicker'),
  headline: $('intro-headline'),
  title: $('intro-title'),
  lead: $('intro-lead'),
  start: $('start'),
  quiz: $('quiz'),
  count: $('q-count'),
  bar: $('q-bar'),
  qText: $('q-text'),
  answers: $('answers'),
  prev: $('prev'),
  result: $('result'),
  rLabel: $('r-label'),
  rName: $('r-name'),
  rEmotion: $('r-emotion'),
  rDesc: $('r-desc'),
  rCard: $('r-card'),
  rWait: $('r-card-wait'),
  rHint: $('r-hint'),
  save: $('save'),
  retry: $('retry'),
  toast: $('toast'),
  oops: $('oops'),
  oopsText: $('oops-text'),
};

const state = { test: null, step: 0, picks: [], file: null, url: null, renderToken: 0 };

// 시험용 고리
window.__unmute = {
  get screen() {
    return el.body.dataset.screen;
  },
  get result() {
    return state.resultId ?? null;
  },
  get cardReady() {
    return !!state.file;
  },
  cardBlob: () => state.file,
};

// ── test.json 확인: 팀이 고치다 틀려도 무엇이 틀렸는지 화면에 바로 보이게 ──
function validate(t) {
  const errs = [];
  const ids = new Set();
  if (!Array.isArray(t.types) || t.types.length < 2) errs.push('types가 2개 이상 있어야 해요');
  (t.types ?? []).forEach((ty, i) => {
    if (!ty.id) errs.push(`types ${i + 1}번에 id가 없어요`);
    if (ids.has(ty.id)) errs.push(`types의 id "${ty.id}"가 두 번 나와요`);
    ids.add(ty.id);
    if (!ty.name) errs.push(`types "${ty.id}"에 name이 없어요`);
    if (!/^#[0-9a-fA-F]{6}$/.test(ty.color ?? '')) errs.push(`types "${ty.id}"의 color는 #ff3fb4 같은 6자리 색이어야 해요`);
    for (const k of ['emotion', 'description']) {
      if (ty[k] != null && typeof ty[k] !== 'string') errs.push(`types "${ty.id}"의 ${k}는 글자여야 해요`);
    }
  });
  // 없어도 되는 칸(빠지면 빈칸으로 그린다). 있으면 글자여야 한다
  for (const [k, v] of [
    ['result.label', t.result?.label],
    ['card.footerLeft', t.card?.footerLeft],
    ['card.footerRight', t.card?.footerRight],
  ]) {
    if (v != null && typeof v !== 'string') errs.push(`${k}는 글자여야 해요`);
  }
  if (!Array.isArray(t.questions) || !t.questions.length) errs.push('questions가 비어 있어요');
  (t.questions ?? []).forEach((q, qi) => {
    if (!q.text) errs.push(`${qi + 1}번 질문에 text가 없어요`);
    if (!Array.isArray(q.answers) || q.answers.length < 2) errs.push(`${qi + 1}번 질문에 답이 2개 이상 있어야 해요`);
    (q.answers ?? []).forEach((a, ai) => {
      const where = `${qi + 1}번 질문 ${ai + 1}번 답`;
      if (!a.text) errs.push(`${where}에 text가 없어요`);
      const scores = a.scores ?? (a.type ? { [a.type]: 1 } : null);
      if (!scores) errs.push(`${where}에 type(또는 scores)이 없어요`);
      else for (const k of Object.keys(scores)) if (!ids.has(k)) errs.push(`${where}의 "${k}"가 types에 없어요`);
    });
  });
  return errs;
}

function show(screen) {
  el.body.dataset.screen = screen;
  for (const s of ['intro', 'quiz', 'result', 'oops']) el[s].hidden = s !== screen;
  window.scrollTo(0, 0);
}

// 배경 색 되찾기: 0 = 흑백, 1 = 원래 색
function setColor(amount, brightness) {
  const root = document.documentElement.style;
  root.setProperty('--gray', String(1 - amount));
  root.setProperty('--bri', String(brightness));
}

// ── 처음 ────────────────────────────────────────
function renderIntro() {
  const t = state.test;
  el.kicker.textContent = t.intro.kicker ?? '';
  el.headline.textContent = t.intro.headline ?? '';
  el.title.textContent = t.intro.title ?? '';
  el.lead.textContent = t.intro.lead ?? '';
  el.start.textContent = t.intro.start ?? '시작';
  setColor(0, 0.55);
  show('intro');
}

// ── 질문 ────────────────────────────────────────
function renderQuestion() {
  const t = state.test;
  const n = t.questions.length;
  const q = t.questions[state.step];
  el.count.textContent = `${state.step + 1} / ${n}`;
  el.bar.replaceChildren(
    ...t.questions.map((_, i) => {
      const li = document.createElement('li');
      if (i <= state.step) li.className = 'on';
      return li;
    }),
  );
  el.qText.textContent = q.text;
  el.answers.replaceChildren(
    ...q.answers.map((a, ai) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'answer';
      b.textContent = a.text;
      b.dataset.index = ai;
      if (state.picks[state.step] === ai) b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', () => pick(ai, b));
      return b;
    }),
  );
  el.prev.hidden = state.step === 0;
  // 질문이 진행될수록 색이 조금씩 돌아온다(마지막 질문에서 약 40%)
  setColor((state.step / n) * 0.45, 0.42);
  show('quiz');
}

let picking = false;
function pick(ai, button) {
  if (picking) return;
  picking = true;
  button.classList.add('picked');
  state.picks[state.step] = ai;
  state.picks.length = state.step + 1; // 이전으로 갔다가 다시 고르면 뒤의 답은 지운다
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(
    () => {
      picking = false;
      if (state.step + 1 < state.test.questions.length) {
        state.step++;
        renderQuestion();
      } else {
        renderResult();
      }
    },
    reduce ? 0 : 220,
  );
}

el.prev.addEventListener('click', () => {
  if (state.step > 0) {
    state.step--;
    renderQuestion();
  }
});

// ── 점수 ────────────────────────────────────────
export function score(test, picks) {
  const total = Object.fromEntries(test.types.map((t) => [t.id, 0]));
  const order = []; // 답한 순서대로, 그 답이 가장 많이 준 결과
  picks.forEach((ai, qi) => {
    const a = test.questions[qi]?.answers[ai];
    if (!a) return;
    const scores = a.scores ?? { [a.type]: 1 };
    for (const [k, v] of Object.entries(scores)) total[k] += Number(v) || 0;
    const top = Object.entries(scores).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (top) order.push(top);
  });
  const best = Math.max(...Object.values(total));
  const tied = test.types.map((t) => t.id).filter((id) => total[id] === best);
  let id = tied[0];
  if (tied.length > 1 && test.scoring?.tieBreak !== 'order') {
    // 동점이면 가장 나중에 고른 답의 결과(마지막 질문이 결정 질문이 된다)
    for (let i = order.length - 1; i >= 0; i--) {
      if (tied.includes(order[i])) {
        id = order[i];
        break;
      }
    }
  }
  return { id, total };
}

// ── 결과 ────────────────────────────────────────
function renderResult() {
  const t = state.test;
  const { id, total } = score(t, state.picks);
  const type = t.types.find((x) => x.id === id);
  state.resultId = id;
  state.total = total;
  document.documentElement.style.setProperty('--accent', type.color);
  el.rLabel.textContent = t.result?.label ?? '';
  el.rName.textContent = type.name;
  el.rEmotion.textContent = type.emotion ?? '';
  el.rEmotion.hidden = !type.emotion;
  el.rDesc.textContent = type.description ?? '';
  el.save.textContent = t.result?.save ?? '이미지 저장하기';
  el.retry.textContent = t.result?.retry ?? '다시 하기';
  el.rHint.textContent = t.result?.saveHint ?? '';
  el.toast.hidden = true;
  setColor(1, 0.62);
  show('result');
  makeCard(type);
}

async function makeCard(type) {
  const token = ++state.renderToken;
  state.file = null;
  el.save.disabled = true;
  el.rCard.hidden = true;
  el.rWait.hidden = false;
  el.rWait.textContent = '결과 이미지를 만드는 중…';
  try {
    const canvas = await drawCard({ test: state.test, type, posterSrc: POSTER });
    const blob = await canvasToPng(canvas);
    canvas.width = canvas.height = 0; // iOS 캔버스 메모리를 바로 돌려준다
    if (token !== state.renderToken) return;
    // 공유 시트는 클릭 안에서 await 없이 불러야 해서 파일을 미리 만들어 둔다
    state.file = new File([blob], `UNMUTE-${type.id}.png`, { type: 'image/png', lastModified: Date.now() });
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(blob);
    el.rCard.src = state.url;
    el.rCard.alt = `결과 카드: ${type.name}`;
    el.rCard.hidden = false;
    el.rWait.hidden = true;
    el.save.disabled = false;
  } catch (e) {
    if (token !== state.renderToken) return;
    console.warn('[UNMUTE] 결과 카드를 만들지 못함', e);
    el.rWait.textContent = '이미지를 만들지 못했어요. 화면을 캡처해 주세요.';
  }
}

function canShareFile(file) {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
}

// 저장: 폰은 공유 시트(사진 앱에 저장 포함), 공유가 안 되면 내려받기. 클릭 처리기 맨 앞에서 await 없이 부른다
el.save.addEventListener('click', () => {
  const file = state.file;
  if (!file) return;
  if (IN_APP && !canShareFile(file)) {
    saveInApp();
    return;
  }
  if (canShareFile(file)) {
    let p;
    try {
      p = navigator.share({ files: [file] });
    } catch {
      p = Promise.reject(new Error('share'));
    }
    p.then(
      () => toast('저장·공유했어요'),
      (e) => {
        if (e?.name === 'AbortError') return;
        if (IN_APP) saveInApp();
        else download(file);
      },
    );
    return;
  }
  download(file);
});

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  // 내려받기가 정말 됐는지는 페이지가 알 수 없다(웹뷰는 아무 일도 안 할 수 있다). 그래서 길게 누르기도 함께 알린다
  toast('내려받기를 시작했어요. 저장이 안 되면 위 이미지를 길게 눌러 저장해 주세요.');
}

// 앱 안의 브라우저: 내려받기 대신 길게 눌러 저장하게 한다
function saveInApp() {
  el.rCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast('이미지를 길게 눌러 저장해 주세요.');
}

el.start.addEventListener('click', () => {
  state.step = 0;
  state.picks = [];
  renderQuestion();
});
el.retry.addEventListener('click', () => {
  state.renderToken++;
  state.file = null;
  document.documentElement.style.removeProperty('--accent');
  renderIntro();
});

// ── 시작 ────────────────────────────────────────
async function boot() {
  let t;
  try {
    const res = await fetch('test.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    t = await res.json();
  } catch (e) {
    el.oopsText.textContent = 'test.json을 읽지 못했어요.\n' + (e instanceof SyntaxError ? 'JSON 문법(쉼표·따옴표)을 확인해 주세요.' : e.message);
    show('oops');
    return;
  }
  const errs = validate(t);
  if (errs.length) {
    el.oopsText.textContent = 'test.json을 확인해 주세요.\n' + errs.slice(0, 6).join('\n');
    show('oops');
    return;
  }
  state.test = t;
  // 시안 표시는 팀 확인용(주소에 ?draft=1)일 때만. 방문객 화면에는 띄우지 않는다
  el.draft.hidden = !(String(t.status ?? '').includes('시안') && new URLSearchParams(location.search).has('draft'));
  // 결과 카드용 포스터를 미리 받아 둔다
  new Image().src = POSTER;
  renderIntro();
}

boot();
