# UNMUTE 메인 포스터 애니메이션(2026-11-16, UNMUTE 팀 연출안)
# 1) 포스터 그대로에서 시작 → 화면 바깥부터 원형으로 흑백이 안쪽으로 퍼진다(배경만, 캐릭터는 컬러 그대로)
# 2) 흑백이 화면을 덮어 배경이 무채색이 된 뒤 → 캐릭터 자리를 가운데로 컬러가 원형 파동처럼 바깥으로 퍼진다
# 3) 컬러를 유지한 채 글리치 → 4) 포스터 그대로로 돌아와 반복(처음 장면 = 끝 다음 장면 = 포스터)
# 시간·세기 값(아래 T, GLITCH)은 연출안에 없던 것이라 이쪽에서 정했다
# 입력: 포스터 원본(Poster_B2_MP3_Main.png, 2782x4000), 캐릭터 가리개(tools/unmute_mask.png, 흰색 = 캐릭터)
#       가리개는 rembg(isnet-anime)로 딴 뒤 아래 디제이 장비를 배경으로 뺐다(README "UNMUTE 포스터 애니메이션")
# 출력: 720x1036 영상(소리 없음, x264 거의 무손실) + 확인용 장면 모음(<out>_sheet.jpg)
# 쓰는 법: python tools/make_unmute_anim.py <Poster_B2_MP3_Main.png> tools/unmute_mask.png <out.mp4>
#         node tools/encode_video.mjs <out.mp4> video/unmute.mp4 --wh 720x1036 --gop 10 --kbps 2400
import os
import subprocess
import sys

import cv2
import numpy as np

POSTER, MASK, OUT = sys.argv[1:4]
OW, OH = 720, 1036
FPS = 24

# 시간표(초)
T = {
    'hold0': 0.5,     # 포스터 그대로
    'gray': 2.4,      # 흑백 원이 바깥에서 안으로
    'hold1': 0.6,     # 배경 흑백, 캐릭터만 컬러
    'wave': 2.0,      # 컬러 파동이 캐릭터에서 바깥으로
    'hold2': 0.4,     # 컬러
    'glitch': 2.6,    # 글리치(짧게 여러 번)
    'hold3': 0.7,     # 포스터 그대로(반복 이음매)
}
DUR = sum(T.values())
N = int(round(DUR * FPS))

src = cv2.imread(POSTER)
P = cv2.resize(src, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32)
m = cv2.imread(MASK, cv2.IMREAD_GRAYSCALE)
CH = cv2.resize(m, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255  # 캐릭터 1
# 회색: BT.709 밝기
Y = (0.0722 * P[..., 0] + 0.7152 * P[..., 1] + 0.2126 * P[..., 2])
G = np.repeat(Y[..., None], 3, 2)

yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)
# 가운데: 캐릭터 무게중심
w = CH.sum()
CX = float((CH * xx).sum() / w)
CY = float((CH * yy).sum() / w)
R = np.sqrt((xx - CX) ** 2 + (yy - CY) ** 2)
RMAX = float(R.max()) + 8
print(f'{DUR:.2f}초 {N}장, 가운데 ({CX:.0f}, {CY:.0f}) = ({CX / OW:.3f}, {CY / OH:.3f}), 먼 구석 {RMAX:.0f}px')


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = np.clip(x, 0, 1)
    return 1 - (1 - x) ** 3


EDGE = 10.0  # 원 가장자리 부드러운 폭(px)
CHK = CH[..., None]


def compose(color_amt):
    # color_amt: 배경이 컬러인 정도(0~1, 장소마다). 캐릭터는 늘 컬러
    a = np.maximum(color_amt, CH)[..., None]
    return P * a + G * (1 - a)


def phase_gray(k):
    # 컬러 원(반지름 r)이 줄어든다: 원 밖은 흑백
    r = RMAX * (1 - smooth(k))
    inside = np.clip((r - R) / EDGE + 0.5, 0, 1)
    return compose(inside)


def ripple(img, r0, amp):
    # 파동 앞머리에 둥근 물결(바깥으로 밀었다 당기는 굴절). 캐릭터는 휘지 않는다
    d = R - r0
    wave = amp * np.sin(d / 9.0) * np.exp(-((d + 8) / 26.0) ** 2)
    wave *= (1 - CH)
    ux = (xx - CX) / (R + 1e-3)
    uy = (yy - CY) / (R + 1e-3)
    mx = xx - ux * wave
    my = yy - uy * wave
    return cv2.remap(img.astype(np.float32), mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def phase_wave(k):
    # 컬러 원이 캐릭터 가운데에서 바깥으로(처음 빠르고 끝 느리게). 앞머리를 따라 물결 두 줄
    e = ease_out(k)
    r = RMAX * e
    inside = np.clip((r - R) / EDGE + 0.5, 0, 1)
    img = compose(inside)
    amp = 7.0 * (1 - k) ** 0.7  # 퍼지며 잦아든다
    img = ripple(img, r, amp)
    # 뒤따르는 옅은 물결 한 줄
    r2 = RMAX * ease_out(max(0.0, k - 0.12) / 0.88)
    if k > 0.12:
        img = ripple(img, r2, amp * 0.45)
    # 앞머리에 아주 옅은 빛 테(컬러가 번지는 자리를 눈으로 따라가게)
    ring = np.exp(-((R - r) / 6.0) ** 2) * (1 - CH) * 0.10 * (1 - k)
    img = img * (1 + ring[..., None])
    return img


# 글리치: 정해 둔 무작위(매번 같은 결과)
rng = np.random.default_rng(7)
GLITCH = [  # (시작 초, 길이 초, 세기) 글리치 구간 안에서
    (0.10, 0.25, 0.7),
    (0.62, 0.08, 1.0),
    (0.95, 0.42, 0.85),
    (1.62, 0.12, 1.0),
    (2.05, 0.20, 0.55),
]


def glitch(img, s, seed):
    r = np.random.default_rng(seed)
    out = img.copy()
    # 가로 띠 밀기(4~10개, 높이 3~48px, ±6~44px)
    for _ in range(int(4 + 6 * s)):
        h = int(r.integers(3, 48))
        y0 = int(r.integers(0, OH - h))
        dx = int(r.choice([-1, 1]) * r.integers(6, int(8 + 36 * s)))
        out[y0:y0 + h] = np.roll(out[y0:y0 + h], dx, axis=1)
    # 색 갈라짐(빨강 →, 파랑 ←): 포스터 제목의 마젠타·시안 번짐과 같은 방향
    k = int(round(2 + 6 * s))
    b, g_, rch = out[..., 0].copy(), out[..., 1], out[..., 2].copy()
    out[..., 2] = np.roll(rch, k, axis=1)
    out[..., 0] = np.roll(b, -k, axis=1)
    # 작은 네모 몇 개: 옆 칸 그림을 떠다 붙이기
    for _ in range(int(2 + 4 * s)):
        bw, bh = int(r.integers(24, 120)), int(r.integers(6, 30))
        x0, y0 = int(r.integers(0, OW - bw)), int(r.integers(0, OH - bh))
        sx = int(np.clip(x0 + r.integers(-60, 60), 0, OW - bw))
        out[y0:y0 + bh, x0:x0 + bw] = out[y0:y0 + bh, sx:sx + bw]
    # 주사선(가로줄 하나 건너 조금 어둡게)
    out[::2] *= 1 - 0.10 * s
    return out


frames = []
t_gray0 = T['hold0']
t_hold1 = t_gray0 + T['gray']
t_wave0 = t_hold1 + T['hold1']
t_hold2 = t_wave0 + T['wave']
t_gl0 = t_hold2 + T['hold2']
t_hold3 = t_gl0 + T['glitch']
for i in range(N):
    t = i / FPS
    if t < t_gray0:
        f = P
    elif t < t_hold1:
        f = phase_gray((t - t_gray0) / T['gray'])
    elif t < t_wave0:
        f = compose(np.zeros((OH, OW), np.float32))
    elif t < t_hold2:
        f = phase_wave((t - t_wave0) / T['wave'])
    elif t < t_gl0:
        f = P
    elif t < t_hold3:
        tg = t - t_gl0
        f = P
        for j, (a, d, s) in enumerate(GLITCH):
            if a <= tg < a + d:
                # 한 구간 안에서도 장면마다 모양을 바꾼다(2장마다)
                f = glitch(P, s, 1000 * j + int(tg * FPS) // 2)
                break
    else:
        f = P
    frames.append(np.clip(np.rint(f), 0, 255).astype(np.uint8))

p = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                      '-c:v', 'libx264', '-crf', '8', '-preset', 'slow', '-pix_fmt', 'yuv420p',
                      '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                      OUT], stdin=subprocess.PIPE)
for f in frames:
    p.stdin.write(f.tobytes())
p.stdin.close()
assert p.wait() == 0
stem = os.path.splitext(OUT)[0]
# 확인용: 0.25초마다 작은 장면을 한 장에
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
