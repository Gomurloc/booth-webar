# UNMUTE 메인 포스터 애니메이션(UNMUTE 팀 연출안, 2026-11-16 둘째 판: "흑백 세상을 두 캐릭터가 컬러로 바꾼다"를 또렷하게)
# 흐름
# 1) 포스터 그대로 → 화면 바깥부터 원형으로 흑백이 안쪽으로(배경만). 흑백 세상은 어둡고 먹먹하게(네온이 꺼진 듯), 캐릭터는 컬러 + 옅은 색 테
# 2) 흑백이 다 덮이면 두 손(소녀의 뻗은 손바닥, 소년의 브이 손)에서 색이 두 번 맥박처럼 새어 나왔다 꺼진다
# 3) 두 손에서 컬러 파동이 터져 바깥으로(소녀 쪽 분홍, 소년 쪽 하늘색 물결 테). 지나간 자리는 원래보다 쨍했다가(채도·밝기·빛 번짐) 원래 색으로
#    제목 UNMUTE는 파동이 닿으면 네온처럼 깜빡이며 켜진다
# 4) 컬러인 채로 박자에 맞춰 글리치 → 5) 포스터 그대로로 돌아와 반복(처음 장면 = 끝 다음 장면 = 포스터)
# 소리(만든 것): 처음엔 밝은 소리 → 흑백이 덮이며 먹먹해지고 작아짐 → 심장 소리 두 번 + 올라가는 소리 → 터질 때 쿵 + 화음 → 박자 → 글리치 때 끊김
# 시간·세기·손 자리(아래 T, HANDS, GLITCH 등)는 연출안에 없던 것이라 이쪽에서 정했다
# 입력: 포스터 원본(Poster_B2_MP3_Main.png, 2782x4000), 캐릭터 가리개(tools/unmute_mask.png, 흰색 = 캐릭터)
#       가리개는 rembg(isnet-anime)로 딴 뒤 아래 디제이 장비를 배경으로 뺐다(README "UNMUTE 포스터 애니메이션")
# 출력: 720x1036 영상(소리 포함, x264 거의 무손실) + 확인용 장면 모음(<out>_sheet.jpg)
# 쓰는 법: python tools/make_unmute_anim.py <Poster_B2_MP3_Main.png> tools/unmute_mask.png <out.mp4>
#         node tools/encode_video.mjs <out.mp4> video/unmute.mp4 --wh 720x1036 --gop 10 --kbps 2400
import os
import subprocess
import sys
import tempfile
import wave

import cv2
import numpy as np
from scipy.signal import lfilter

POSTER, MASK, OUT = sys.argv[1:4]
OW, OH = 720, 1036
FPS = 24

# 시간표(초)
T = {
    'hold0': 0.4,    # 포스터 그대로
    'gray': 1.8,     # 흑백 원이 바깥에서 안으로
    'muted': 1.0,    # 흑백 세상. 두 손에서 색이 두 번 새어 나왔다 꺼짐
    'wave': 2.0,     # 두 손에서 컬러 파동(지나간 자리는 쨍하게 → 원래 색)
    'color': 0.4,    # 컬러
    'glitch': 2.6,   # 박자 맞춘 글리치
    'hold3': 0.9,    # 포스터 그대로(반복 이음매)
}
DUR = sum(T.values())
N = int(round(DUR * FPS))
t_gray0 = T['hold0']
t_muted0 = t_gray0 + T['gray']
t_wave0 = t_muted0 + T['muted']
t_color0 = t_wave0 + T['wave']
t_gl0 = t_color0 + T['color']
t_hold3 = t_gl0 + T['glitch']
PULSES = [t_muted0 + 0.2, t_muted0 + 0.62]  # 손에서 색이 새어 나오는 때(심장 소리와 같이)
BPM = 120
BEAT = 60 / BPM  # 터진 뒤 박자(소리와 글리치를 맞춘다)
# 글리치: 터진 때부터 박자 위(박자 번호, 길이 초, 세기)
GLITCH = [(5, 0.12, 0.8), (6, 0.08, 1.0), (7, 0.30, 0.9), (8, 0.08, 1.0), (9, 0.28, 0.65)]

# 두 손(720x1036 기준 픽셀)과 물결 테 색(BGR)
HANDS = [
    {'xy': (130, 640), 'tint': (190, 80, 255)},   # 소녀 뻗은 손바닥: 분홍
    {'xy': (628, 612), 'tint': (255, 210, 90)},   # 소년 브이 손: 하늘색
]
TITLE = (86, 88, 620, 222)  # 제목 UNMUTE + THE VIVID WORLD 자리(x0, y0, x1, y1)

src = cv2.imread(POSTER)
P = cv2.resize(src, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32)
m = cv2.imread(MASK, cv2.IMREAD_GRAYSCALE)
CH = cv2.resize(m, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255  # 캐릭터 1
Y = (0.0722 * P[..., 0] + 0.7152 * P[..., 1] + 0.2126 * P[..., 2])
# 흑백 세상: 밝기만 남기고 대비를 줄여 어둡게(네온이 꺼진 듯 먹먹하게)
GM = (Y.mean() + (Y - Y.mean()) * 0.82) * 0.74
G = np.repeat(GM[..., None], 3, 2)
# 쨍한 세상: 채도 1.5배, 밝기 6%, 밝은 네온에 빛 번짐
Y3 = Y[..., None]
VIVID = np.clip((Y3 + (P - Y3) * 1.5) * 1.06, 0, 255)
BLOOM = cv2.GaussianBlur(np.clip(P - 150, 0, None) * 1.6, (0, 0), 14)
# 캐릭터 색 테(흑백 세상에 캐릭터 둘레로 번지는 색): 캐릭터 그림을 크게 흐려 캐릭터 밖에만
HALO = cv2.GaussianBlur(VIVID * CH[..., None], (0, 0), 16) * (1 - CH[..., None])

yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
w = CH.sum()
CX = float((CH * xx).sum() / w)
CY = float((CH * yy).sum() / w)
R = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
RMAX = float(R.max()) + 8
RH = [np.sqrt((xx - h['xy'][0]) ** 2 + (yy - h['xy'][1]) ** 2) for h in HANDS]
RHMAX = max(float(r.max()) for r in RH) + 8
tx0, ty0, tx1, ty1 = TITLE
TM = np.zeros((OH, OW), np.float32)
TM[ty0:ty1, tx0:tx1] = 1
TM = cv2.GaussianBlur(TM, (0, 0), 6)
TITLE_DIST = min(float(np.sqrt(((tx0 + tx1) / 2 - h['xy'][0]) ** 2 + ((ty0 + ty1) / 2 - h['xy'][1]) ** 2)) for h in HANDS)
print(f'{DUR:.2f}초 {N}장, 원 가운데 ({CX:.0f}, {CY:.0f}), 터짐 {t_wave0:.2f}초, 글리치 {t_gl0:.2f}~{t_hold3:.2f}초')


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = np.clip(x, 0, 1)
    return 1 - (1 - x) ** 3


EDGE = 10.0


def compose(color_amt, base=None, halo=0.0):
    # color_amt: 배경이 컬러인 정도(장소마다 0~1). 캐릭터는 늘 컬러. halo: 흑백 위 캐릭터 색 테 세기
    base = P if base is None else base
    a = np.maximum(color_amt, CH)[..., None]
    gray = G + HALO * halo if halo else G
    return base * a + gray * (1 - a)


def disk(r, dist):
    return np.clip((r - dist) / EDGE + 0.5, 0, 1)


def ripple(img, cx, cy, dist, r0, amp):
    d = dist - r0
    wv = amp * np.sin(d / 9.0) * np.exp(-((d + 8) / 26.0) ** 2) * (1 - CH)
    ux = (xx - cx) / (dist + 1e-3)
    uy = (yy - cy) / (dist + 1e-3)
    return cv2.remap(img.astype(np.float32), (xx - ux * wv).astype(np.float32), (yy - uy * wv).astype(np.float32),
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def frame_gray(t):
    k = (t - t_gray0) / T['gray']
    r = RMAX * (1 - smooth(k))
    return compose(disk(r, R), halo=smooth(k) * 0.9)


def frame_muted(t):
    amt = np.zeros((OH, OW), np.float32)
    ring_img = 0
    for tp in PULSES:
        s = t - tp
        if 0 <= s < 0.42:
            rp = 30 + 110 * ease_out(s / 0.42)
            fade = (1 - s / 0.42) ** 1.5
            for h, dist in zip(HANDS, RH):
                amt = np.maximum(amt, disk(rp, dist) * fade)
                ring = np.exp(-((dist - rp) / 6.0) ** 2) * fade * 0.9 * (1 - CH)
                ring_img = ring_img + ring[..., None] * np.array(h['tint'], np.float32)
    img = compose(amt, base=VIVID, halo=0.9)
    return img + ring_img


def flicker_on(s):
    # 제목 네온이 켜지는 모양(파동이 닿은 뒤 s초): 켜짐·꺼짐을 몇 번 오가다 켜진 채로
    seq = [(0.00, 1), (0.06, 0), (0.12, 1), (0.16, 0), (0.25, 1), (0.29, 0.35), (0.33, 1)]
    v = 0.0
    for a, val in seq:
        if s >= a:
            v = val
    return v


def frame_wave(t):
    k = (t - t_wave0) / T['wave']
    e = ease_out(min(1.0, k / 0.75))  # 파동은 1.5초 안에 화면 끝까지
    r = RHMAX * e
    inside = np.zeros((OH, OW), np.float32)
    for dist in RH:
        inside = np.maximum(inside, disk(r, dist))
    # 제목: 파동이 닿기 전엔 흑백, 닿으면 네온처럼 깜빡이며 켜진다
    s_title = (r - TITLE_DIST) / (RHMAX * 0.9) * T['wave'] * 0.75 if r > TITLE_DIST else -1
    tv = flicker_on(s_title) if s_title >= 0 else 0.0
    inside = inside * (1 - TM) + tv * TM
    # 지나간 자리는 쨍하게 → 원래 색으로(터진 뒤 1.6초에 걸쳐)
    vivid_k = float(np.exp(-max(0.0, t - t_wave0) / 0.7))
    base = P + (VIVID - P) * vivid_k + BLOOM * (0.35 + 0.65 * vivid_k)
    img = compose(inside, base=base, halo=0.9 * (1 - e))
    amp = 9.0 * (1 - e) ** 0.6
    for h, dist in zip(HANDS, RH):
        img = ripple(img, h['xy'][0], h['xy'][1], dist, r, amp)
        ring = np.exp(-((dist - r) / 7.0) ** 2) * (1 - CH) * 0.55 * (1 - e)
        img = img + ring[..., None] * np.array(h['tint'], np.float32)
    # 터지는 순간 번쩍(4장)
    fl = max(0.0, 1 - (t - t_wave0) * FPS / 4)
    img = img + 70 * fl
    # 빛 번짐은 터진 뒤 줄었다가 컬러 구간 끝에 0
    return img


def frame_color(t):
    k = (t - t_color0) / T['color']
    vivid_k = float(np.exp(-max(0.0, t - t_wave0) / 0.7))
    return P + (VIVID - P) * vivid_k + BLOOM * 0.35 * (1 - smooth(k))


def glitch(img, s, seed):
    r = np.random.default_rng(seed)
    out = img.copy()
    for _ in range(int(4 + 6 * s)):
        h = int(r.integers(3, 48))
        y0 = int(r.integers(0, OH - h))
        dx = int(r.choice([-1, 1]) * r.integers(6, int(8 + 36 * s)))
        out[y0:y0 + h] = np.roll(out[y0:y0 + h], dx, axis=1)
    k = int(round(2 + 6 * s))
    b, rch = out[..., 0].copy(), out[..., 2].copy()
    out[..., 2] = np.roll(rch, k, axis=1)
    out[..., 0] = np.roll(b, -k, axis=1)
    for _ in range(int(2 + 4 * s)):
        bw, bh = int(r.integers(24, 120)), int(r.integers(6, 30))
        x0, y0 = int(r.integers(0, OW - bw)), int(r.integers(0, OH - bh))
        sx = int(np.clip(x0 + r.integers(-60, 60), 0, OW - bw))
        out[y0:y0 + bh, x0:x0 + bw] = out[y0:y0 + bh, sx:sx + bw]
    out[::2] *= 1 - 0.10 * s
    return out


GL_ABS = [(t_wave0 + b * BEAT, d, s) for b, d, s in GLITCH]


def frame_glitch(t):
    f = P
    for j, (a, d, s) in enumerate(GL_ABS):
        if a <= t < a + d:
            f = glitch(P, s, 1000 * j + int((t - a) * FPS) // 2)
            break
    return f


frames = []
for i in range(N):
    t = i / FPS
    if t < t_gray0:
        f = P
    elif t < t_muted0:
        f = frame_gray(t)
    elif t < t_wave0:
        f = frame_muted(t)
    elif t < t_color0:
        f = frame_wave(t)
    elif t < t_gl0:
        f = frame_color(t)
    elif t < t_hold3:
        f = frame_glitch(t)
    else:
        f = P
    frames.append(np.clip(np.rint(f), 0, 255).astype(np.uint8))

# ── 소리 ──
SR = 48000
ts = np.arange(int(N / FPS * SR)) / SR
rng = np.random.default_rng(3)
db = lambda v: 10 ** (v / 20)


def env(t0, a, d, length):
    e = np.zeros_like(ts)
    i0 = int(t0 * SR)
    n = int(length * SR)
    tt = np.arange(n) / SR
    seg = np.minimum(1, tt / max(a, 1e-3)) * np.exp(-tt / d)
    e[i0:i0 + n] = seg[: max(0, len(ts) - i0)]
    return e


def lowpass(x, cutoff):
    # 1차 저역 통과. cutoff가 수 하나면 빠른 필터, 배열(샘플마다 Hz)이면 시간마다 바뀌는 필터
    if np.isscalar(cutoff):
        a = 1 - np.exp(-2 * np.pi * cutoff / SR)
        return lfilter([a], [1, -(1 - a)], x)
    y = np.zeros_like(x)
    a = 1 - np.exp(-2 * np.pi * cutoff / SR)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def saw(f, t):
    return 2 * ((t * f) % 1) - 1


# 화음(C#m add9 계열): 흑백 전엔 밝게, 덮이며 먹먹하게, 터진 뒤 다시 밝게
CHORD = [138.6, 164.8, 207.7, 277.2, 311.1]
pad = sum(saw(f * (1 + 0.002 * j), ts) for j, f in enumerate(CHORD)) / len(CHORD)
tt = ts
c = np.where(tt < t_gray0, 5000.0,
             np.where(tt < t_muted0, 5000.0 * (1 - smooth((tt - t_gray0) / T['gray'])) + 350.0 * smooth((tt - t_gray0) / T['gray']),
                      np.where(tt < t_wave0, 350.0, 6000.0)))
g = np.where(tt < t_gray0, 1.0,
             np.where(tt < t_muted0, 1 - 0.65 * smooth((tt - t_gray0) / T['gray']),
                      np.where(tt < t_wave0, 0.35, 1.0)))
pad_l = lowpass(pad, c) * g * db(-9)  # 처음 밝은 소리가 들려야 먹먹해지는 게 들린다
# 터진 뒤 화음은 짧게 찌르고 박자마다 다시(스타브)
stab_env = np.zeros_like(ts)
for b in range(0, 10):
    tb = t_wave0 + b * BEAT
    if tb < t_hold3:
        stab_env += env(tb, 0.004, 0.18 if b else 0.9, 1.2) * (1.0 if b == 0 else 0.55)
after = (ts >= t_wave0).astype(np.float32)
pad_mix = pad_l * (1 - after) + lowpass(pad, 5200.0) * stab_env * db(-16) * after
# 끝에서 줄어든다
fade_out = np.clip((t_hold3 + 0.6 - ts) / 0.9, 0, 1)
pad_mix *= fade_out
# 심장 소리(먹먹한 쿵) 두 번
kick = np.zeros_like(ts)


def add_kick(t0, level, f0=95, f1=42, dec=0.22):
    global kick
    i0 = int(t0 * SR)
    n = int(0.5 * SR)
    tt_ = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-tt_ / 0.04)
    ph = 2 * np.pi * np.cumsum(f) / SR
    seg = np.sin(ph) * np.exp(-tt_ / dec) * level
    kick[i0:i0 + n] += seg[: max(0, len(ts) - i0)]


for tp in PULSES:
    add_kick(tp, db(-10), 80, 38, 0.25)
# 올라가는 소리(바람·잡음이 위로): 터지기 0.7초 전부터
noise = rng.standard_normal(len(ts))
riser_k = np.clip((ts - (t_wave0 - 0.7)) / 0.7, 0, 1) * (ts < t_wave0)
riser = lowpass(noise, 300 + 6000 * riser_k ** 2) * riser_k ** 2 * db(-14)
# 터지는 순간: 깊은 쿵 + 쉬익
add_kick(t_wave0, db(-4), 120, 32, 0.55)
crash = lowpass(noise, 9000.0) - lowpass(noise, 2500.0)
crash = crash * env(t_wave0, 0.002, 0.45, 2.0) * db(-12)
# 박자: 쿵(정박)·칙(엇박) 터진 뒤부터 글리치 끝까지
hat = np.zeros_like(ts)
hiss = noise - lowpass(noise, 6000.0)
for b in range(1, 12):
    tb = t_wave0 + b * BEAT
    if tb < t_hold3 - 0.05:
        add_kick(tb, db(-9), 110, 45, 0.16)
        th = tb + BEAT / 2
        if th < t_hold3 - 0.05:
            hat += hiss * env(th, 0.001, 0.035, 0.15) * db(-18)
mix = pad_mix + kick + riser + crash + hat
# 글리치 때 소리도 끊긴다: 짧은 조각 되풀이
for a, d, s in GL_ABS:
    i0 = int(a * SR)
    n = int(d * SR)
    sl = max(1, int(SR * (0.03 if s > 0.85 else 0.05)))
    piece = mix[i0:i0 + sl].copy()
    for j in range(i0, min(len(mix), i0 + n), sl):
        mix[j:j + sl] = piece[: len(mix[j:j + sl])]
mix *= db(-3) / (np.abs(mix).max() + 1e-9)
pcm = (np.clip(np.stack([mix, mix], 1), -1, 1) * 32767).astype(np.int16)
tmpwav = os.path.join(tempfile.mkdtemp(), 'unmute.wav')
with wave.open(tmpwav, 'wb') as wf:
    wf.setnchannels(2)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes(pcm.tobytes())
print('소리 평균', round(20 * np.log10(np.sqrt((mix ** 2).mean()) + 1e-9), 1), 'dBFS')

p = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                      '-i', tmpwav, '-map', '0:v', '-map', '1:a',
                      '-c:v', 'libx264', '-crf', '8', '-preset', 'slow', '-pix_fmt', 'yuv420p',
                      '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                      '-c:a', 'aac', '-b:a', '320k', '-shortest', OUT], stdin=subprocess.PIPE)
for f in frames:
    p.stdin.write(f.tobytes())
p.stdin.close()
assert p.wait() == 0
stem = os.path.splitext(OUT)[0]
idx = list(range(0, N, 6))
th = [cv2.resize(frames[i], (180, 259), interpolation=cv2.INTER_AREA) for i in idx]
for j, i in enumerate(idx):
    cv2.putText(th[j], f'{i / FPS:.2f}', (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
cols = 10
while len(th) % cols:
    th.append(np.zeros_like(th[0]))
sheet = np.vstack([np.hstack(th[r * cols:(r + 1) * cols]) for r in range(len(th) // cols)])
cv2.imwrite(stem + '_sheet.jpg', sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
print('결과', OUT, N, '장', f'{N / FPS:.2f}초')
