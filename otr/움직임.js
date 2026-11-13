// 살아 있는 캐릭터: 캐릭터마다 짧은 반복 영상(숨쉬기·머리카락 흔들림)을 PNG 대신 쓴다.
//
// 영상 형식(tools/make_alpha_loop.py가 만든다): H.264 mp4 한 줄에 위 절반은 색, 아래 절반은 알파(회색).
// 알파 채널이 있는 영상(WebM VP9 알파·HEVC 알파)은 iOS·안드로이드 둘 다에서 되는 것이 없어서 이렇게 쌓는다.
// 캔버스(그림 판) 크기·발 자리는 같은 이름 PNG와 같아서 캐릭터.json의 발·머리 값이 그대로 맞는다.
//
// 그리는 길
// - 미리보기: WebGL 한 번에 영상 프레임 → 색·알파 합치기(0.8배로 무르게) → 색 맞춤 표·채도·빛 번짐·입자감까지 칠한다.
//   합성기의 CPU 칠하기(getImageData → 픽셀 처리)와 같은 식이고, 프레임마다 돌아도 가볍다.
// - 촬영: 지금 프레임을 원래 해상도로 풀어(rawFrame) PNG와 똑같이 CPU 합성기에 넣는다(사진은 기존 경로 그대로).
// - 영상이 아직 안 왔거나, WebGL·영상 재생이 안 되면 PNG를 그대로 쓴다(앱은 그대로 돈다).

const VERT = `
attribute vec2 p;
varying vec2 v;
void main() {
  v = p;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;`;

// 1단: 쌓인 영상 → 색 + 알파(곧은 알파). flip이면 좌우 반전, taps>1이면 4점 평균(크게 줄일 때 계단 방지).
// sub(xy 시작, zw 크기, 캐릭터 상자 기준 0..1): 그 부분만 칠한다(화면 밖으로 크게 나간 캐릭터)
const DECODE = `${HEAD}
uniform sampler2D vid;
uniform float flip;
uniform float premul;
uniform vec2 spread;
uniform float halfPx;
uniform vec4 sub;
vec4 at(vec2 uv) {
  float y = clamp(uv.y, halfPx, 1.0 - halfPx);
  vec3 c = texture2D(vid, vec2(uv.x, y * 0.5)).rgb;
  float a = texture2D(vid, vec2(uv.x, 0.5 + y * 0.5)).g;
  return vec4(c, a);
}
void main() {
  vec2 b = sub.xy + v * sub.zw;
  vec2 uv = vec2(flip > 0.5 ? 1.0 - b.x : b.x, b.y);
  vec4 s;
  if (spread.x > 0.0) {
    s = 0.25 * (at(uv + vec2(-spread.x, -spread.y)) + at(uv + vec2(spread.x, -spread.y)) + at(uv + vec2(-spread.x, spread.y)) + at(uv + spread));
  } else {
    s = at(uv);
  }
  // 압축 잡음으로 생긴 옅은 알파를 지운다(0.02로는 AI 반복 영상 바탕에 옅은 네모 자국이 남아 0.06으로 올림)
  s.a = clamp((s.a - 0.06) / 0.94, 0.0, 1.0);
  gl_FragColor = premul > 0.5 ? vec4(s.rgb * s.a, s.a) : s;
}`;

// 2단: 색 맞춤(색.js applyHarmonize와 같은 순서·식): 채널 표 → 채도 → 빛 번짐(스크린) → 입자감(오버레이). 출력은 곱한 알파
const LOOK = `${HEAD}
uniform sampler2D img;
uniform sampler2D lut;
uniform sampler2D edge;
uniform sampler2D wrap;
uniform sampler2D noise;
uniform float sat;
uniform float wrapA;
uniform float grainA;
uniform float flip;
uniform vec2 noiseOff;
uniform vec2 imgScale;
uniform vec4 sub;
float ov(float b, float n) { return b < 0.5 ? 2.0 * b * n : 1.0 - 2.0 * (1.0 - b) * (1.0 - n); }
void main() {
  vec4 s = texture2D(img, vec2(v.x, 1.0 - v.y) * imgScale);
  if (s.a <= 0.002) { gl_FragColor = vec4(0.0); return; }
  vec2 b = sub.xy + v * sub.zw; // 캐릭터 상자 기준 자리(가장자리 띠·빛 번짐 배경은 상자 전체 그림)
  vec3 i = floor(clamp(s.rgb, 0.0, 1.0) * 255.0 + 0.5);
  vec3 c = vec3(
    texture2D(lut, vec2((i.r + 0.5) / 256.0, 0.5)).r,
    texture2D(lut, vec2((i.g + 0.5) / 256.0, 0.5)).g,
    texture2D(lut, vec2((i.b + 0.5) / 256.0, 0.5)).b);
  float y = dot(c, vec3(54.0, 183.0, 19.0) / 256.0);
  c = y + (c - y) * sat;
  if (wrapA > 0.0) {
    float t = texture2D(edge, vec2(flip > 0.5 ? 1.0 - b.x : b.x, b.y)).a * wrapA;
    c += texture2D(wrap, b).rgb * (1.0 - c) * t;
  }
  if (grainA > 0.0) {
    float n = texture2D(noise, (gl_FragCoord.xy + noiseOff) / 128.0).r;
    c += (vec3(ov(c.r, n), ov(c.g, n), ov(c.b, n)) - c) * grainA;
  }
  c = clamp(c, 0.0, 1.0);
  gl_FragColor = vec4(c * s.a, s.a);
}`;

const FULL_SUB = { x: 0, y: 0, w: 1, h: 1 };

// 판 크기 늘리기(합성.js growTo와 같은 식): 지금보다 25% 넘게, 64px 단위
function growTo(cur, need) {
  return need <= cur ? cur : Math.ceil(Math.max(need, cur * 1.25) / 64) * 64;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('셰이더: ' + gl.getShaderInfoLog(s));
  return s;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('셰이더 연결: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

// WebGL 한 판을 캐릭터들이 같이 쓴다. 그린 직후(같은 작업 안에서) 부르는 쪽이 canvas를 2D 캔버스로 옮겨 담는다
export class AnimGL {
  constructor() {
    this.ok = false;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2;
    this.canvas.height = 2;
    try {
      const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL 없음');
      this.gl = gl;
      this.decode = program(gl, DECODE);
      this.look = program(gl, LOOK);
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      this.fbTex = this.texture(gl.LINEAR);
      this.fb = gl.createFramebuffer();
      this.fbSize = { w: 0, h: 0 };
      this.noiseTex = null;
      this.white = this.texture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.ok = false; // 그 뒤로는 PNG(CPU 경로)
      });
      this.ok = true;
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.ok = false;
    }
  }

  texture(filter, repeat = false) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }

  upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // 캐릭터마다 붙는 텍스처(영상·가장자리 띠·빛 번짐 배경·색 표)
  slot(owner) {
    if (!owner.__gl || owner.__gl.ctx !== this) {
      const gl = this.gl;
      owner.__gl = {
        ctx: this,
        vid: this.texture(gl.LINEAR),
        vidFrame: -1,
        edge: null,
        wrap: this.texture(gl.LINEAR),
        lut: this.texture(gl.NEAREST),
      };
    }
    return owner.__gl;
  }

  setNoise(noiseCanvas) {
    if (this.noiseTex || !this.ok) return;
    this.noiseTex = this.texture(this.gl.NEAREST, true);
    this.upload(this.noiseTex, noiseCanvas);
  }

  // 영상 프레임이 바뀌었을 때만 올린다
  bindVideo(anim) {
    const s = this.slot(anim);
    if (s.vidFrame !== anim.frameId) {
      this.upload(s.vid, anim.source);
      s.vidFrame = anim.frameId;
    }
    return s;
  }

  draw(prog, w, h, fb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // AR에서는 캐릭터 크기가 프레임마다 바뀐다. 판을 매번 새로 잡지 않게 늘리기만 하고(25% 넘게, 64px 단위) 왼쪽 아래 w×h만 쓴다
  resize(w, h) {
    if (this.canvas.width >= w && this.canvas.height >= h) return;
    this.grows = (this.grows ?? 0) + 1; // 시험·디버그: 판을 다시 잡은 횟수
    if (this.canvas.width < w) this.canvas.width = growTo(this.canvas.width, w);
    if (this.canvas.height < h) this.canvas.height = growTo(this.canvas.height, h);
  }

  // 그린 자리(캔버스 좌표, 왼쪽 위 기준): WebGL은 왼쪽 아래부터 그리므로 아래쪽 h줄
  region(w, h) {
    return { canvas: this.canvas, sx: 0, sy: this.canvas.height - h, w, h };
  }

  decodeInto(anim, w, h, { flip, premul, fb, sub = null }) {
    const gl = this.gl;
    const s = this.bindVideo(anim);
    const P = this.decode;
    const r = sub ?? FULL_SUB;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.vid);
    gl.uniform1i(P.u.vid, 0);
    gl.uniform1f(P.u.flip, flip ? 1 : 0);
    gl.uniform1f(P.u.premul, premul ? 1 : 0);
    gl.uniform1f(P.u.halfPx, 0.5 / anim.halfH);
    gl.uniform4f(P.u.sub, r.x, r.y, r.w, r.h);
    // 원본보다 1.5배 넘게 줄이면 4점 평균(밉맵 없이 계단 줄이기). sub면 상자 전체 높이(h / sub.h) 기준
    const ratio = (anim.halfH * r.h) / h;
    if (ratio > 1.5) gl.uniform2f(P.u.spread, (0.25 * ratio) / anim.halfW, (0.25 * ratio) / anim.halfH);
    else gl.uniform2f(P.u.spread, 0, 0);
    this.draw(P, w, h, fb);
  }

  // 미리보기 한 장: anim의 지금 프레임을 w×h로 칠한다(sub가 있으면 상자의 그 부분만 w×h로).
  // look: { sub, luts:[3×Uint8Array], lutKey, sat, wrapAlpha, wrapCanvas, wrapKey, edgeCanvas, grain, softness, flip, noise }
  // 반환: 그린 자리 { canvas, sx, sy, w, h }(같은 작업 안에서 바로 옮겨 담아야 한다) 또는 null
  render(anim, w, h, look) {
    if (!this.ok || !anim.ready) return null;
    const gl = this.gl;
    const s = this.slot(anim);
    if (look.noise) this.setNoise(look.noise);
    if (look.edgeCanvas && s.edgeOf !== look.edgeCanvas) {
      s.edge = s.edge ?? this.texture(gl.LINEAR);
      this.upload(s.edge, look.edgeCanvas);
      s.edgeOf = look.edgeCanvas;
    }
    if (look.lutKey !== s.lutKey) {
      const data = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        data[i * 4] = look.luts[0][i];
        data[i * 4 + 1] = look.luts[1][i];
        data[i * 4 + 2] = look.luts[2][i];
        data[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, s.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      s.lutKey = look.lutKey;
    }
    if (look.wrapCanvas && look.wrapKey !== s.wrapKey) {
      this.upload(s.wrap, look.wrapCanvas);
      s.wrapKey = look.wrapKey;
    }
    // 1단: 0.8배로 풀어 둔다(카메라만큼 무르게)
    const sw = Math.max(2, Math.round(w * look.softness));
    const sh = Math.max(2, Math.round(h * look.softness));
    if (this.fbSize.w < sw || this.fbSize.h < sh) {
      const fw = growTo(this.fbSize.w, sw);
      const fh = growTo(this.fbSize.h, sh);
      gl.bindTexture(gl.TEXTURE_2D, this.fbTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fbTex, 0);
      this.fbSize = { w: fw, h: fh };
    }
    const sub = look.sub ?? FULL_SUB;
    this.decodeInto(anim, sw, sh, { flip: look.flip, premul: false, fb: this.fb, sub });
    // 2단: 색 맞춤
    this.resize(w, h);
    const P = this.look;
    gl.useProgram(P.p);
    gl.uniform4f(P.u.sub, sub.x, sub.y, sub.w, sub.h);
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.u[name], unit);
    };
    bind(0, this.fbTex, 'img');
    bind(1, s.lut, 'lut');
    bind(2, s.edge ?? this.white, 'edge');
    bind(3, s.wrap, 'wrap');
    bind(4, this.noiseTex ?? this.white, 'noise');
    gl.uniform1f(P.u.sat, look.sat);
    gl.uniform1f(P.u.wrapA, look.wrapCanvas && s.edge ? look.wrapAlpha : 0);
    gl.uniform1f(P.u.grainA, this.noiseTex ? look.grain : 0);
    gl.uniform1f(P.u.flip, look.flip ? 1 : 0);
    gl.uniform2f(P.u.noiseOff, Math.random() * 128, Math.random() * 128);
    gl.uniform2f(P.u.imgScale, sw / this.fbSize.w, sh / this.fbSize.h);
    this.draw(P, w, h, null);
    gl.activeTexture(gl.TEXTURE0);
    return this.region(w, h);
  }

  // 촬영용: 지금 프레임을 원래 해상도 그대로(색 맞춤 없이, 곱한 알파) 2D 캔버스로 돌려준다
  rawFrame(anim) {
    if (!this.ok || !anim.ready) return null;
    const w = anim.halfW;
    const h = Math.round(anim.halfH);
    this.resize(w, h);
    this.decodeInto(anim, w, h, { flip: false, premul: true, fb: null });
    const r = this.region(w, h);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(r.canvas, r.sx, r.sy, w, h, 0, 0, w, h);
    return out;
  }
}

// 정지 그림(PNG)을 같은 꼴(위 색·아래 알파)로 쌓아 GPU 경로에 넣는다. 포스터 AR에서는 캐릭터 크기가 프레임마다 바뀌어
// CPU 칠하기(getImageData)가 0.1초마다 돌면 폰이 버벅인다. 반복 영상이 아직 안 왔을 때도 이것을 쓴다(촬영은 PNG 그대로)
export class StillSprite {
  constructor(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h * 2;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const top = g.getImageData(0, 0, w, h);
    const bottom = g.createImageData(w, h);
    for (let i = 0; i < top.data.length; i += 4) {
      const a = top.data[i + 3];
      bottom.data[i] = a;
      bottom.data[i + 1] = a;
      bottom.data[i + 2] = a;
      bottom.data[i + 3] = 255;
      top.data[i + 3] = 255; // 색은 곧은 값 그대로(PNG의 투명 부분에도 가장자리 색이 번져 있다)
    }
    g.putImageData(top, 0, 0);
    g.putImageData(bottom, 0, h);
    this.source = c;
    this.halfW = w;
    this.halfH = h;
    this.frameId = 1;
    this.ready = true;
    this.still = true;
    this.failed = false;
  }

  tick() {}
}

// 캐릭터 하나의 반복 영상. 화면 밖 작은 <video>로 재생한다(iOS는 문서에 붙은 영상이어야 프레임을 내준다)
export class AnimSprite {
  constructor(url, { loop = true, fps = 24 } = {}) {
    Object.assign(this, { url, loop, fps });
    this.video = null;
    this.frameId = 0;
    this.failed = false;
    this.started = false;
    this.lastT = -1;
    this.lastPoll = 0;
  }

  get source() {
    return this.video;
  }

  get ready() {
    const v = this.video;
    return !this.failed && !!v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0 && this.frameId > 0;
  }

  get halfW() {
    return this.video.videoWidth;
  }

  get halfH() {
    return this.video.videoHeight / 2;
  }

  start(holder) {
    if (this.started) return;
    this.started = true;
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.loop = this.loop;
    v.preload = 'auto';
    v.setAttribute('aria-hidden', 'true');
    v.addEventListener('error', () => {
      this.failed = true;
    });
    this.video = v;
    holder.append(v);
    v.src = this.url;
    const onFrame = () => {
      this.frameId++;
      v.requestVideoFrameCallback(onFrame);
    };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(onFrame);
    else this.poll = true;
    v.addEventListener('loadeddata', () => {
      if (this.poll) this.frameId++;
    });
    this.kick();
  }

  // 재생을 (다시) 건다. iOS 저전력 모드는 소리 없는 영상도 자동 재생을 막아서 첫 탭에서 다시 부른다
  kick() {
    this.video?.play?.().catch(() => {});
  }

  // requestVideoFrameCallback이 없는 브라우저: 재생 시각이 바뀌면 새 프레임으로 본다
  tick(now) {
    if (!this.poll || !this.video || now - this.lastPoll < 1000 / this.fps / 2) return;
    this.lastPoll = now;
    const t = this.video.currentTime;
    if (t !== this.lastT) {
      this.lastT = t;
      this.frameId++;
    }
  }

  stop() {
    if (!this.video) return;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    this.video = null;
  }
}
