# 캐릭터 반복 영상(숨쉬기·머리카락 흔들림) → 사진 앱이 읽는 "위 색 · 아래 알파" H.264 mp4.
#
# 왜 이 형식인가: 알파 채널 영상(WebM VP9 알파, HEVC 알파)은 iOS 사파리와 안드로이드 크롬 둘 다에서 되는 것이 없다.
# 그래서 한 프레임에 색(위 절반)과 알파(아래 절반, 회색)를 쌓은 평범한 H.264로 만들고, 앱(otr/움직임.js)이 WebGL로 합친다.
#
# 원본 조건(AI 영상 모델 결과): 마젠타(#FF00FF) 단색 바탕, 5초 안팎, 첫 장면 = 끝 장면 = 캐릭터 누끼 그림.
# 하는 일
#  1) 바탕 빼기: 색 차이 키(min(R,B) - G)로 섞인 비율대로 알파(마젠타와 아주 먼 색은 Lab 거리로 불투명), 작은 얼룩 지우기,
#     가장자리는 가장 가까운 불투명 색과 바탕을 잇는 선 위에서 섞인 비율을 다시 재고 색을 되돌린 뒤, 남은 마젠타 번짐을 누른다
#  2) 맞추기: 첫 장면의 알파를 캐릭터 PNG 알파에 맞춰(머리~발 상자로 크기·자리를 잡고 ECC로 다듬음) PNG와 같은 그림 판·발 자리로 옮긴다.
#     그래서 캐릭터.json의 top·feet 값이 영상에도 그대로 맞는다
#  3) 흔들림 잡기: 프레임마다 발 쪽(아래 18%) 알파가 첫 장면에서 얼마나 밀렸는지 재서(위상 상관) 그만큼 되돌린다.
#     상체·머리카락의 움직임은 그대로 두고, AI 영상이 통째로 미끄러지는 것만 잡는다
#  4) 이음매: 끝 장면이 첫 장면과 같으면 끝 장면을 뺀다(반복할 때 한 프레임 멈춤 방지). 다르면 끝 몇 장을 첫 장면 쪽으로 섞는다
#  5) 쌓기·인코딩: 색은 투명한 곳까지 가장 가까운 색으로 번져 두고(가장자리 테 방지), 알파는 회색으로. H.264 yuv420p, BT.709,
#     faststart, 용량 한도(기본 1.5MB) 안에 들 때까지 화질 값(CRF)을 올린다. 반 높이는 16의 배수(기본 960: 쌓으면 1920)
#
# 쓰는 법
#   python tools/make_alpha_loop.py <원본 영상.mp4> <캐릭터 PNG> <출력.mp4> [--half-h 960] [--max-mb 1.5] [--key ff00ff]
#   python tools/make_alpha_loop.py --placeholder <캐릭터 PNG> <출력.mp4> [--seconds 4] [--keep-source <가짜 원본.mp4>]
#     --placeholder: AI 영상이 오기 전 자리 채움. PNG로 숨쉬기·머리카락 흔들림(4초 반복)을 만들어 마젠타 바탕 영상으로 굽고
#     (일부러 조금 미끄러지게), 위 1)~5)를 똑같이 거친다(전체 경로 시험)
#   --sheet <png>: 결과를 다시 풀어 몇 장을 바둑판 위에 늘어놓은 확인 그림
# 필요: ffmpeg·ffprobe(PATH), Python 3 + numpy, opencv-python, Pillow
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image

KEY_DEFAULT = 'ff00ff'


def imread_rgba(path):
    im = Image.open(path).convert('RGBA')
    return np.array(im)


def ffprobe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames',
                          '-of', 'json', path], capture_output=True, check=True).stdout
    st = json.loads(out)['streams'][0]
    num, den = st['r_frame_rate'].split('/')
    return int(st['width']), int(st['height']), float(num) / float(den)


def read_frames(path):
    w, h, fps = ffprobe(path)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    n = w * h * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.wait()


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ── 1) 바탕 빼기 ─────────────────────────────────────
def to_lab(rgb):
    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2LAB)


def estimate_key(frame, fallback):
    # 화면 둘레 8px 띠의 중앙값. 기대한 마젠타와 너무 다르면(캐릭터가 둘레에 닿음) 기대값
    b = 8
    ring = np.concatenate([frame[:b].reshape(-1, 3), frame[-b:].reshape(-1, 3), frame[:, :b].reshape(-1, 3), frame[:, -b:].reshape(-1, 3)])
    med = np.median(ring, 0)
    lab = to_lab(med.reshape(1, 1, 3))[0, 0]
    flab = to_lab(np.array(fallback, np.float32).reshape(1, 1, 3))[0, 0]
    return med if np.linalg.norm(lab - flab) < 35 else np.array(fallback, np.float32)


def key_frame(frame, key_rgb, t0=55.0, t1=80.0):
    # 알파 = 색 차이 키(마젠타의 신호 min(R,B) - G는 바탕과 섞인 비율에 거의 비례한다) 를 기본으로,
    # 마젠타와 색이 아주 먼 픽셀(Lab 거리)은 불투명으로 살린다(보라·분홍 소품이 반투명해지지 않게).
    # Lab 거리만 쓰면 가장자리 알파가 실제 섞인 비율보다 커서 색을 되돌려도 보라 테가 남았다
    f = frame.astype(np.float32)
    key = np.array(key_rgb, np.float32)
    dk = max(1.0, min(key[0], key[2]) - key[1])
    dc = np.minimum(f[..., 0], f[..., 2]) - f[..., 1]
    a_cd = 1 - np.clip(dc / dk, 0, 1)
    lab = to_lab(frame)
    k = to_lab(key.reshape(1, 1, 3))[0, 0]
    d = np.sqrt(0.35 * (lab[..., 0] - k[0]) ** 2 + (lab[..., 1] - k[1]) ** 2 + (lab[..., 2] - k[2]) ** 2)
    a = np.maximum(a_cd, smoothstep(t0, t1, d)).astype(np.float32)
    a = np.where(a < 0.03, 0, a)  # 바탕의 압축 잡음
    a = clean_alpha(a)
    f, a = refine_edges(f, a, key)
    rgb = despill(f, a, key)
    return rgb, a


def refine_edges(f, a, key):
    # 가장자리(반투명)를 다시 푼다: 가장 가까운 불투명 픽셀 색 Fn과 바탕 K를 잇는 선 위로 지금 색을 내려
    # 섞인 비율(알파)을 잰다. 색 차이 키는 바탕과 먼 색(청록 머리카락 등)에서 알파를 크게 잡아 색을 되돌려도 남색 테가 남았다
    solid = (a > 0.9).astype(np.uint8)
    if solid.sum() == 0:
        return f, a
    dist, labels = cv2.distanceTransformWithLabels(1 - solid, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(solid)
    lut = np.zeros((labels.max() + 1, 3), np.float32)
    lut[1:len(ys) + 1] = f[ys, xs]
    near = lut[labels]
    edge = (a > 0) & (a <= 0.9) & (dist < 10)
    v = near[edge] - key
    c = f[edge] - key
    a2 = np.clip((c * v).sum(1) / np.maximum((v * v).sum(1), 1.0), 0, 1)
    a = a.copy()
    a[edge] = a2
    out = f.copy()
    w = a2[:, None]
    unmixed = np.clip((f[edge] - (1 - w) * key) / np.maximum(w, 0.1), 0, 255)
    out[edge] = unmixed * w + near[edge] * (1 - w)  # 알파가 낮을수록 가까운 불투명 색을 믿는다
    return out, a


def clean_alpha(a):
    # 작은 얼룩(바탕에 남은 점, 몸 밖 잡티) 지우기: 가장 큰 덩어리의 0.3% 미만 덩어리는 버린다
    solid = (a > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, 8)
    if n <= 2:
        return a
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros(n, bool)
    keep[1:] = areas >= areas.max() * 0.003
    mask = keep[lab].astype(np.uint8)
    # 가장자리의 반투명은 살린다: 남긴 덩어리 둘레 3px 안만
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    return a * mask


def despill(rgb, a, key):
    # 색 되돌리기는 refine_edges가 했다(C = aF + (1-a)K → F)
    out = rgb.copy()
    # 그래도 남은 마젠타 번짐(빨강·파랑이 초록보다 함께 높음)을 가장자리 띠(6px)에서만 누른다(몸 안의 분홍·보라는 그대로)
    solid = (a > 0.5).astype(np.uint8)
    dist = cv2.distanceTransform(solid, cv2.DIST_L2, 3)
    band = (a > 0) & (dist < 6)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    m = np.minimum(r, b) - g
    sup = np.where(band & (m > 0), m, 0)  # 빨강·파랑 중 낮은 쪽을 초록까지 내린다(yuv420 색 번짐으로 생긴 보라 테)
    out[..., 0] = r - sup
    out[..., 2] = b - sup
    return out


# ── 2) 맞추기 ───────────────────────────────────────
def bbox(a, th=0.5):
    ys, xs = np.nonzero(a > th)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def bottom_center(a, th=0.5):
    # 발 쪽 아래 6%의 가로 가운데와 맨 아래 줄
    x0, y0, x1, y1 = bbox(a, th)
    band = a[int(y1 - (y1 - y0) * 0.06):y1] > th
    xs = np.nonzero(band.any(0))[0]
    return (xs.min() + xs.max() + 1) / 2, y1


def align(src_a, png_a):
    # PNG 좌표 → 원본 좌표 2x3 행렬(cv2.warpAffine(..., WARP_INVERSE_MAP)에 그대로)
    sx0, sy0, sx1, sy1 = bbox(src_a)
    px0, py0, px1, py1 = bbox(png_a)
    s = (sy1 - sy0) / (py1 - py0)  # PNG 1px = 원본 s px
    scx, sby = bottom_center(src_a)
    pcx, pby = bottom_center(png_a)
    M = np.array([[s, 0, scx - s * pcx], [0, s, sby - s * pby]], np.float32)
    # ECC로 다듬기(작게 줄여서). 알파를 흐려서 비교한다
    k = 360 / png_a.shape[0]
    tpl = cv2.GaussianBlur(cv2.resize(png_a, None, fx=k, fy=k, interpolation=cv2.INTER_AREA), (0, 0), 2)
    ks = k  # 원본도 같은 배율로 줄이면 행렬은 이동만 k배
    inp = cv2.GaussianBlur(cv2.resize(src_a, None, fx=ks, fy=ks, interpolation=cv2.INTER_AREA), (0, 0), 2)
    W = M.copy()
    W[:, 2] *= k
    try:
        _, W = cv2.findTransformECC(tpl.astype(np.float32), inp.astype(np.float32), W, cv2.MOTION_AFFINE,
                                    (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
        W[:, 2] /= k
        # 크게 벗어나면(실패) 상자 맞춤을 쓴다
        if abs(W[0, 0] / s - 1) < 0.08 and abs(W[1, 1] / s - 1) < 0.08 and abs(W[0, 1]) < 0.05 * s and abs(W[1, 0]) < 0.05 * s:
            M = W
    except cv2.error:
        pass
    return M


# ── 3) 흔들림 잡기 ───────────────────────────────────
def feet_shift(ref_band, band):
    win = cv2.createHanningWindow(ref_band.shape[::-1], cv2.CV_32F)
    (dx, dy), resp = cv2.phaseCorrelate(ref_band.astype(np.float32), band.astype(np.float32), win)
    return dx, dy, resp


# ── 5) 쌓기 ─────────────────────────────────────────
def bleed_colors(rgb, a):
    # 투명한 곳을 가장 가까운 불투명 픽셀 색으로 채운다(필터링·압축 때 가장자리에 검정·마젠타 테가 생기지 않게)
    solid = (a > 0.5).astype(np.uint8)
    if solid.sum() == 0:
        return rgb
    _, labels = cv2.distanceTransformWithLabels(1 - solid, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(solid)  # 라벨 번호는 0인 픽셀(여기서는 불투명 픽셀)의 래스터 순서대로 1부터
    lut = np.zeros((labels.max() + 1, 3), np.float32)
    lut[1:len(ys) + 1] = rgb[ys, xs]
    filled = lut[labels]
    out = np.where((a > 0.5)[..., None], rgb, filled)
    # 반투명 자리는 원래 색(되돌린 색)과 채운 색을 알파로 섞는다
    semi = (a > 0.02) & (a <= 0.5)
    out[semi] = rgb[semi] * a[semi, None] * 2 + filled[semi] * (1 - a[semi, None] * 2)
    return out


def stack(rgb, a):
    color = np.clip(bleed_colors(rgb, a), 0, 255).astype(np.uint8)
    alpha = np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)
    return np.concatenate([color, np.repeat(alpha[..., None], 3, 2)], 0)


def encode(raw_path, w, h, fps, out, max_mb):
    size = None
    for crf in (16, 18, 20, 22, 24, 26, 28, 30, 32):
        cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', f'{fps:g}', '-i', raw_path,
               '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
               '-c:v', 'libx264', '-preset', 'slow', '-crf', str(crf), '-profile:v', 'main', '-level', '4.0',
               '-g', str(max(1, round(fps * 2))), '-pix_fmt', 'yuv420p',
               '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
               '-movflags', '+faststart', '-an', out]
        subprocess.run(cmd, check=True)
        size = os.path.getsize(out)
        if size <= max_mb * 1048576:
            return crf, size
    return crf, size


# ── 자리 채움 원본(AI 영상 대신) ───────────────────────
def placeholder_source(png_path, out, seconds, fps=24, W=720, H=1440):
    # make_frames.py(메인 세션)와 같은 놓기: 위아래 50px, 양옆 30px 여백, 가운데, 아래 맞춤
    rgba = imread_rgba(png_path).astype(np.float32)
    ph, pw = rgba.shape[:2]
    a = rgba[..., 3] / 255
    x0, y0, x1, y1 = bbox(a)
    feet_y = y1 / ph
    top_y = y0 / ph
    yy, xx = np.mgrid[0:ph, 0:pw].astype(np.float32)
    u = np.clip((feet_y - yy / ph) / (feet_y - top_y), 0, 1)  # 0 발 ~ 1 머리 꼭대기
    s = min((H - 100) / ph, (W - 60) / pw)
    cw, chh = round(pw * s), round(ph * s)
    ox, oy = (W - cw) // 2, H - 50 - chh
    n = round(seconds * fps)
    tmp = out + '.raw'
    with open(tmp, 'wb') as fh:
        for k in range(n + 1):  # 마지막 = 처음(AI 원본과 같은 약속)
            t = k / fps
            ph_b = 2 * math.pi * t / seconds
            breath = 0.5 - 0.5 * math.cos(ph_b)  # 들숨·날숨(0..1)
            dy = -0.0045 * ph * breath * smoothstep(0.42, 0.78, u)  # 가슴부터 위로 조금 올라간다(발은 그대로)
            sway = 0.0035 * pw * math.sin(ph_b) * smoothstep(0.3, 1.0, u)  # 상체가 아주 조금 좌우로
            hair = 0.009 * pw * np.sin(2 * ph_b + 6.0 * u) * smoothstep(0.84, 1.0, u)  # 머리카락: 두 번 흔들림, 위로 갈수록
            dx = sway + hair
            mx = (xx - dx).astype(np.float32)
            my = (yy - dy).astype(np.float32)
            fr = cv2.remap(rgba, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            small = cv2.resize(fr, (cw, chh), interpolation=cv2.INTER_AREA)
            # 시험용 미끄러짐(AI 영상처럼): 통째로 가로 4px·세로 2px까지 갔다가 돌아온다
            drift_x = 4.0 * math.sin(math.pi * t / seconds)
            drift_y = 2.0 * math.sin(math.pi * t / seconds)
            canvas = np.zeros((H, W, 4), np.float32)
            M = np.float32([[1, 0, ox + drift_x], [0, 1, oy + drift_y]])
            canvas = cv2.warpAffine(small, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            al = canvas[..., 3:4] / 255
            bg = np.array([255, 0, 255], np.float32)
            frame = canvas[..., :3] * al + bg * (1 - al)
            fh.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(fps), '-i', tmp,
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', out], check=True)
    os.remove(tmp)


# ── 전체 ───────────────────────────────────────────
def convert(src, png_path, out, half_h=960, max_mb=1.5, key_hex=KEY_DEFAULT, stabilize=True, sheet=None):
    if half_h % 16:
        raise SystemExit('--half-h는 16의 배수(압축 블록이 색·알파 경계를 넘지 않게)')
    key = [int(key_hex[i:i + 2], 16) for i in (0, 2, 4)]
    png = imread_rgba(png_path)
    ph, pw = png.shape[:2]
    png_a = png[..., 3].astype(np.float32) / 255
    sw, sh, fps = ffprobe(src)
    frames = list(read_frames(src))
    if not frames:
        raise SystemExit('원본에서 프레임을 못 읽음')
    key_rgb = estimate_key(frames[0], key)
    keyed = [key_frame(f, key_rgb) for f in frames]
    M = align(keyed[0][1], png_a)
    # 발 쪽 띠(원본 좌표, 첫 장면 기준)
    x0, y0, x1, y1 = bbox(keyed[0][1])
    by0 = int(y1 - (y1 - y0) * 0.18)
    by1 = min(sh, int(y1 + (y1 - y0) * 0.03))
    bx0 = max(0, int(x0 - (x1 - x0) * 0.1))
    bx1 = min(sw, int(x1 + (x1 - x0) * 0.1))
    ref = cv2.GaussianBlur(keyed[0][1][by0:by1, bx0:bx1], (0, 0), 1.5)
    shifts = []
    for _, a in keyed:
        if not stabilize:
            shifts.append((0.0, 0.0))
            continue
        dx, dy, resp = feet_shift(ref, cv2.GaussianBlur(a[by0:by1, bx0:bx1], (0, 0), 1.5))
        lim = (x1 - x0) * 0.05
        shifts.append((float(np.clip(dx, -lim, lim)), float(np.clip(dy, -lim, lim))) if resp > 0.05 else (0.0, 0.0))
    # 시간 평활(5장 이동 평균, 반복이므로 앞뒤를 이어서)
    arr = np.array(shifts)
    if stabilize and len(arr) >= 5:
        pad = np.concatenate([arr[-2:], arr, arr[:2]])
        arr = np.stack([np.convolve(pad[:, i], np.ones(5) / 5, 'valid') for i in range(2)], 1)
    # 4) 이음매: 끝 장면 = 첫 장면이면 뺀다
    def aligned(i):
        rgb, a = keyed[i]
        Mi = M.copy()
        Mi[:, 2] += arr[i]  # 원본에서 밀린 만큼 더 읽는다 = 되돌림
        flags = cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP
        rgb_w = cv2.warpAffine(rgb, Mi, (pw, ph), flags=flags, borderMode=cv2.BORDER_REPLICATE)
        a_w = cv2.warpAffine(a, Mi, (pw, ph), flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        return rgb_w, a_w
    first = aligned(0)
    last = aligned(len(keyed) - 1)
    seam = float(np.mean(np.abs(first[1] - last[1])) + np.mean(np.abs(first[0] - last[0]) * first[1][..., None]) / 255)
    count = len(keyed)
    dropped = False
    if seam < 0.012 and count > 2:  # 압축 잡음 정도의 차이면 같은 장면
        count -= 1
        dropped = True
    fade = 0 if dropped else min(8, count // 6)
    # 5) 반 크기
    hw = int(round(half_h * pw / ph / 2) * 2)
    raw = tempfile.NamedTemporaryFile(delete=False, suffix='.rgb')
    raw.close()
    # PNG 실루엣 밖으로 나간 움직임: 앱의 그림자·가장자리 빛·걸어 나오기 빛은 PNG 실루엣으로 만든다(합성.js prepareArt).
    # 몸짓이 실루엣 밖으로 크게 나가면 그 부분은 그림자가 안 따라간다. 실루엣을 키의 1.5%만큼 넓힌 것 밖의 넓이 / 캐릭터 넓이
    ref_half = cv2.resize(png_a, (hw, half_h), interpolation=cv2.INTER_AREA)
    grow = max(1, int(round(half_h * 0.015)))
    ref_wide = cv2.dilate((ref_half > 0.5).astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0
    ref_area = max(1, int((ref_half > 0.5).sum()))
    outside = (0.0, 0)
    with open(raw.name, 'wb') as fh:
        for i in range(count):
            rgb, a = aligned(i)
            if fade and i >= count - fade:
                w = (i - (count - fade) + 1) / (fade + 1)
                rgb = rgb * (1 - w) + first[0] * w
                a = a * (1 - w) + first[1] * w
            rgb = cv2.resize(rgb, (hw, half_h), interpolation=cv2.INTER_AREA)
            a = cv2.resize(a, (hw, half_h), interpolation=cv2.INTER_AREA)
            frac = float(((a > 0.5) & ~ref_wide).sum()) / ref_area
            if frac > outside[0]:
                outside = (frac, i)
            fh.write(stack(rgb, a).tobytes())
    crf, size = encode(raw.name, hw, half_h * 2, fps, out, max_mb)
    os.remove(raw.name)
    report = check_output(out, png_a, hw, half_h)
    report['outsidePng'] = {'maxFrac': round(outside[0], 4), 'frame': outside[1]}
    if outside[0] > 0.02:
        print(f'주의: {outside[1]}번 프레임에서 몸짓이 PNG 실루엣 밖으로 캐릭터 넓이의 {outside[0] * 100:.1f}%만큼 나간다. '
              '그림자·가장자리 빛은 PNG 기준이라 그 부분은 따라가지 않는다(움직임을 작게 받거나 PNG를 그 자세에 맞춰 넓힌다)', file=sys.stderr)
    info = {'source': os.path.basename(src), 'sourceSize': [sw, sh], 'fps': round(fps, 3), 'frames': count, 'seconds': round(count / fps, 3),
            'out': os.path.basename(out), 'outSize': [hw, half_h * 2], 'crf': crf, 'mb': round(size / 1048576, 3),
            'key': [int(v) for v in key_rgb], 'align': {'scale': round(float(M[1, 1]), 4), 'tx': round(float(M[0, 2]), 1), 'ty': round(float(M[1, 2]), 1)},
            'stabilize': {'maxShiftPx': round(float(np.abs(arr).max()), 2) if len(arr) else 0}, 'seam': round(seam, 4), 'droppedLast': dropped, 'fade': fade,
            **report}
    if sheet:
        make_sheet(out, sheet, hw, half_h)
    return info


def check_output(out, png_a, hw, half_h):
    # 결과 첫 프레임을 다시 풀어 알파가 PNG(같은 크기로 줄인 것)와 얼마나 겹치는지, 머리·발 줄이 어디인지
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True)
    fr = np.frombuffer(p.stdout, np.uint8).reshape(half_h * 2, hw, 3)
    a = fr[half_h:, :, 1].astype(np.float32) / 255
    ref = cv2.resize(png_a, (hw, half_h), interpolation=cv2.INTER_AREA)
    A = a > 0.5
    B = ref > 0.5
    iou = float((A & B).sum() / max(1, (A | B).sum()))
    _, y0, _, y1 = bbox(a)
    _, ry0, _, ry1 = bbox(ref)
    return {'firstFrameIoU': round(iou, 4), 'topRow': round(y0 / half_h, 4), 'feetRow': round(y1 / half_h, 4), 'pngTopRow': round(ry0 / half_h, 4), 'pngFeetRow': round(ry1 / half_h, 4)}


def make_sheet(out, path, hw, half_h, picks=6):
    frames = list(read_frames(out))
    idx = np.linspace(0, len(frames) - 1, picks).round().astype(int)
    tiles = []
    for i in idx:
        fr = frames[i].astype(np.float32)
        rgb = fr[:half_h]
        a = fr[half_h:, :, 1:2] / 255
        yy, xx = np.mgrid[0:half_h, 0:hw]
        checker = np.where(((yy // 24) + (xx // 24)) % 2 == 0, 190, 120)[..., None].astype(np.float32)
        tiles.append(np.clip(rgb * a + checker * (1 - a), 0, 255).astype(np.uint8))
    Image.fromarray(np.concatenate(tiles, 1)).save(path)


def main():
    ap = argparse.ArgumentParser(description='캐릭터 반복 영상 → 위 색·아래 알파 H.264 mp4')
    ap.add_argument('args', nargs='+')
    ap.add_argument('--placeholder', action='store_true')
    ap.add_argument('--seconds', type=float, default=4.0)
    ap.add_argument('--keep-source')
    ap.add_argument('--half-h', type=int, default=960)
    ap.add_argument('--max-mb', type=float, default=1.5)
    ap.add_argument('--key', default=KEY_DEFAULT)
    ap.add_argument('--no-stabilize', action='store_true')
    ap.add_argument('--sheet')
    o = ap.parse_args()
    if o.placeholder:
        png_path, out = o.args
        src = o.keep_source or (out + '.src.mp4')
        placeholder_source(png_path, src, o.seconds)
    else:
        src, png_path, out = o.args
    info = convert(src, png_path, out, o.half_h, o.max_mb, o.key, not o.no_stabilize, o.sheet)
    if o.placeholder and not o.keep_source:
        os.remove(src)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == '__main__':
    main()
