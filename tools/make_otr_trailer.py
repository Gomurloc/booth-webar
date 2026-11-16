# OFF THE RECORD 포스터 영상 "예고편"(2026-11-16): 포스터 → 불이 꺼지고 영화 띠 → 몇 컷 몰아치기 → 암전 → 쾅, 제목 별 번쩍 → 포스터
# 재료: Seedance 2.5로 뽑은 두 영상(첫 장면·끝 장면 = 포스터를 9:16 판 가운데 둔 그림, 카메라 고정, 10초)
#   A(gen_T1): 센 바람·빛줄기·행성 너머 일출·레코드 섬광·금빛 가루
#   B(gen_T2): 불이 꺼지듯 어두워졌다가 레코드가 불붙듯 빛나 세 얼굴을 아래에서 비춤(가로 섬광)
# 가면 쓴 남자 눈 근접은 영상이 아니라 포스터 원본 그림(가면 남자는 움직이지 않는다)에 빛이 지나가게 했다
# 컷 순서·길이·확대(아래 SHOTS 등)와 소리는 이쪽에서 정했다. 화면 글자는 포스터에 있는 것만(새 글자 없음)
# 쓰는 법: python tools/make_otr_trailer.py <Poster_B2_3U_Main.png> <gen_T1.mp4> <gen_T2.mp4> <out.mp4>
#         node tools/encode_video.mjs <out.mp4> video/otr.mp4 --wh 720x1036 --gop 10 --kbps 2400
import os
import subprocess
import sys
import tempfile
import wave

import cv2
import numpy as np
from scipy.signal import lfilter

POSTER, SRC_A, SRC_B, OUT = sys.argv[1:5]
OW, OH = 720, 1036
FPS = 24
# Seedance 9:16 판(720x1280) 안의 포스터 자리: 처음 넣은 그림이 1113x1600 포스터를 위아래 190px 띠와 함께 1113x1980에 둔 것
PAD_TOP, PAD_H, PAD_TOTAL = 190, 1600, 1980

P_full = cv2.imread(POSTER)
P = cv2.resize(P_full, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32)
# 근접 컷용 큰 포스터(2배)
SCALE_HI = 2
P_HI = cv2.resize(P_full, (OW * SCALE_HI, OH * SCALE_HI), interpolation=cv2.INTER_AREA).astype(np.float32)


def load_clip(path):
    cap = cv2.VideoCapture(path)
    fr = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        fr.append(f)
    H, W = fr[0].shape[:2]
    y0 = PAD_TOP / PAD_TOTAL * H
    y1 = (PAD_TOP + PAD_H) / PAD_TOTAL * H
    sx, sy = OW / W, OH / (y1 - y0)
    M = np.float32([[sx, 0, 0], [0, sy, -y0 * sy]])
    F = [cv2.warpAffine(f, M, (OW, OH), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT).astype(np.float32) for f in fr]
    # 첫 장면을 포스터에 맞춘다(자리 한 번, 색 곡선 한 번 → 모든 장면에 같게)
    gp = cv2.cvtColor(P.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    g0 = cv2.cvtColor(np.clip(F[0], 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(gp, g0, warp, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    except cv2.error:
        pass
    F = [cv2.warpAffine(f, warp, (OW, OH), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT) for f in F]
    qs = np.linspace(1, 99, 25)
    lut = []
    for c in range(3):
        a = np.maximum.accumulate(np.percentile(F[0][..., c], qs) + np.arange(len(qs)) * 1e-3)
        lut.append(np.interp(np.arange(256), a, np.percentile(P[..., c], qs)))
    lut = np.stack(lut, 1).astype(np.float32)

    def grade(f):
        i = np.clip(np.rint(f), 0, 255).astype(np.int32)
        return np.stack([lut[i[..., c], c] for c in range(3)], -1)

    F = [grade(f) for f in F]
    print(os.path.basename(path), len(F), '장, 첫 장면 ↔ 포스터 평균 차', round(float(np.abs(F[0] - P).mean()), 2))
    return F


A = load_clip(SRC_A)
B = load_clip(SRC_B)
CLIPS = {'A': A, 'B': B}

# 컷(화면 초). src: A·B 영상(원본 초 s0→s1을 이 컷 길이에 늘이거나 줄인다) / 'P' 포스터 원본 그림
# zoom z0→z1, 가운데 (cx, cy)는 720x1036 기준. light: 지나가는 빛(가면 남자 근접). dim: 밝기
SHOTS = [
    dict(t0=0.00, t1=0.40, src='P'),
    dict(t0=0.40, t1=2.00, src='B', s0=0.30, s1=3.10),                                           # 불이 꺼진다
    dict(t0=2.00, t1=2.10, src='black'),
    dict(t0=2.10, t1=2.85, src='A', s0=0.35, s1=1.55, z0=1.00, z1=1.06, c=(360, 470)),           # 빛줄기
    dict(t0=2.85, t1=3.50, src='A', s0=1.70, s1=2.60, z0=1.85, z1=2.00, c=(585, 595)),           # 소녀 근접
    dict(t0=3.50, t1=4.20, src='P', z0=2.35, z1=2.55, c=(395, 178), light=True, dim=0.62),       # 가면 남자 눈
    dict(t0=4.20, t1=5.05, src='B', s0=3.60, s1=5.10, z0=1.55, z1=1.68, c=(245, 500)),           # 레코드 점화(소년)
    dict(t0=5.05, t1=6.30, src='A', s0=3.00, s1=5.80, z0=1.08, z1=1.00, c=(360, 470)),           # 일출·레코드 섬광·금빛 가루
    dict(t0=6.30, t1=6.75, src='black'),                                                       # 암전
    dict(t0=6.75, t1=8.95, src='B', s0=8.05, s1=10.0, slam=True),                                # 쾅 → 포스터
    dict(t0=8.95, t1=9.35, src='P'),
]
DUR = SHOTS[-1]['t1']
N = int(round(DUR * FPS))
T_SLAM = 6.75
STAR = (390, 905)  # 제목 RECORD의 O 안 별
BAR = 0.105        # 영화 띠 높이(위·아래 각각, 화면 높이 비율)
yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
VIG = 1 - 0.32 * np.clip(((xx - OW / 2) / (OW * 0.62)) ** 2 + ((yy - OH / 2) / (OH * 0.62)) ** 2, 0, 1)
rng = np.random.default_rng(5)


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def zoom_view(img, z, c, hi=None):
    # 가운데 c를 화면 가운데에 두고 z배 확대(화면 밖으로 안 나가게 가운데를 당긴다)
    cx = float(np.clip(c[0], OW / (2 * z), OW - OW / (2 * z)))
    cy = float(np.clip(c[1], OH / (2 * z), OH - OH / (2 * z)))
    if hi is not None:
        s = SCALE_HI
        M = np.float32([[z / s, 0, OW / 2 - cx * z], [0, z / s, OH / 2 - cy * z]])
        return cv2.warpAffine(hi, M, (OW, OH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    M = np.float32([[z, 0, OW / 2 - cx * z], [0, z, OH / 2 - cy * z]])
    out = cv2.warpAffine(img, M, (OW, OH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    if z > 1.2:  # 확대한 영상은 무르니 조금 선명하게
        out = out + 0.6 * (out - cv2.GaussianBlur(out, (0, 0), 1.6))
    return out


def shot_frame(sh, t):
    k = (t - sh['t0']) / (sh['t1'] - sh['t0'])
    src = sh['src']
    if src == 'black':
        return np.zeros((OH, OW, 3), np.float32)
    z = sh.get('z0', 1.0) + (sh.get('z1', 1.0) - sh.get('z0', 1.0)) * smooth(k) if 'z0' in sh else 1.0
    if src == 'P':
        img = zoom_view(None, z, sh.get('c', (OW / 2, OH / 2)), hi=P_HI) if z > 1.001 else P.copy()
    else:
        F = CLIPS[src]
        s = sh['s0'] + (sh['s1'] - sh['s0']) * k
        img = F[min(len(F) - 1, int(round(s * FPS)))]
        if z > 1.001:
            img = zoom_view(img, z, sh.get('c', (OW / 2, OH / 2)))
    if 'dim' in sh:
        img = img * sh['dim']
    if sh.get('light'):
        # 비스듬한 빛 띠가 왼쪽에서 오른쪽으로 지나간다(따뜻한 흰빛)
        pos = -0.4 + 1.8 * k
        band = np.exp(-(((xx / OW) * 0.8 + (yy / OH) * 0.35 - pos) / 0.10) ** 2)
        img = img + band[..., None] * np.array([150, 200, 255], np.float32) * 0.55
    return img


def star_flare(strength):
    # 가로로 긴 섬광(푸른 흰빛) + 둥근 빛
    sx, sy = STAR
    streak = np.exp(-((yy - sy) / 2.2) ** 2) * np.exp(-np.abs(xx - sx) / 210)
    streak2 = np.exp(-((yy - sy) / 7.0) ** 2) * np.exp(-np.abs(xx - sx) / 90) * 0.5
    glow = np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 16 ** 2))
    cross = np.exp(-((xx - sx) / 1.6) ** 2) * np.exp(-np.abs(yy - sy) / 45) * 0.6
    f = (streak + streak2)[..., None] * np.array([255, 225, 190], np.float32)
    f = f + (glow + cross)[..., None] * np.array([255, 255, 255], np.float32)
    return f * strength


frames = []
for i in range(N):
    t = i / FPS
    sh = next(s for s in SHOTS if s['t0'] <= t < s['t1'] or s is SHOTS[-1])
    img = shot_frame(sh, t)
    middle = 0.40 <= t < 8.95
    if sh.get('slam'):
        ts = t - T_SLAM
        # 쾅: 크게 들어왔다 제자리로, 번쩍
        z = 1 + 0.07 * np.exp(-ts / 0.12)
        if z > 1.001:
            M = np.float32([[z, 0, OW / 2 * (1 - z)], [0, z, OH / 2 * (1 - z)]])
            img = cv2.warpAffine(img, M, (OW, OH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        img = img + 170 * np.exp(-ts / 0.07)
        img = img + star_flare(1.25 * np.exp(-ts / 0.55) + 0.55 * np.exp(-((ts - 1.25) / 0.22) ** 2))
    # 영화 띠(위·아래): 0.5~1.2초에 들어오고, 쾅과 함께 빠르게 빠진다(제목이 띠에 가리지 않게)
    b = BAR * (smooth((t - 0.5) / 0.7) - smooth((t - T_SLAM) / 0.3))
    if middle and sh['src'] != 'black':
        # 가장자리 어둡게 + 고운 잡티(가운데 구간만. 처음·끝 포스터는 그대로라 반복 이음매가 안 보인다)
        amt = smooth((t - 0.4) / 0.6) * (1 - smooth((t - 8.0) / 0.9))
        img = img * (1 - amt + amt * VIG[..., None])
        img = img + rng.normal(0, 3.2, (OH, OW, 1)).astype(np.float32) * amt
    if b > 0.001:
        hb = int(round(b * OH))
        img[:hb] = 0
        img[OH - hb:] = 0
    frames.append(np.clip(np.rint(img), 0, 255).astype(np.uint8))
print(f'{DUR:.2f}초 {N}장')

# ── 소리(예고편): 낮은 웅웅거림 → 컷마다 쉭·쿵 → 박동이 빨라지며 올라감 → 암전에 뚝 끊김 → 거꾸로 부푸는 소리 → 쾅(낮은 금관) + 별 반짝 ──
SR = 48000
ts_ = np.arange(int(N / FPS * SR)) / SR
noise = rng.standard_normal(len(ts_))
db = lambda v: 10 ** (v / 20)


def lp(x, fc):
    a = 1 - np.exp(-2 * np.pi * fc / SR)
    return lfilter([a], [1, -(1 - a)], x)


def lp_var(x, fc):
    a = 1 - np.exp(-2 * np.pi * fc / SR)
    y = np.zeros_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def place(seg, t0, out):
    i0 = int(t0 * SR)
    if i0 >= len(out):
        return
    n = min(len(seg), len(out) - i0)
    out[i0:i0 + n] += seg[:n]


def kick(f0, f1, dec, length=0.8):
    tt = np.arange(int(length * SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-tt / 0.05)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / dec)


def whoosh(length=0.35):
    n = int(length * SR)
    tt = np.arange(n) / SR
    x = rng.standard_normal(n)
    e = np.sin(np.pi * tt / length) ** 2
    hi = lp(x, 6000) - lp(x, 800)
    return hi * e


def saw(f, t):
    return 2 * ((t * f) % 1) - 1


mix = np.zeros_like(ts_)
# 낮은 웅웅거림(라 화음): 불이 꺼지며 커지고 몰아치기 동안 이어지다 암전에 끊김
drone = sum(saw(f * (1 + 0.003 * j), ts_) for j, f in enumerate([55.0, 82.4, 110.0, 164.8])) / 4
drone = lp(drone, 380)
drone_env = smooth((ts_ - 0.4) / 1.4) * (ts_ < 6.30) * (0.8 + 0.2 * smooth((ts_ - 2.1) / 4.2))
mix += drone * drone_env * db(-14)
place(kick(70, 32, 0.9, 2.0) * db(-6), 0.45, mix)  # 불이 꺼지는 쿵
# 컷마다 쉭 + 쿵
for tc in [2.10, 2.85, 3.50, 4.20, 5.05]:
    place(whoosh(0.3) * db(-14), tc - 0.26, mix)
    place(kick(110, 40, 0.28) * db(-7), tc, mix)
    hit = (lp(noise[:int(0.25 * SR)], 3000) * np.exp(-np.arange(int(0.25 * SR)) / SR / 0.05)) * db(-16)
    place(hit, tc, mix)
# 박동(점점 빨라지고 커짐) 2.1~6.3
tb = 2.1
while tb < 6.25:
    lvl = -20 + 9 * (tb - 2.1) / 4.2
    place(kick(90, 45, 0.12, 0.3) * db(lvl), tb, mix)
    tb += 0.42 - 0.22 * (tb - 2.1) / 4.2
# 올라가는 소리 5.0~6.3: 잡음 + 위로 미끄러지는 음
rk = np.clip((ts_ - 5.0) / 1.3, 0, 1) * (ts_ < 6.30)
mix += lp_var(noise, 400 + 7000 * rk ** 2) * rk ** 2 * db(-12)
ph = 2 * np.pi * np.cumsum(220 + 900 * rk ** 2) / SR
mix += np.sin(ph) * rk ** 2 * db(-20)
# 암전: 거꾸로 부푸는 소리(6.35~6.75)
rv = np.clip((ts_ - 6.35) / 0.40, 0, 1) * (ts_ < T_SLAM)
mix += (lp(noise, 9000) - lp(noise, 1500)) * rv ** 3 * db(-12)
# 쾅: 낮은 금관(BRAAM) + 깊은 쿵 + 터지는 잡음 + 별 반짝
tt = ts_ - T_SLAM
on = tt >= 0
br = sum(saw(f * (1 + 0.004 * j), ts_) for j, f in enumerate([55.0, 55.3, 110.0, 82.4, 164.8, 220.0])) / 6
cut = 220 + 1600 * np.exp(-np.clip(tt, 0, None) / 0.35) * on + 200 * on
br = lp_var(br, cut) * on * np.exp(-np.clip(tt, 0, None) / 1.1) * np.minimum(1, np.clip(tt, 0, None) / 0.01)
mix += br * db(-4)
place(kick(90, 28, 1.2, 2.2) * db(-3), T_SLAM, mix)
burst = (lp(noise, 7000) - lp(noise, 300)) * on * np.exp(-np.clip(tt, 0, None) / 0.25)
mix += burst * db(-12)
for f, lv in [(2637, -24), (3951, -28), (5274, -32)]:
    mix += np.sin(2 * np.pi * f * ts_) * on * np.exp(-np.clip(tt - 0.02, 0, None) / 0.5) * db(lv)
# 끝: 별이 한 번 더 반짝(8.0초)
t2 = ts_ - (T_SLAM + 1.25)
mix += np.sin(2 * np.pi * 3520 * ts_) * (t2 >= 0) * np.exp(-np.clip(t2, 0, None) / 0.35) * db(-30)
mix *= np.clip((DUR - 0.25 - ts_) / 0.6, 0, 1)  # 끝 0.25초 앞에서 다 잦아든다
mix *= db(-1.5) / (np.abs(mix).max() + 1e-9)
pcm = (np.clip(np.stack([mix, mix], 1), -1, 1) * 32767).astype(np.int16)
tmpwav = os.path.join(tempfile.mkdtemp(), 'otr.wav')
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
cv2.imwrite(stem + '_sheet.jpg', np.vstack([np.hstack(th[r * cols:(r + 1) * cols]) for r in range(len(th) // cols)]), [cv2.IMWRITE_JPEG_QUALITY, 85])
print('결과', OUT)
