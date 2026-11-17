# OFF THE RECORD 포스터 영상용 인트로 브금(15초, 48kHz 스테레오 float32 .npy)
# 영상 시간표에 맞춘다: 80BPM(한 마디 3초), 마디 시작 = 2.1(소녀) 5.1(가면 남자) 8.1(소년) 11.1(마무리 쌓기), 쾅 = 12.7
# 화음: Am(소녀) → F(가면 남자) → C(소년) → E(쌓기) → 쾅 Am. 90년대 애니 오프닝풍 신스 금관 + 현 반복 + 북 + 합창 + 잔향
# 사용: python tools/make_otr_bgm.py <out.npy> (보통은 tools/make_otr_spotlight.py가 불러 만든다)
# 코드로 합성한다(녹음·AI 음악 없음, 크레딧 없음). 웅장한 인트로풍은 2026-11-17 사용자 제안, 편곡·음색은 이쪽에서 정했다
import sys
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

OUT = sys.argv[1]
SR = 48000
DUR = 15.0
NS = int(SR * DUR)
BEAT = 0.75
BAR = [2.1, 5.1, 8.1, 11.1]
T_DOWN = 0.8
T_SLAM = 12.7
GAP = (12.52, 12.69)       # 쾅 직전 숨 멎음
rng = np.random.default_rng(7)


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def filt(x, kind, fc, order=2):
    return sosfilt(butter(order, fc, kind, fs=SR, output='sos'), x)


def osc_saw(f, length, cents=(0,), vib=0.0, vib_rate=5.2, vib_delay=0.25):
    tt = np.arange(int(length * SR)) / SR
    vibr = 1 + vib * np.sin(2 * np.pi * vib_rate * tt) * np.clip((tt - vib_delay) / 0.3, 0, 1)
    out = np.zeros_like(tt)
    for c in cents:
        ff = f * 2 ** (c / 1200)
        ph = np.cumsum(ff * vibr) / SR + rng.uniform()
        out += 2 * (ph % 1) - 1
    return out / len(cents)


def env(length, a, r, hold_level=1.0, d=0.0, s=1.0):
    N = int(length * SR)
    tt = np.arange(N) / SR
    e = np.minimum(1, tt / max(a, 1e-4))
    if d > 0:
        e = np.where(tt > a, s + (1 - s) * np.exp(-(tt - a) / d), e)
    rr = int(r * SR)
    if rr > 0:
        e[-rr:] *= np.linspace(1, 0, rr) ** 2
    return e * hold_level


# 버스(스테레오)
BUS = {k: np.zeros((2, NS)) for k in ['str', 'pad', 'brass', 'choir', 'drum', 'fx']}


def put(bus, seg, t0, pan=0.0, gain=1.0):
    i0 = int(round(t0 * SR))
    if i0 >= NS or i0 + len(seg) <= 0:
        return
    s0 = max(0, -i0)
    i0 = max(0, i0)
    m = min(len(seg) - s0, NS - i0)
    gl, gr = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
    BUS[bus][0, i0:i0 + m] += seg[s0:s0 + m] * gain * gl
    BUS[bus][1, i0:i0 + m] += seg[s0:s0 + m] * gain * gr


# ── 악기 ──
def ost_note(m, t0, vel, pan):
    L = 0.24
    x = osc_saw(mtof(m), L, (-8, 0, 8))
    tt = np.arange(len(x)) / SR
    x = filt(x, 'low', 900 + 1600 * vel) * np.minimum(1, tt / 0.004) * np.exp(-tt / 0.11)
    put('str', x, t0, pan, 0.55 * vel)


def pad(notes, t0, length, level, cutoff, a=0.5, r=0.7):
    for j, m in enumerate(notes):
        x = osc_saw(mtof(m), length, (-11, -5, 0, 5, 11), vib=0.0015, vib_rate=4.6)
        x = filt(x, 'low', cutoff) * env(length, a, r)
        put('pad', x, t0, (j / max(1, len(notes) - 1) - 0.5) * 1.1, level / len(notes) ** 0.5)


def brass(m, t0, length, vel, pan=0.0):
    x = osc_saw(mtof(m), length + 0.25, (-6, 0, 6), vib=0.004, vib_rate=5.5, vib_delay=0.35)
    tt = np.arange(len(x)) / SR
    fe = np.clip(tt / 0.07, 0, 1) * (0.55 + 0.45 * np.exp(-np.clip(tt - 0.07, 0, None) / 0.35))
    dark, bright = filt(x, 'low', 450), filt(x, 'low', 3600)
    y = dark * (1 - fe) + bright * fe
    y = filt(y, 'high', 120) * env(len(x) / SR, 0.035, 0.22)
    put('brass', y, t0, pan, 0.5 * vel)


def choir(notes, t0, length, level, a=0.9, r=0.9):
    for j, m in enumerate(notes):
        x = osc_saw(mtof(m), length, (-9, -3, 3, 9), vib=0.006, vib_rate=5.0, vib_delay=0.1)
        y = filt(x, 'band', (600, 850), 2) * 1.0 + filt(x, 'band', (1050, 1350), 2) * 0.55 + filt(x, 'band', (2400, 2900), 2) * 0.22
        y = y * env(length, a, r)
        put('choir', y, t0, (j - (len(notes) - 1) / 2) * 0.45, level * 2.4 / len(notes) ** 0.5)


def taiko(t0, vel, pitch=1.0, pan=None):
    L = 0.9
    tt = np.arange(int(L * SR)) / SR
    f = (55 + 95 * np.exp(-tt / 0.035)) * pitch
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.42)
    n = rng.standard_normal(len(tt))
    hit = filt(n, 'low', 1400) * np.exp(-tt / 0.018) * 0.9 + filt(n, 'low', 320) * np.exp(-tt / 0.11) * 0.6
    put('drum', (body + hit) * vel, t0, rng.uniform(-0.25, 0.25) if pan is None else pan, 0.9)


def ka(t0, vel):
    # 높은 북(굴림용)
    L = 0.25
    tt = np.arange(int(L * SR)) / SR
    f = 150 + 160 * np.exp(-tt / 0.02)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.09)
    n = filt(rng.standard_normal(len(tt)), 'band', (700, 3500)) * np.exp(-tt / 0.03)
    put('drum', (body * 0.8 + n * 0.6) * vel, t0, rng.uniform(-0.5, 0.5), 0.55)


def crash(t0, vel, L=3.5):
    tt = np.arange(int(L * SR)) / SR
    n = rng.standard_normal(len(tt))
    y = (filt(n, 'high', 3500) * 0.8 + filt(n, 'band', (900, 3500)) * 0.25) * np.exp(-tt / 1.1) * np.minimum(1, tt / 0.003)
    put('fx', y * vel, t0, -0.3, 0.35)
    n2 = rng.standard_normal(len(tt))
    put('fx', (filt(n2, 'high', 3500) * 0.8) * np.exp(-tt / 1.1) * np.minimum(1, tt / 0.003) * vel, t0, 0.3, 0.35)


def swell(t_end, L, vel):
    tt = np.arange(int(L * SR)) / SR
    n = filt(rng.standard_normal(len(tt)), 'high', 2500)
    y = n * (tt / L) ** 3
    put('fx', y * vel, t_end - L, rng.uniform(-0.2, 0.2), 0.45)


def sub_boom(t0, vel, L=2.2):
    tt = np.arange(int(L * SR)) / SR
    f = 30 + 40 * np.exp(-tt / 0.12)
    put('drum', np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.9) * np.minimum(1, tt / 0.004) * vel, t0, 0.0, 1.0)


# ── 편곡 ──
A2, E2, F2, C3, A1 = 45, 40, 41, 48, 33
# 처음(포스터): 높은 현 화음이 옅게 → 불 꺼짐에 쿵
pad([69, 72, 76, 81], 0.0, 0.95, 0.22, 2600, a=0.3, r=0.25)
sub_boom(T_DOWN, 0.9)
taiko(T_DOWN, 1.0, 0.85, 0.0)
crash(T_DOWN, 0.35, 2.5)
# 어둠: 낮은 A 깔림 + 쓸려 올라가 마디 1로
pad([A1, A2], T_DOWN + 0.05, BAR[0] - T_DOWN + 0.3, 0.30, 500, a=0.5, r=0.3)
swell(BAR[0], 1.2, 0.55)

# 현 반복(16분): 근음·옥타브·5도
def ost_bar(root, t0, vel0, vel1, beats=4, pat=(0, 0, 12, 0, 7, 0, 12, 7)):
    steps = int(beats * 4)
    for s in range(steps):
        v = vel0 + (vel1 - vel0) * s / max(1, steps - 1)
        acc = 1.0 if s % 4 == 0 else 0.78
        ost_note(root + pat[s % len(pat)], t0 + s * BEAT / 4, v * acc, -0.35 if s % 2 else 0.35)


CH = [  # 근음(현 반복), 바닥 화음, 합창
    (A2, [45, 52, 57, 60, 64], [69, 72, 76]),
    (F2, [41, 48, 53, 57, 60], [65, 69, 72]),
    (C3 - 12, [36, 43, 48, 52, 55], [67, 72, 76]),
    (E2, [40, 47, 52, 56, 59], [68, 71, 76]),
]
VEL = [(0.6, 0.7), (0.68, 0.8), (0.78, 0.9), (0.85, 1.0)]
for b, (root, padn, chn) in enumerate(CH):
    t0 = BAR[b]
    beats = 4 if b < 3 else (GAP[0] - t0) / BEAT
    ost_bar(root, t0, *VEL[b], beats=beats)
    L = 3.0 + 0.4 if b < 3 else GAP[0] - t0 + 0.02
    pad(padn, t0, L, 0.38 + 0.05 * b, 900 + 500 * b, a=0.25, r=0.4 if b < 3 else 0.02)
    if b >= 2:
        choir(chn, t0, L, 0.22 if b == 2 else 0.32, a=1.2 if b == 2 else 0.6, r=0.5 if b == 2 else 0.02)

# 북
B = BEAT
for x in [0, 2]:
    taiko(BAR[0] + x * B, 0.55)
for x in [0, 1.5, 2, 3]:
    taiko(BAR[1] + x * B, 0.7)
for x in [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]:
    taiko(BAR[2] + x * B, 0.85 if x % 1 == 0 else 0.55)
for x in [0, 1, 2, 3]:
    ka(BAR[2] + (x + 0.75) * B, 0.35)
# 마무리 쌓기: 8분 → 16분 굴림이 커지며 숨 멎음 전까지
t = BAR[3]
k = 0
while t < GAP[0] - 0.02:
    prog = (t - BAR[3]) / (GAP[0] - BAR[3])
    taiko(t, 0.6 + 0.4 * prog) if k % 2 == 0 else ka(t, 0.35 + 0.55 * prog)
    t += B / 2 if prog < 0.5 else B / 4
    k += 1
swell(T_SLAM - 0.05, 1.6, 0.8)

# 금관 가락(가면 남자 마디부터): F 마디 A C A G / C 마디 G C E / E 마디 B D E G# 올라가다 멎음
MEL = [
    (BAR[1], [(69, 1.5), (72, 0.5), (69, 1.0), (67, 1.0)]),
    (BAR[2], [(67, 1.5), (72, 0.5), (76, 2.0)]),
    (BAR[3], [(71, 0.5), (74, 0.5), (76, 0.5), (80, 0.53)]),
]
for t0, notes in MEL:
    tt = t0
    for m, beats in notes:
        L = beats * BEAT
        if tt + L > GAP[0]:
            L = GAP[0] - tt
        brass(m, tt, L - 0.02, 0.8 if t0 == BAR[1] else 0.95, 0.1)
        brass(m - 12, tt, L - 0.02, 0.35, -0.2)
        tt += beats * BEAT

# 쾅: Am 전부
SL = DUR - T_SLAM
pad([33, 45, 52, 57, 60, 64], T_SLAM, SL, 0.62, 2600, a=0.01, r=1.2)
choir([69, 72, 76, 81], T_SLAM, SL, 0.42, a=0.05, r=1.4)
for m, v in [(57, 0.8), (64, 0.75), (69, 0.95), (72, 0.75), (76, 0.85)]:
    brass(m, T_SLAM, SL - 0.3, v, rng.uniform(-0.4, 0.4))
taiko(T_SLAM, 1.3, 0.8, 0.0)
taiko(T_SLAM + 0.02, 1.0, 1.15)
sub_boom(T_SLAM, 1.1, 2.3)
crash(T_SLAM, 1.0, 2.3)

# ── 숨 멎음 · 잔향 · 섞기 ──
tt = np.arange(NS) / SR
gate = 1 - np.clip((tt - GAP[0]) / 0.012, 0, 1) * (tt < T_SLAM - 0.004)
gate = np.where(tt >= T_SLAM - 0.004, 1.0, gate)
GAIN = {'str': 0.55, 'pad': 0.7, 'brass': 0.62, 'choir': 0.55, 'drum': 0.8, 'fx': 0.5}
SEND = {'str': 0.25, 'pad': 0.35, 'brass': 0.35, 'choir': 0.55, 'drum': 0.3, 'fx': 0.2}
dry = np.zeros((2, NS))
wet_in = np.zeros((2, NS))
for k_, b in BUS.items():
    b = b * gate
    dry += b * GAIN[k_]
    wet_in += b * GAIN[k_] * SEND[k_]
IRL = int(2.8 * SR)
ti = np.arange(IRL) / SR
wet = np.zeros((2, NS))
for c in range(2):
    ir = rng.standard_normal(IRL) * np.exp(-ti / 0.42)
    ir = filt(ir, 'low', 5500)
    ir[:int(0.022 * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum())
    wet[c] = fftconvolve(wet_in[c], ir)[:NS]
mix = dry + wet * 0.9
# 쾅 직전 숨 멎음은 잔향까지 끊는다(쾅이 더 크게 들리게)
mix *= np.where((tt >= GAP[0] + 0.03) & (tt < T_SLAM - 0.004), 0.08, 1.0)
mix *= np.clip((DUR - 0.05 - tt) / 0.9, 0, 1)
mix = filt(mix, 'high', 28)
np.save(OUT, mix.astype(np.float32))
pk = np.abs(mix).max()
print('브금 봉우리', round(20 * np.log10(pk), 1), 'dB, 평균', round(20 * np.log10(np.sqrt((mix ** 2).mean())), 1), 'dB')
