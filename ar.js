// MindAR(포스터 인식) 켜기·끄기 감싸기.
// MindAR 1.2.5는 2024-01 뒤로 손보는 사람이 없어서 허브는 늘 "안 돼도 단추로 간다"를 전제로 쓴다.
// 지킬 것
// - 카메라를 먼저 켠다. 시작을 누르자마자 권한 창이 뜨고, 인식 도구(vendor)·포스터 정보(.mind)는 그 사이와 뒤에 받는다.
//   카메라는 허브가 직접 열어서 오류 이름(NotAllowedError 등)으로 거절·장치 없음·사용 중을 가린다
//   (MindAR는 getUserMedia 오류를 버리고 빈 reject만 한다). 켠 카메라는 MindAR에 그대로 넘긴다.
// - vendor 묶음은 시작 단추를 누른 뒤에만 불러온다(실패해도 허브의 나머지는 돈다). 받기가 멈추면 시간 제한으로 실패 처리.
// - MindAR start()는 안에서 오류가 나면 끝나지 않고 멈춘다(async Promise 안의 throw). 그래서
//   카메라가 켜진 뒤 단계에 시간 제한을 두고, 그 사이 MindAR·tfjs에서 난 잡히지 않은 오류도 실패로 본다.
//   다른 스크립트(인앱 브라우저가 끼워 넣은 것 등)의 오류는 인식 실패로 보지 않는다.
// - 카메라 권한 창이 떠 있는 동안은 시간 제한을 걸지 않는다(사람이 답할 시간).
// - 끌 때는 처리 루프·카메라 트랙·렌더러·워커·텐서를 모두 놓는다(다음 페이지가 카메라를 바로 열 수 있게).
const VENDOR_URL = './vendor/mindar-three.js';
const VENDOR_MARK = 'mindar-three'; // 오류가 인식 도구에서 났는지 가리는 표시(파일 이름)
const AR_TIMEOUT_MS = 30_000; // 받기가 끝난 뒤 인식 준비(셰이더 컴파일 등)에 주는 시간
const DOWNLOAD_STALL_MS = 25_000; // 받기가 이만큼 전혀 나아가지 않으면 실패
const MAX_PIXEL_RATIO = 2; // 3배 화면에서 WebGL 캔버스가 너무 커지지 않게
const RELEASE_MS = 1500; // 놓아준 포스터를 다시 찾지 않는 시간(그사이 다른 포스터를 찾는다)
const OFF_CENTER_MS = 500; // 따라가는 포스터가 화면 가장자리에 이만큼 머물면 놓아준다
const EDGE = { x: 0.12, y: 0.08 }; // 화면 가장자리 범위(비율). 포스터 가운데가 여기 들어가면 "가장자리"

let vendorPromise = null;
export function loadVendor() {
  if (!vendorPromise) {
    vendorPromise = import(VENDOR_URL).catch((e) => {
      vendorPromise = null; // 다음 시도에서 다시 받는다
      throw e;
    });
  }
  return vendorPromise;
}

export class ARError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // 'insecure' | 'nocamera' | 'denied' | 'camera' | 'load' | 'timeout' | 'failed'
    this.cause = cause;
  }
}

// .mind를 받으면서 진행률을 알린다. 받은 것은 blob 주소로 MindAR에 넘긴다.
// 첫 화면에서 미리 받기 시작할 수 있게 주소마다 한 번만 받고, 진행률을 듣는 쪽은 나중에 바꿔 끼운다.
// 쓰는 쪽이 없으면(첫 화면 미리 받기) cancelPrefetch로 멈출 수 있다(사용금지 영상에 회선을 비켜 준다)
const targetFiles = new Map(); // url → { promise, progress, listener, users, ctrl, lastChange }
export function prefetchTargets(url) {
  let entry = targetFiles.get(url);
  if (entry) return entry;
  const ctrl = new AbortController();
  entry = { progress: 0, listener: null, users: 0, ctrl, lastChange: performance.now() };
  entry.promise = (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      entry.lastChange = performance.now();
      entry.progress = Math.min(1, got / total);
      entry.listener?.(entry.progress);
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  })();
  entry.promise.catch(() => {
    if (targetFiles.get(url) === entry) targetFiles.delete(url); // 실패하면 다음에 다시 받는다
  });
  targetFiles.set(url, entry);
  return entry;
}

export function cancelPrefetch(url) {
  const entry = targetFiles.get(url);
  if (!entry || entry.users > 0 || entry.progress >= 1) return false;
  entry.ctrl.abort();
  targetFiles.delete(url);
  return true;
}

// getUserMedia 오류 이름 → 허브 안내 종류
function cameraErrorKind(e) {
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' || n === 'NotSupportedError') return 'nocamera';
  return 'camera'; // NotReadableError(다른 앱이 쓰는 중), AbortError 등
}

// 오류가 인식 도구(vendor 묶음)에서 났는지
function fromVendor(ev) {
  const r = ev.reason ?? ev.error;
  return [ev.filename, r?.stack, ev.error?.stack].some((s) => typeof s === 'string' && s.includes(VENDOR_MARK));
}

export class HubAR {
  // targets: [{ game, overlay? }] (games.js TARGET_SETS의 targets와 같은 순서)
  constructor({ container, targetsUrl, targets, onFound, onLost, onPhase, onFail, onRelease, autoRelease }) {
    Object.assign(this, { container, targetsUrl, targets, onFound, onLost, onPhase, onFail, onRelease, autoRelease });
    this.mindar = null;
    this.three = null;
    this.stream = null;
    this.video = null;
    this.anchors = [];
    this.visible = new Set();
    this.running = false;
    this.dead = false;
    this.renderWanted = false;
    this.frameHooks = new Set();
    this.blobUrl = null;
    this.failHandler = null;
    this.entry = null;
    this.styles = [];
    this.excludeUntil = []; // 대상별로 다시 찾지 않을 때까지의 시각
    this.forcedLost = new Set(); // 허브가 놓아준 대상(이때의 lost는 "놓쳤다"가 아니다)
    this.offSince = [];
  }

  // 성공하면 인식 루프가 돌고 있다. 실패하면 ARError를 던지고 스스로 정리한 상태다
  async start() {
    try {
      if (!window.isSecureContext) throw new ARError('insecure');
      if (!navigator.mediaDevices?.getUserMedia) throw new ARError('nocamera');

      // 받기를 먼저 걸어 두고(권한 창과 같이 진행) 카메라를 켠다
      const entry = prefetchTargets(this.targetsUrl);
      entry.users++;
      this.entry = entry;
      const downloads = Promise.all([loadVendor(), entry.promise]);
      downloads.catch(() => {});
      this.onPhase?.('camera');
      await this._openCamera();

      entry.listener = (p) => this.onPhase?.('download', p);
      this.onPhase?.('download', entry.progress);
      let mod;
      let blob;
      try {
        [mod, blob] = await this._watchDownload(downloads, entry);
      } catch (e) {
        throw e instanceof ARError ? e : new ARError('load', e);
      } finally {
        entry.listener = null;
      }
      if (this.dead) throw new ARError('failed');
      this.three = mod;
      this.blobUrl = URL.createObjectURL(blob);

      const hub = this;
      // MindARThree를 조금만 고쳐 쓴다(라이브러리 파일은 그대로)
      class HubMindAR extends mod.MindARThree {
        // 생성자가 window resize에 이 함수를 묶는다(풀 수 없음). 끈 뒤나 준비 전에는 아무것도 안 한다
        resize() {
          if (hub.dead || !this.controller || !this.video) return;
          super.resize();
        }
        // 허브가 이미 켠 카메라를 넘긴다(권한·오류 처리는 허브가 했다)
        _startVideo() {
          this.video = hub.video;
          this.video.setAttribute('width', this.video.videoWidth);
          this.video.setAttribute('height', this.video.videoHeight);
          hub.onPhase?.('prepare');
          return Promise.resolve();
        }
        _startAR() {
          if (hub.dead) return Promise.reject(new ARError('failed'));
          let timer;
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new ARError('timeout')), AR_TIMEOUT_MS);
          });
          const ar = super._startAR().then(() => {
            if (hub.dead) this.controller?.stopProcessVideo(); // 준비 중에 꺼졌으면 루프를 세운다
          });
          return Promise.race([ar, timeout, hub.failPromise]).finally(() => clearTimeout(timer));
        }
      }

      // 시작하는 동안과 도는 동안 인식 도구에서 난 잡히지 않은 오류는 실패로 돌린다
      this.failPromise = new Promise((_, reject) => {
        this.rejectStart = reject;
      });
      this.failPromise.catch(() => {});
      this.failHandler = (ev) => {
        if (this.dead || !fromVendor(ev)) return;
        const reason = ev.reason ?? ev.error ?? ev.message;
        if (ev.type === 'unhandledrejection') {
          ev.preventDefault(); // 콘솔의 "Uncaught (in promise)" 대신 허브가 단추로 안내한다. 원인은 경고로 남긴다
          console.warn('[허브] 포스터 인식 중 오류:', reason);
        }
        const err = new ARError('failed', reason);
        if (!this.running) this.rejectStart?.(err);
        else this.fail(err);
      };
      window.addEventListener('unhandledrejection', this.failHandler);
      window.addEventListener('error', this.failHandler);

      const stylesBefore = new Set(document.head.querySelectorAll('style'));
      const m = new HubMindAR({
        container: this.container,
        imageTargetSrc: this.blobUrl,
        maxTrack: 1,
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no',
      });
      // MindAR UI가 head에 넣는 style(시작마다 하나씩 쌓인다). 끌 때 지운다
      this.styles = [...document.head.querySelectorAll('style')].filter((s) => !stylesBefore.has(s));
      this.mindar = m;
      m.renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));
      this.targets.forEach((t, i) => {
        const a = m.addAnchor(i);
        a.onTargetFound = () => {
          this.visible.add(i);
          this.onFound?.(i);
        };
        a.onTargetLost = () => {
          this.visible.delete(i);
          this.offSince[i] = 0;
          const forced = this.forcedLost.delete(i);
          this.onLost?.(i, { forced });
        };
        this.anchors.push(a);
      });
      await m.start();
      if (this.dead) throw new ARError('failed');
      this._patchDetection(m.controller);
      this.running = true;
      m.renderer.setAnimationLoop(() => {
        this._checkEdges();
        for (const f of this.frameHooks) f();
        if (this.renderWanted) m.renderer.render(m.scene, m.camera);
      });
      this.onPhase?.('scanning');
    } catch (e) {
      const err = e instanceof ARError ? e : new ARError('failed', e);
      this.stop();
      throw err;
    }
  }

  async _openCamera() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
    } catch (e) {
      throw new ARError(cameraErrorKind(e), e);
    }
    // 권한 창을 기다리는 사이 허브가 꺼졌으면 늦게 켜진 카메라를 바로 놓는다
    if (this.dead) {
      stream.getTracks().forEach((t) => t.stop());
      throw new ARError('failed');
    }
    this.stream = stream;
    // MindAR가 만드는 것과 같은 카메라 video(맨 아래 층). 이어받기 전에는 CSS(.ar-camera)로 화면을 덮는다.
    // iOS는 화면에 그려진 video여야 프레임이 나오므로 숨기지 않는다
    const v = document.createElement('video');
    v.setAttribute('autoplay', '');
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.playsInline = true;
    v.className = 'ar-camera';
    Object.assign(v.style, { position: 'absolute', top: '0px', left: '0px', zIndex: '-2' });
    this.container.appendChild(v);
    this.video = v;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ARError('camera')), 10_000);
      v.addEventListener(
        'loadedmetadata',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
      v.srcObject = stream;
    });
    v.play?.().catch(() => {});
    if (this.dead) throw new ARError('failed');
  }

  // 받기가 끝날 때까지 기다린다. .mind 진행률이 오래 멈추면(또는 .mind가 끝난 뒤 vendor가 오래 안 오면) 실패
  _watchDownload(downloads, entry) {
    return new Promise((resolve, reject) => {
      let last = entry.progress;
      let lastAt = performance.now();
      const timer = setInterval(() => {
        if (this.dead) {
          clearInterval(timer);
          reject(new ARError('failed'));
          return;
        }
        if (entry.progress !== last) {
          last = entry.progress;
          lastAt = performance.now();
        }
        if (performance.now() - Math.max(lastAt, entry.lastChange) > DOWNLOAD_STALL_MS) {
          clearInterval(timer);
          reject(new ARError('load', new Error('받기가 멈춤')));
        }
      }, 1000);
      downloads.then(
        (r) => {
          clearInterval(timer);
          resolve(r);
        },
        (e) => {
          clearInterval(timer);
          reject(e);
        },
      );
    });
  }

  // 놓아준 대상은 잠깐 찾지 않게 한다(그사이 다른 포스터를 찾는다)
  _patchDetection(c) {
    if (!c?._detectAndMatch) return;
    const orig = c._detectAndMatch.bind(c);
    c._detectAndMatch = (inputT, indexes) => {
      const now = performance.now();
      const list = indexes.filter((i) => !(this.excludeUntil[i] > now));
      if (!list.length) return Promise.resolve({ targetIndex: -1, modelViewTransform: null });
      return orig(inputT, list);
    };
  }

  // 따라가던 대상을 놓아준다. MindAR는 한 번에 하나만 따라가서, 잡은 포스터가 화면에 조금이라도 남아 있으면
  // 다른 포스터를 찾지 않는다. 놓아주면 몇 프레임 뒤 lost(forced)가 오고, ms 동안은 다시 찾지 않는다
  release(i, ms = RELEASE_MS) {
    const st = this.mindar?.controller?.trackingStates?.[i];
    if (!st) return;
    this.excludeUntil[i] = performance.now() + ms;
    if (this.visible.has(i)) this.forcedLost.add(i);
    st.isTracking = false;
    this.onRelease?.(i);
  }

  // 대상 i의 가운데가 화면(인식 영역)의 어디에 있는지. 0~1(왼쪽 위가 0), 모르면 null
  screenCenter(i) {
    const m = this.mindar;
    const g = this.anchors[i]?.group;
    if (!m || !g?.visible) return null;
    const e = g.matrix.elements;
    const p = m.camera.projectionMatrix.elements;
    const [x, y, z] = [e[12], e[13], e[14]];
    const cx = p[0] * x + p[4] * y + p[8] * z + p[12];
    const cy = p[1] * x + p[5] * y + p[9] * z + p[13];
    const cw = p[3] * x + p[7] * y + p[11] * z + p[15];
    if (!cw) return null;
    return { x: (cx / cw + 1) / 2, y: (1 - cy / cw) / 2 };
  }

  // 따라가는 포스터가 화면 가장자리에 걸려 있기만 하면(가운데는 다른 포스터) 놓아준다
  _checkEdges() {
    if (!this.visible.size || !this.autoRelease?.()) return;
    const now = performance.now();
    for (const i of this.visible) {
      const c = this.screenCenter(i);
      const off = c && (c.x < EDGE.x || c.x > 1 - EDGE.x || c.y < EDGE.y || c.y > 1 - EDGE.y);
      if (!off) {
        this.offSince[i] = 0;
        continue;
      }
      if (!this.offSince[i]) this.offSince[i] = now;
      if (now - this.offSince[i] > OFF_CENTER_MS) {
        this.offSince[i] = 0;
        this.release(i);
      }
    }
  }

  // 카메라 화면이 다시 보일 때 크기를 다시 잰다(숨겨진 사이 창 크기가 바뀌었을 수 있다)
  resize() {
    if (this.running && !this.dead) this.mindar?.resize();
  }

  // 대상 i의 실제 크기 비율(높이/폭). 앵커 공간에서 폭 1 = 대상 폭
  aspect(i) {
    const d = this.mindar?.controller?.markerDimensions?.[i];
    return d ? d[1] / d[0] : 1.438;
  }

  isVisible(i) {
    return this.visible.has(i);
  }

  fail(err) {
    if (this.dead) return;
    this.stop();
    this.onFail?.(err);
  }

  stop() {
    if (this.dead) return;
    this.dead = true;
    this.running = false;
    window.removeEventListener('unhandledrejection', this.failHandler);
    window.removeEventListener('error', this.failHandler);
    if (this.entry) {
      this.entry.users = Math.max(0, this.entry.users - 1);
      this.entry.listener = null;
    }
    const m = this.mindar;
    if (m) {
      const c = m.controller;
      try {
        c?.stopProcessVideo();
      } catch {}
      // 처리 루프가 워커 답을 기다리는 중일 수 있어 잠시 뒤에 워커를 끝내고 텐서를 놓는다
      if (c) {
        setTimeout(() => {
          try {
            c.worker?.terminate();
          } catch {}
          const t = c.tracker;
          const held = [t?.featurePointsListT, t?.imagePixelsListT, t?.imagePropertiesListT];
          // 검출기가 처음 쓸 때 만들어 붙잡아 두는 텐서(tensorCaches)도 놓는다
          for (const cache of Object.values(c.cropDetector?.detector?.tensorCaches ?? {})) held.push(Object.values(cache ?? {}));
          for (const list of held) {
            for (const x of list ?? []) {
              try {
                x?.dispose?.();
              } catch {}
            }
          }
        }, 1500);
      }
      try {
        m.renderer.setAnimationLoop(null);
        m.renderer.dispose();
        m.renderer.forceContextLoss?.();
      } catch {}
      m.renderer?.domElement.remove();
      m.cssRenderer?.domElement?.remove();
      // window resize에 묶인 함수가 이 객체를 붙잡고 있어서 무거운 것은 끊어 둔다
      m.scene = m.renderer = m.cssRenderer = m.video = null;
      m.anchors = [];
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.stream = null;
    this.video = null;
    for (const s of this.styles) s.remove();
    this.styles = [];
    this.frameHooks.clear();
    this.visible.clear();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }
}
