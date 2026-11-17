# OFF THE RECORD 포스터 영상(2026-11-16 셋째 판, 2026-11-17 나머지는 흐리게): 포스터 틀 그대로, 카메라 움직임 없이 한 명씩 조명
# 흐름(15초)
# 1) 포스터 그대로 → 불이 꺼진다(모두 어둡고 흐려진다. 초점이 나간 것처럼)
# 2) 소녀에게 불이 켜지고 초점이 맞는다(나머지 둘은 어둡고 흐린 채로 자리에 남는다). 헤드셋에서 소리 물결이 퍼진다
# 3) 가면 쓴 남자에게. 가면 쇠붙이에 빛이 지나가고, 옷깃의 청록 줄이 네온처럼 위에서 아래로 흐르고, 눈이 한 번 반짝
# 4) 소년에게. 안은 금빛 레코드가 빛나 얼굴·손을 아래에서 비추고, 레코드 위로 빛이 돌고, 금빛 가루가 올라간다
# 5) 셋에게 차례로 다시 불이 켜지고 배경이 돌아온다 → 제목 OFF THE 켜짐 → RECORD 쾅, 별 번쩍 → 포스터 그대로(반복 이음매)
# 사람이 움직이는 바탕(머리카락·헤드셋 줄·행성·정거장 불빛)은 이전 판 잔잔한 반복 영상을 쓴다(없으면 포스터 그림 그대로)
# 연출 방향(카메라 없이 한 명씩)은 사용자 지시, 나머지를 흐리게 두는 것은 2026-11-17 사용자 선택(검게 지움 · 그늘 · 흑백 · 흐리게 중)
# 순서·시간·효과·소리는 이쪽에서 정했다. 화면 글자는 포스터에 있는 것만
# 소리 = 인트로 브금(tools/make_otr_bgm.py, 이 대본이 불러 만든다) + 효과음. 브금을 웅장한 인트로풍으로 하자는 건 2026-11-17 사용자 제안, 편곡은 이쪽
# 입력: 포스터 원본(Poster_B2_3U_Main.png), 세 사람 가리개(tools/otr_people_mask.png: 파랑 = 가면 남자, 초록 = 소년, 빨강 = 소녀),
#       바탕 영상(720x1036 24fps 10초, 처음·끝 = 포스터) 또는 '-'
# 쓰는 법: python tools/make_otr_spotlight.py <Poster_B2_3U_Main.png> tools/otr_people_mask.png <calm_loop.mp4 또는 -> <out.mp4>
#         node tools/encode_video.mjs <out.mp4> video/otr.mp4 --wh 720x1036 --gop 10 --kbps 2000
import os
import subprocess
import sys
import tempfile
import wave

import cv2
import numpy as np
from scipy.signal import lfilter

POSTER, MASK, BASE, OUT = sys.argv[1:5]
OW, OH = 720, 1036
FPS = 24
DUR = 15.0
N = int(round(DUR * FPS))

# ── 시간표(초) ──
T_DOWN = (0.8, 1.8)            # 불이 꺼진다
SPOTS = {                      # 한 명씩: 켜짐 → 꺼짐
    'girl': (2.10, 4.95),
    'man': (5.10, 7.95),
    'boy': (8.10, 10.95),
}
RELIGHT = {'girl': 11.15, 'man': 11.40, 'boy': 11.65}  # 셋에게 차례로 다시
T_BG_UP = (12.70, 12.98)       # 배경과 제목 RECORD가 쾅과 함께 돌아온다
T_TITLE = 12.25                # OFF THE 켜짐 시작
T_SLAM = 12.70                 # RECORD 쾅
T_CLEAN = 14.35                # 이때부터 포스터 그대로(반복 이음매)
BASE_AT = 1.0                  # 바탕 영상이 이 초에 시작(10초)

# ── 꺼진 쪽(조명 안 받는 사람·배경·제목): 밝기(포스터에 곱하는 값), 채도, 흐림 ──
DARK_BG = 0.24                 # 불 꺼진 배경
DARK_CH = 0.42                 # 조명 안 받는 사람(어둡지만 보이게)
DARK_TITLE = 0.30              # 불 꺼진 제목(흐리지는 않는다)
SAT_BG = 0.6                   # 꺼진 배경·제목 채도(1 = 그대로, 0 = 흑백)
SAT_CH = 0.55                  # 조명 안 받는 사람 채도
DARK_TINT = (1.08, 1.0, 0.9)   # 꺼진 쪽을 살짝 푸르게(BGR에 곱함)
BLUR = 7.0                     # 꺼진 쪽 흐림(가우스 시그마, 픽셀). 초점이 나간 것처럼

# ── 자리(720x1036 기준) ──
HEADSET = (455, 605)           # 소녀 헤드셋 귀덮개
EYES = [(337, 160), (432, 177)]  # 가면 남자 눈
RECORD = (247, 575, 108)       # 소년이 안은 레코드(가운데, 반지름)
STAR = (390, 905)              # 제목 RECORD의 O 안 별
COLOR = {                      # 사람마다 빛 색(BGR)
    'girl': np.array([210, 205, 70], np.float32),   # 청록
    'man': np.array([255, 215, 160], np.float32),   # 차가운 흰빛
    'boy': np.array([70, 175, 255], np.float32),    # 금빛
}
LIGHT_DIR = {'girl': (1, -0.3), 'man': (0, -1), 'boy': (-0.6, -1)}  # 빛이 오는 쪽(테두리 빛)

P_full = cv2.imread(POSTER)
P = cv2.resize(P_full, (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32)
mk = cv2.resize(cv2.imread(MASK), (OW, OH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
yy, xx = np.mgrid[0:OH, 0:OW].astype(np.float32)


def soft(m, grow=2, sig=1.6):
    m = cv2.dilate(m, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) if grow else m
    return np.clip(cv2.GaussianBlur(m, (0, 0), sig), 0, 1)


# 제목 글자 가리개(색으로): OFF THE = 크림색, RECORD = 빨강(+ 별), 3U Studio = 밝은 글자
hsv = cv2.cvtColor(P.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
Bc, Gc, Rc = P[..., 0], P[..., 1], P[..., 2]
TITLE = np.zeros((OH, OW), np.float32)
r = (xx >= 255) & (xx <= 463) & (yy >= 804) & (yy <= 853)
TITLE[r & (Rc > 160) & (Rc - Bc > 10)] = 1
r = (xx >= 125) & (xx <= 597) & (yy >= 852) & (yy <= 953)
TITLE[r & (Rc > 95) & (Rc - Gc > 40)] = 1
TITLE[(np.abs(xx - STAR[0]) < 9) & (np.abs(yy - STAR[1]) < 40) & (Rc > 170) & (Bc > 170)] = 1
TITLE[(np.abs(xx - STAR[0]) < 40) & (np.abs(yy - STAR[1]) < 9) & (Rc > 170) & (Bc > 170)] = 1
r = (xx >= 300) & (xx <= 420) & (yy >= 975) & (yy <= 1006)
TITLE[r & (Rc > 110)] = 1
TITLE = cv2.morphologyEx(TITLE, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
TITLE = soft(TITLE, 1, 0.8)

M = {k: soft(mk[..., c], 3, 2.0) * (1 - TITLE) for k, c in [('man', 0), ('boy', 1), ('girl', 2)]}
ALL = np.clip(M['man'] + M['boy'] + M['girl'], 0, 1)

# 사람마다 효과 자리
H_, S_, V_ = hsv[..., 0], hsv[..., 1], hsv[..., 2]
METAL = M['man'] * ((xx > 276) & (xx < 474) & (yy > 192) & (yy < 348) & (S_ < 75) & (V_ > 45))
METAL = soft(METAL.astype(np.float32), 0, 1.0)
STRIPE = M['man'] * ((H_ > 78) & (H_ < 102) & (S_ > 80) & (V_ > 50) & (yy > 325))
STRIPE = soft(STRIPE.astype(np.float32), 0, 0.8)
RD = np.sqrt((xx - RECORD[0]) ** 2 + (yy - RECORD[1]) ** 2)
GOLD = M['boy'] * (RD < RECORD[2]) * ((H_ > 8) & (H_ < 36) & (S_ > 60))
GOLD = soft(GOLD.astype(np.float32), 0, 1.0)
REC_ANG = np.arctan2(yy - RECORD[1], xx - RECORD[0])
EARCUP = M['girl'] * (np.sqrt((xx - HEADSET[0]) ** 2 + (yy - HEADSET[1]) ** 2) < 52) * (S_ < 110)
EARCUP = soft(EARCUP.astype(np.float32), 0, 1.5)

# 사람마다 뒤 빛(배경에 번지는 빛)과 테두리 빛
HALO = {k: cv2.GaussianBlur(M[k], (0, 0), 26) * (1 - ALL) * (1 - TITLE) for k in M}
RIM = {}
for k, (dx, dy) in LIGHT_DIR.items():
    n = np.hypot(dx, dy)
    sh = np.float32([[1, 0, -dx / n * 5], [0, 1, -dy / n * 5]])
    moved = cv2.warpAffine(M[k], sh, (OW, OH), borderMode=cv2.BORDER_CONSTANT)
    RIM[k] = np.clip(M[k] - moved, 0, 1)
    RIM[k] = cv2.GaussianBlur(RIM[k], (0, 0), 1.2) * (1 - TITLE)
# 소년: 레코드 빛이 아래에서 비춘다(레코드에서 멀어질수록 약하게)
REC_LIGHT = np.exp(-(RD / 105) ** 2) * M['boy']

# 바탕 영상
BASEF = []
if BASE != '-':
    cap = cv2.VideoCapture(BASE)
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if f.shape[:2] != (OH, OW):
            f = cv2.resize(f, (OW, OH), interpolation=cv2.INTER_AREA)
        BASEF.append(f)
print(f'{DUR:.1f}초 {N}장, 바탕 영상 {len(BASEF)}장, 쇠 {int(METAL.sum())} 줄 {int(STRIPE.sum())} 금 {int(GOLD.sum())} 귀덮개 {int(EARCUP.sum())}')


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = np.clip(x, 0, 1)
    return 1 - (1 - x) ** 3


def flick_on(s):
    # 무대 조명이 켜지는 모양: 몇 번 깜빡이다 켜진 채로
    if s < 0:
        return 0.0
    for a, v in [(0.21, 1.0), (0.16, 0.55), (0.10, 0.92), (0.05, 0.18), (0.0, 0.7)]:
        if s >= a:
            return v
    return 0.0


def spot_level(k, t):
    t0, t1 = SPOTS[k]
    if t < t0:
        return 0.0
    if t < t1:
        return flick_on(t - t0)
    lv = 1 - smooth((t - t1) / 0.18)
    tr = RELIGHT[k]
    return max(lv, flick_on(t - tr))


def focus_level(k, t):
    # 초점(흐림이 걷힌 정도): 불은 깜빡이며 켜지고, 초점은 그 뒤를 따라 부드럽게 맞는다
    t0, t1 = SPOTS[k]
    if t < t0:
        return 0.0
    if t < t1:
        return smooth((t - t0) / 0.35)
    if RELIGHT[k] - t1 < 1.0:
        return 1.0  # 곧 다시 켜지는 사람(소년)은 초점을 놓지 않는다(레코드 빛이 남아 있어 흐린 몸 위에 또렷한 판만 뜨지 않게)
    f = 1 - smooth((t - t1) / 0.25)
    return max(f, smooth((t - RELIGHT[k]) / 0.3))


def all_level(t):
    # 모두 같이 켜진 정도(처음 → 꺼짐, 끝에 배경이 돌아옴)
    if t < T_DOWN[0]:
        return 1.0
    if t < T_BG_UP[0]:
        return 1 - smooth((t - T_DOWN[0]) / (T_DOWN[1] - T_DOWN[0]))
    return smooth((t - T_BG_UP[0]) / (T_BG_UP[1] - T_BG_UP[0]))


def title_level(t):
    if t < T_TITLE:
        return all_level(t) if t < T_DOWN[1] else 0.0
    s = t - T_TITLE
    seq = [(0.0, 0.5), (0.05, 0.1), (0.11, 0.8), (0.16, 0.35), (0.22, 1.0)]
    v = 0.0
    for a, val in seq:
        if s >= a:
            v = val
    return v


def record_word(t):
    # RECORD는 쾅에 켜진다(그 전엔 OFF THE만)
    if t < T_DOWN[1]:
        return all_level(t)
    return 1.0 if t >= T_SLAM else 0.0


RECORD_ROWS = (yy >= 852).astype(np.float32)  # 제목 가리개 중 RECORD 줄(+ 로고)


def star_flare(strength):
    sx, sy = STAR
    streak = np.exp(-((yy - sy) / 2.2) ** 2) * np.exp(-np.abs(xx - sx) / 210)
    streak2 = np.exp(-((yy - sy) / 7.0) ** 2) * np.exp(-np.abs(xx - sx) / 90) * 0.5
    glow = np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * 16 ** 2))
    cross = np.exp(-((xx - sx) / 1.6) ** 2) * np.exp(-np.abs(yy - sy) / 45) * 0.6
    f = (streak + streak2)[..., None] * np.array([255, 225, 190], np.float32)
    return (f + (glow + cross)[..., None] * 255) * strength


def sparkle(cx, cy, size, strength):
    # 작은 네 갈래 반짝임
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    h = np.exp(-((yy - cy) / 1.1) ** 2) * np.exp(-np.abs(xx - cx) / size)
    v = np.exp(-((xx - cx) / 1.1) ** 2) * np.exp(-np.abs(yy - cy) / (size * 0.7))
    g = np.exp(-(d / 3.0) ** 2)
    return (h + v + g)[..., None] * np.array([255, 245, 225], np.float32) * strength


# 소녀: 소리 물결(헤드셋에서 왼쪽으로 퍼지는 둥근 테)
RING_T = [0.45, 0.95, 1.45, 1.95]  # 소녀 조명 켜진 뒤(삐 소리와 같이)
HD = np.sqrt((xx - HEADSET[0]) ** 2 + (yy - HEADSET[1]) ** 2)
RING_SIDE = smooth((HEADSET[0] + 70 - xx) / 120)


def girl_fx(t, lv):
    s0 = t - SPOTS['girl'][0]
    out = np.zeros((OH, OW, 3), np.float32)
    beep = 0.0
    for tr in RING_T:
        s = s0 - tr
        if 0 <= s < 1.2:
            rad = 40 + 300 * ease_out(s / 1.2)
            a = (1 - s / 1.2) ** 1.6
            ring = (np.exp(-((HD - rad) / 2.2) ** 2) + 0.35 * np.exp(-((HD - rad) / 9.0) ** 2)) * a * RING_SIDE * (1 - M['girl'])
            out += ring[..., None] * COLOR['girl'] * 0.9
            beep = max(beep, np.exp(-s / 0.18))
    out += EARCUP[..., None] * COLOR['girl'] * (0.10 + 0.28 * beep) * lv
    return out * lv


# 가면 남자: 쇠 위로 빛 띠, 청록 줄 네온(위→아래로 흐름), 눈 반짝
def man_fx(t, lv):
    s = t - SPOTS['man'][0]
    out = np.zeros((OH, OW, 3), np.float32)
    pos = -0.15 + 1.3 * smooth((s - 0.45) / 1.3)
    band = np.exp(-(((xx - 276) / 198 * 0.8 + (yy - 192) / 156 * 0.45 - pos) / 0.09) ** 2)
    out += (METAL * band)[..., None] * np.array([235, 240, 255], np.float32) * 0.85
    flow = 0.0
    for st in [0.35, 1.25, 2.05]:
        y0 = 320 + 260 * smooth((s - st) / 0.75)
        if st <= s < st + 0.9:
            flow = flow + np.exp(-((yy - y0) / 45) ** 2) * (1 - (s - st) / 0.9)
    neon = STRIPE * (0.35 + 1.1 * flow)
    neon_glow = cv2.GaussianBlur(neon, (0, 0), 4)
    out += (neon * 0.8 + neon_glow * 1.4)[..., None] * np.array([225, 210, 70], np.float32)
    ge = s - 2.15
    if 0 <= ge < 0.6:
        a = np.exp(-ge / 0.16) * smooth(ge / 0.04)
        for ex, ey in EYES:
            out += sparkle(ex + 6, ey - 3, 14, 0.9 * a)
    return out * lv


# 소년: 레코드 빛 + 돌아가는 빛 + 금빛 가루
prng = np.random.default_rng(11)
NP = 70
PART = dict(
    x=prng.normal(RECORD[0], 62, NP), y=prng.normal(RECORD[1] + 20, 45, NP),
    vy=prng.uniform(28, 85, NP), sway=prng.uniform(4, 14, NP), ph=prng.uniform(0, 6.28, NP),
    t0=prng.uniform(0.3, 2.4, NP), life=prng.uniform(1.4, 2.8, NP), size=prng.uniform(1.0, 2.3, NP),
)


def particles(t, base_t):
    out = np.zeros((OH, OW), np.float32)
    for j in range(NP):
        s = t - base_t - PART['t0'][j]
        if s < 0 or s > PART['life'][j]:
            continue
        x = PART['x'][j] + PART['sway'][j] * np.sin(PART['ph'][j] + s * 2.2)
        y = PART['y'][j] - PART['vy'][j] * s
        a = smooth(s / 0.3) * (1 - smooth((s - PART['life'][j] + 0.6) / 0.6)) * (0.6 + 0.4 * np.sin(PART['ph'][j] * 3 + s * 9))
        x0, x1 = int(max(0, x - 8)), int(min(OW, x + 9))
        y0, y1 = int(max(0, y - 8)), int(min(OH, y + 9))
        if x0 >= x1 or y0 >= y1:
            continue
        d2 = (xx[y0:y1, x0:x1] - x) ** 2 + (yy[y0:y1, x0:x1] - y) ** 2
        out[y0:y1, x0:x1] += a * np.exp(-d2 / (2 * PART['size'][j] ** 2))
    return out


def boy_fx(t, lv, glow):
    s = t - SPOTS['boy'][0]
    out = np.zeros((OH, OW, 3), np.float32)
    pulse = 0.75 + 0.25 * np.sin(s * 4.2)
    out += REC_LIGHT[..., None] * COLOR['boy'] * 0.42 * glow * pulse
    th = -1.2 + s * 1.9
    sheen = (np.cos(REC_ANG - th) ** 2) ** 10 + (np.cos(REC_ANG - th - np.pi / 2) ** 2) ** 14 * 0.5
    out += (GOLD * sheen)[..., None] * np.array([170, 230, 255], np.float32) * 0.8 * glow
    out += GOLD[..., None] * COLOR['boy'] * 0.22 * glow
    return out * lv


# 꺼진 쪽 밝기·채도 지도(배경, 사람, 제목)
DARK_D = ((1 - ALL) * DARK_BG + ALL * DARK_CH) * (1 - TITLE) + TITLE * DARK_TITLE
SAT_D = ((1 - ALL) * SAT_BG + ALL * SAT_CH) * (1 - TITLE) + TITLE * SAT_BG
TINT = np.float32(DARK_TINT)
GRAY_W = np.float32([0.114, 0.587, 0.299])  # BGR 밝기

frames = []
for i in range(N):
    t = i / FPS
    j = int(round((t - BASE_AT) * FPS))
    base = BASEF[j].astype(np.float32) if BASEF and 0 <= j < len(BASEF) else P
    if t >= T_CLEAN:
        frames.append(np.clip(np.rint(P), 0, 255).astype(np.uint8))
        continue
    A = all_level(t)
    L = {k: max(A, spot_level(k, t)) for k in M}
    Fo = {k: max(A, focus_level(k, t)) for k in M}
    # 켜진 정도(밝기·채도)와 초점: 배경, 사람마다, 제목(제목은 흐리지 않는다)
    lv = (1 - ALL) * A
    fv = (1 - ALL) * A
    for k in M:
        lv = lv + M[k] * L[k]
        fv = fv + M[k] * Fo[k]
    tl = title_level(t) * (1 - RECORD_ROWS) + record_word(t) * RECORD_ROWS
    lv = lv * (1 - TITLE) + TITLE * tl
    fv = (fv * (1 - TITLE) + TITLE)[..., None]
    if fv.min() < 0.999:
        base = base * fv + cv2.GaussianBlur(base, (0, 0), BLUR) * (1 - fv)
    gray = (base @ GRAY_W)[..., None]
    img = gray + (base - gray) * (SAT_D + (1 - SAT_D) * lv)[..., None]
    img = img * (DARK_D + (1 - DARK_D) * lv)[..., None] * (TINT + (1 - TINT) * lv[..., None])
    # 불 꺼진 동안 어둠을 살짝 푸르게
    img += (1 - A) * (1 - ALL)[..., None] * np.array([6, 3, 0], np.float32)
    # 조명받는 사람: 뒤 빛 + 테두리 빛(한 명씩 켜진 때만. 다 같이 켜지면 없어진다)
    for k in M:
        sp = max(0.0, spot_level(k, t) - A)
        if sp > 0.001:
            img += (HALO[k] * 0.55 + RIM[k] * 0.55)[..., None] * COLOR[k] * sp
    lg = spot_level('girl', t) * (t < RELIGHT['girl'])
    if lg > 0.001:
        img += girl_fx(t, lg)
    lm = spot_level('man', t) * (t < RELIGHT['man'])
    if lm > 0.001:
        img += man_fx(t, lm)
    lb = spot_level('boy', t)
    if t >= SPOTS['boy'][0]:
        glow = smooth((t - SPOTS['boy'][0] - 0.25) / 0.6) * (1 - smooth((t - RELIGHT['boy'] - 0.3) / 1.2))
        if glow > 0.001:
            img += boy_fx(t, max(lb, 0.0) if t < SPOTS['boy'][1] else 1.0, glow)
        pa = particles(t, SPOTS['boy'][0]) * (1 - smooth((t - 12.2) / 0.8))
        if pa.max() > 0.01:
            img += (pa * (1 - TITLE))[..., None] * np.array([150, 220, 255], np.float32) * 1.1
    # 제목: OFF THE가 켜질 때 살짝 빛 번짐, RECORD 쾅에 번쩍 + 별
    if t >= T_SLAM:
        s = t - T_SLAM
        img += (TITLE * RECORD_ROWS)[..., None] * np.array([40, 50, 255], np.float32) * 0.6 * np.exp(-s / 0.25)
        img += 90 * np.exp(-s / 0.07)
        img += star_flare((1.2 * np.exp(-s / 0.5) + 0.5 * np.exp(-((s - 0.95) / 0.2) ** 2)) * (1 - smooth((t - 13.95) / 0.35)))
    frames.append(np.clip(np.rint(img), 0, 255).astype(np.uint8))

# ── 소리 ──
# 효과음: 불 꺼짐 = 큰 스위치 쿵 / 한 명씩 = 스위치 철컥 + 사람마다 소리(소녀 = 무전 잡음과 삐, 가면 남자 = 쇠 울림과 기계음, 소년 = 판 잡음과 방울)
# 끝 = 철컥 셋 → 올라가는 잡음 → OFF THE 쉭 → RECORD 쾅(낮은 금관) + 별 반짝 → 잦아듦
# 화음·웅웅거림은 브금이 맡는다(효과음 쪽 화음은 브금과 음이 부딪혀 뺐다). 효과음은 브금보다 SFX_DB만큼 작게 섞는다
BGM_DB = 0.0
SFX_DB = -5.0
SR = 48000
ts_ = np.arange(int(N / FPS * SR)) / SR
rng = np.random.default_rng(5)
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


def clack(level):
    # 무대 조명 스위치: 짧은 딸깍 + 낮은 쿵
    n = int(0.4 * SR)
    tt = np.arange(n) / SR
    x = rng.standard_normal(n)
    click = (lp(x, 7000) - lp(x, 1800)) * np.exp(-tt / 0.012)
    return (click * 0.9 + kick(120, 50, 0.09, 0.4) * 0.8) * level


def tone(f, length, a=0.005, d=0.2):
    tt = np.arange(int(length * SR)) / SR
    return np.sin(2 * np.pi * f * tt) * np.minimum(1, tt / a) * np.exp(-tt / d)


def saw(f, t):
    return 2 * ((t * f) % 1) - 1


def band(x, lo, hi):
    return lp(x, hi) - lp(x, lo)


mix = np.zeros_like(ts_)
place(kick(70, 30, 0.9, 2.0) * db(-6), T_DOWN[0], mix)
place(clack(db(-8)), T_DOWN[0], mix)
# 한 명씩 켜질 때 철컥
for k, (t0, t1) in SPOTS.items():
    place(clack(db(-5)), t0, mix)
    place(clack(db(-14)), t1 - 0.02, mix)
# 소녀: 무전 잡음(켜질 때 쏴) + 물결마다 삐
g0, g1 = SPOTS['girl']
gk = ((ts_ >= g0) & (ts_ < g1 + 0.2)).astype(np.float64)
static = band(noise, 1200, 5200) * gk * (0.25 + 0.75 * np.exp(-np.clip(ts_ - g0, 0, None) / 0.35)) * (1 - smooth((ts_ - g1) / 0.2))
mix += static * db(-24)
for k_, tr in enumerate(RING_T):
    place(tone(1320 if k_ % 2 == 0 else 1760, 0.25, 0.003, 0.07) * db(-20), g0 + tr, mix)
    place(tone(660, 0.6, 0.01, 0.25) * db(-30), g0 + tr, mix)
# 가면 남자: 쇠 울림(빛 띠와 같이) + 줄 네온마다 낮은 기계음 + 눈 반짝
m0, m1 = SPOTS['man']
for f, lv in [(311.0, -26), (466.0, -30), (622.0, -33), (933.0, -36)]:
    seg = tone(f, 2.0, 0.08, 0.9)
    place(seg * db(lv), m0 + 0.45, mix)
for st in [0.35, 1.25, 2.05]:
    n = int(0.75 * SR)
    tt = np.arange(n) / SR
    whirr = np.sin(2 * np.pi * np.cumsum(140 + 260 * tt / 0.75) / SR) * np.sin(np.pi * tt / 0.75) ** 2
    place((whirr * 0.6 + band(rng.standard_normal(n), 400, 2400) * np.sin(np.pi * tt / 0.75) ** 2 * 0.5) * db(-24), m0 + st, mix)
place(tone(3136, 0.6, 0.002, 0.18) * db(-28), m0 + 2.15, mix)
# 소년: 판 잡음(톡톡) + 가루 방울 소리(브금 C 마디 음: E G A C)
b0, b1 = SPOTS['boy']
crk = np.zeros_like(ts_)
pops = rng.uniform(b0, RELIGHT['boy'] + 1.0, 160)
for tp in pops:
    place(band(rng.standard_normal(int(0.004 * SR)), 1500, 6000) * rng.uniform(0.3, 1.0), tp, crk)
mix += crk * db(-24)
for k_ in range(9):
    place(tone([1319, 1568, 1760, 2093][k_ % 4], 0.5, 0.002, 0.25) * db(-31), b0 + 0.5 + k_ * 0.27, mix)
# 끝: 철컥 셋 + 올라가는 잡음 + OFF THE 쉭 + RECORD 쾅
for k, tr in RELIGHT.items():
    place(clack(db(-6)), tr, mix)
rk = np.clip((ts_ - 11.2) / (T_SLAM - 11.2), 0, 1) * (ts_ < T_SLAM)
mix += lp_var(noise, 400 + 7000 * rk ** 2) * rk ** 2.2 * db(-15)
n = int(0.35 * SR)
tt = np.arange(n) / SR
place(band(rng.standard_normal(n), 800, 6000) * np.sin(np.pi * tt / 0.35) ** 2 * db(-16), T_TITLE - 0.1, mix)
tt = ts_ - T_SLAM
on = tt >= 0
br = sum(saw(f * (1 + 0.004 * j), ts_) for j, f in enumerate([55.0, 55.3, 110.0, 82.4, 164.8, 220.0])) / 6
cut = 220 + 1600 * np.exp(-np.clip(tt, 0, None) / 0.35) * on + 200 * on
br = lp_var(br, cut) * on * np.exp(-np.clip(tt, 0, None) / 1.1) * np.minimum(1, np.clip(tt, 0, None) / 0.01)
mix += br * db(-5)
place(kick(90, 28, 1.2, 2.2) * db(-3), T_SLAM, mix)
mix += band(noise, 300, 7000) * on * np.exp(-np.clip(tt, 0, None) / 0.25) * db(-13)
for f, lv in [(2637, -25), (3951, -29), (5274, -33)]:
    mix += np.sin(2 * np.pi * f * ts_) * on * np.exp(-np.clip(tt - 0.02, 0, None) / 0.5) * db(lv)
t2 = ts_ - (T_SLAM + 0.95)
mix += np.sin(2 * np.pi * 3520 * ts_) * (t2 >= 0) * np.exp(-np.clip(t2, 0, None) / 0.35) * db(-31)
mix *= np.clip((DUR - 0.3 - ts_) / 0.8, 0, 1)
# 브금을 만들어(48kHz 스테레오) 효과음과 섞는다
bgm_npy = os.path.join(tempfile.mkdtemp(), 'otr_bgm.npy')
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_otr_bgm.py'), bgm_npy], check=True)
bgm = np.load(bgm_npy).astype(np.float64)
n_ = min(bgm.shape[1], len(mix))
st = bgm[:, :n_] * db(BGM_DB) + np.stack([mix[:n_], mix[:n_]]) * db(SFX_DB) * 2.2


def follow(x, att, rel):
    # 올라갈 때 att초, 내려갈 때 rel초로 따라가는 봉투
    a_att, a_rel = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    out = np.empty_like(x)
    e = 0.0
    for i, v in enumerate(x):
        a = a_att if v > e else a_rel
        e = a * e + (1 - a) * v
        out[i] = e
    return out


# 쾅만 혼자 크고 앞이 작지 않게: 누르고(-24dB 넘는 만큼 1/3로) 봉우리를 -1.5dB에서 자른다(4ms 미리 보기)
st /= np.abs(st).max()
a_ = np.exp(-1 / (0.03 * SR))
lvl = np.sqrt(lfilter([1 - a_], [1, -a_], (st ** 2).mean(0)))
gr = np.minimum(1, (np.maximum(lvl, 1e-9) / db(-24)) ** (1 / 3.0 - 1))
st *= 1 - follow(1 - gr, 0.005, 0.18)
need = np.minimum(1, db(-1.5) / np.maximum(np.abs(st).max(0), 1e-9))
need = np.minimum.reduce([np.roll(need, -k_) for k_ in range(0, int(0.004 * SR), 8)])
st *= 1 - follow(1 - need, 0.0005, 0.08)
st *= db(-1.0) / np.abs(st).max()
mix = st
pcm = (np.clip(st.T, -1, 1) * 32767).astype(np.int16)
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
idx = list(range(0, N, 8))
th = [cv2.resize(frames[i], (180, 259), interpolation=cv2.INTER_AREA) for i in idx]
for j, i in enumerate(idx):
    cv2.putText(th[j], f'{i / FPS:.2f}', (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
cols = 9
while len(th) % cols:
    th.append(np.zeros_like(th[0]))
cv2.imwrite(stem + '_sheet.jpg', np.vstack([np.hstack(th[r * cols:(r + 1) * cols]) for r in range(len(th) // cols)]), [cv2.IMWRITE_JPEG_QUALITY, 85])
print('결과', OUT, f'{N / FPS:.2f}초')
