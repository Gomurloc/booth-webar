# 사진 앱 AR 모드(otr/?ar=1) 확인용 가짜 카메라 영상(y4m)과 정답 파일(json) 만들기.
# 부스 벽(세로 벽 + 바닥)에 OFF THE RECORD 포스터가 걸려 있고, 친구가 폰(세로 540x960, 긴 변 화각 63도)을 들고
# 벽에서 약 2.6m, 높이 1.25m에서 찍는 장면을 광선 추적(평면 셋: 벽·바닥·사람 대역)으로 그린다.
# - ar_main.y4m   3U_Main. 0~5초 포스터를 겨눔(인식·걸어 나오기) → 7초까지 아래로 기울여 바닥까지 → 좌우로 돌림 → 다시 위로
# - ar_occl.y4m   3U_Main. 걸어 나온 뒤 사람 대역이 왼쪽에서 걸어 들어와(레코드 앞을 지나며 가림) 포스터 앞(캐릭터 사이)에 선다.
#                 그 뒤 폰을 오른쪽으로 크게 돌려 포스터가 화면 밖으로 나갔다가 돌아오고(놓친 동안 자이로로 버티는지),
#                 12초부터 사람이 오른쪽으로 걸어 나가 포스터가 다시 보인다(다시 붙는지, 이어 붙이기)
# - ar_second.y4m 3U_Second. 포스터를 겨눔 → 아래로 기울임 → 조금 돌림
# 정답(<이름>.json): 프레임마다 카메라 자세, 그 자세의 기기 방향(deviceorientation alpha·beta·gamma, 세로로 든 폰의 뒤 카메라),
#   캐릭터 발·머리가 있어야 할 화면 점(영상 픽셀; 앱 기본값: 포스터 가운데 1.4m, 벽에서 0.4m, 좌우 ∓0.55m, 키 1.6m), 포스터 네 모서리.
# 프레임 번호는 영상 왼쪽 위(화면에 보이는 자르기 밖) 12칸 막대로 적어 둔다. 확인 스크립트가 이것을 읽어 자이로 값을 맞춰 넣는다.
# 쓰는 법: python tools/make_ar_cams.py <포스터 렌더 폴더(Poster_B2_*.png)> <사람실루엣.png> <출력 폴더(ASCII 경로)> [--only ar_main,ar_occl]
import json
import math
import os
import sys

import cv2
import numpy as np

SRC, SIL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
W, H, FPS = 540, 960, 15
LONG_FOV = 63.0  # 세로(긴 변) 화각. 앱 기본값과 같다
F = (H / 2) / math.tan(math.radians(LONG_FOV) / 2)
CX, CY = W / 2, H / 2
PW = 0.5  # B2 폭. 높이는 포스터 그림 비율대로(인식 대상 그림과 같은 비율)
POSTER_Y = 1.4  # 포스터 가운데 높이
STAND = 0.4  # 캐릭터가 선 자리: 벽에서
CHARS = {'record': -0.55, 'aria': 0.55}
CHAR_H = 1.6
BAR_BITS, BAR_X, BAR_Y, BAR_W, BAR_H = 12, 8, 6, 10, 9
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20261113)


def imread(path, flags=cv2.IMREAD_COLOR):
    # cv2.imread는 윈도의 한글 경로를 못 연다
    return cv2.imdecode(np.fromfile(path, np.uint8), flags)


def load_poster(name, width=1400):
    im = imread(os.path.join(SRC, f'Poster_B2_{name}.png'))
    h = round(im.shape[0] * width / im.shape[1])
    return cv2.resize(im, (width, h), interpolation=cv2.INTER_AREA).astype(np.float32)


def wall_texture():
    # 벽: X -3..3m, Y 0..3m, 1px = 4mm. 밝은 회색 칠 + 얼룩 + 걸레받이
    s = 0.004
    tw, th = int(6 / s), int(3 / s)
    base = np.full((th, tw, 3), (172, 176, 180), np.float32)
    n = cv2.GaussianBlur(rng.normal(0, 1, (th, tw)).astype(np.float32), (0, 0), 30)
    base += (n / (np.abs(n).max() + 1e-6) * 9)[..., None]
    base += rng.normal(0, 2.0, (th, tw)).astype(np.float32)[..., None]
    rows = np.arange(th) * s
    y = 3 - rows  # 윗줄이 3m
    base[y < 0.09] = (96, 98, 102)
    base[(y >= 0.09) & (y < 0.1)] = (70, 72, 76)
    return base, s


def floor_texture():
    # 바닥: X -3..3m, Z 0..5m, 1px = 5mm. 짙은 회갈색 + 60cm 줄눈(원근이 보이게)
    s = 0.005
    tw, th = int(6 / s), int(5 / s)
    base = np.full((th, tw, 3), (92, 104, 112), np.float32)
    n = cv2.GaussianBlur(rng.normal(0, 1, (th, tw)).astype(np.float32), (0, 0), 12)
    base += (n / (np.abs(n).max() + 1e-6) * 10)[..., None]
    base += rng.normal(0, 4.0, (th, tw)).astype(np.float32)[..., None]
    xs = np.arange(tw) * s
    zs = np.arange(th) * s
    gx = (np.abs(((xs + 0.3) % 0.6) - 0.3) < 0.006)
    gz = (np.abs(((zs + 0.3) % 0.6) - 0.3) < 0.006)
    base[:, gx] *= 0.72
    base[gz, :] *= 0.72
    return base, s


WALL, WS = wall_texture()
FLOOR, FS = floor_texture()
sil = imread(SIL, cv2.IMREAD_UNCHANGED).astype(np.float32)
SIL_A = sil[..., 3] / 255.0
PERSON_H = 1.7
PERSON_W = PERSON_H * sil.shape[1] / sil.shape[0]

# 화면 픽셀마다 카메라 좌표 광선(GL: x 오른쪽, y 위, -z 앞)
uu, vv = np.meshgrid(np.arange(W, dtype=np.float32) + 0.5, np.arange(H, dtype=np.float32) + 0.5)
D_CAM = np.stack([(uu - CX) / F, -(vv - CY) / F, -np.ones_like(uu)], -1)


def rot(yaw, pitch, roll):
    # 카메라 → 세계 회전. yaw(+면 왼쪽으로 돎, 세계 Y축), pitch(+면 위로), roll(+면 반시계)
    y, p, r = map(math.radians, (yaw, pitch, roll))
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def project(R, C, P):
    pc = R.T @ (np.asarray(P, float) - C)
    if pc[2] >= -1e-3:
        return None
    return [float(CX + F * pc[0] / -pc[2]), float(CY - F * pc[1] / -pc[2])]


# 세계(X 동쪽, Y 위, Z 벽에서 카메라 쪽 = 남쪽) → 지구 좌표(동, 북, 위)
E = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)


def device_orientation(R):
    # 세로로 든 폰의 뒤 카메라: 기기 축 = GL 카메라 축. 지구←기기 = E·R = Rz(a)·Rx(b)·Ry(g) (W3C)를 풀어 각도로
    M = E @ R
    cb = math.copysign(math.hypot(M[2, 0], M[2, 2]), M[2, 2] if abs(M[2, 2]) > 1e-9 else 1.0)
    beta = math.atan2(M[2, 1], cb)
    if abs(cb) < 1e-6:
        gamma = 0.0
        alpha = math.atan2(M[1, 0], M[0, 0])
    else:
        gamma = math.atan2(-M[2, 0] / cb, M[2, 2] / cb)
        alpha = math.atan2(-M[0, 1] / cb, M[1, 1] / cb)
    return math.degrees(alpha) % 360, math.degrees(beta), math.degrees(gamma)


def remap(tex, mx, my):
    return cv2.remap(tex, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def render(poster, cam, person=None, index=0):
    PH = PW * poster.shape[0] / poster.shape[1]
    R = rot(cam['yaw'], cam['pitch'], cam['roll'])
    C = np.array(cam['C'], float)
    d = D_CAM @ R.T.astype(np.float32)  # 세계 방향
    dx, dy, dz = d[..., 0], d[..., 1], d[..., 2]
    with np.errstate(divide='ignore', invalid='ignore'):
        t_wall = np.where(dz < -1e-6, -C[2] / dz, np.inf)
        t_floor = np.where(dy < -1e-6, -C[1] / dy, np.inf)
    floor_hit = t_floor < t_wall
    t = np.where(floor_hit, t_floor, t_wall)
    X = C[0] + t * dx
    Y = C[1] + t * dy
    Z = C[2] + t * dz
    img = remap(WALL, (X + 3) / WS, (3 - Y) / WS)
    flo = remap(FLOOR, (X + 3) / FS, Z / FS)
    img = np.where(floor_hit[..., None], flo, img)
    # 포스터
    ph, pw = poster.shape[:2]
    pu = (X + PW / 2) / PW * pw
    pv = (POSTER_Y + PH / 2 - Y) / PH * ph
    inside = (~floor_hit) & (pu >= 0) & (pu < pw) & (pv >= 0) & (pv < ph)
    pimg = remap(poster, pu, pv)
    # 가장자리를 부드럽게(1px)
    edge = np.clip(np.minimum.reduce([pu, pw - pu, pv, ph - pv]) / (pw / PW * 0.003), 0, 1)
    a = np.where(inside, edge, 0)[..., None]
    img = img * (1 - a) + pimg * a
    # 바닥 그늘: 벽 가까이 조금 어둡게(실내 빛 흉내)
    shade = np.where(floor_hit, 0.82 + 0.18 * np.clip(Z / 1.5, 0, 1), 1.0)
    img = img * shade[..., None]
    if person is not None:
        zp, xp, yb = person
        with np.errstate(divide='ignore', invalid='ignore'):
            tp = np.where(dz < -1e-6, (zp - C[2]) / dz, np.inf)
        Xp = C[0] + tp * dx
        Yp = C[1] + tp * dy
        su = (Xp - (xp - PERSON_W / 2)) / PERSON_W * sil.shape[1]
        sv = (yb + PERSON_H - Yp) / PERSON_H * sil.shape[0]
        pa = cv2.remap(SIL_A.astype(np.float32), su.astype(np.float32), sv.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        pa = np.where((tp > 0) & (tp < t), pa, 0)[..., None]
        grad = np.clip((Yp - yb) / PERSON_H, 0, 1)[..., None]
        body = np.array([44, 40, 38], np.float32) * (0.85 + 0.3 * grad)  # 짙은 옷(BGR)
        img = img * (1 - pa) + body * pa
    yy = np.linspace(1.05, 0.9, H, dtype=np.float32)[:, None, None]
    r2 = ((uu - CX) / W) ** 2 + ((vv - CY) / H) ** 2
    vign = (1 - 0.35 * r2)[..., None]
    img = img * yy * vign * cam.get('gain', 1.0)
    img += rng.normal(0, 3.0, img.shape).astype(np.float32)
    img = cv2.GaussianBlur(img, (0, 0), 0.6)
    img = np.clip(img, 0, 255).astype(np.uint8)
    # 프레임 번호 막대(보이는 자르기 밖)
    img[BAR_Y - 3:BAR_Y + BAR_H + 3, BAR_X - 3:BAR_X + BAR_BITS * BAR_W + 3] = 128
    for b in range(BAR_BITS):
        v = 255 if (index >> b) & 1 else 0
        img[BAR_Y:BAR_Y + BAR_H, BAR_X + b * BAR_W + 1:BAR_X + (b + 1) * BAR_W - 1] = v
    return img, R, C


def ease(a, b, k):
    k = max(0.0, min(1.0, k))
    return a + (b - a) * (0.5 - 0.5 * math.cos(math.pi * k))


def shake(s):
    return dict(dx=0.006 * math.sin(s * 1.7) + 0.003 * math.sin(s * 4.1 + 1),
                dy=0.005 * math.sin(s * 1.3 + 2) + 0.002 * math.sin(s * 5.3),
                yaw=0.5 * math.sin(s * 0.9 + 0.4), pitch=0.4 * math.sin(s * 1.1), roll=1.2 + 0.6 * math.sin(s * 0.7))


def keyed(s, keys):
    # keys: [(시각, 값)] 사이를 부드럽게
    if s <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if s <= t1:
            return ease(v0, v1, (s - t0) / (t1 - t0))
    return keys[-1][1]


BASE_C = (0.05, 1.25, 2.6)


def cam_main(s):
    sh = shake(s)
    pitch = keyed(s, [(0, 3.0), (5.0, 3.0), (7.0, -9.0), (13.0, -9.0), (14, 1.0)])
    yaw = keyed(s, [(0, 0.0), (7.5, 0.0), (9.5, -11.0), (11.5, 10.0), (13.0, 0.0)])
    return dict(C=(BASE_C[0] + sh['dx'], BASE_C[1] + sh['dy'], BASE_C[2]), yaw=yaw + sh['yaw'], pitch=pitch + sh['pitch'], roll=sh['roll'])


def cam_occl(s):
    sh = shake(s)
    pitch = keyed(s, [(0, 3.0), (5.0, 3.0), (6.5, -9.0)])
    # 사람이 선 뒤(8초~) 오른쪽으로 크게 돌려 포스터가 화면 밖으로 나갔다가(추적을 반드시 놓친다) 11.2초에 돌아온다
    yaw = keyed(s, [(0, 0.0), (8.0, 0.0), (9.4, -24.0), (10.0, -24.0), (11.2, 0.0)])
    if 8.0 < s < 12.0:
        pitch += 2.0 * math.sin((s - 8.0) * math.pi / 2)
    return dict(C=(BASE_C[0] + sh['dx'], BASE_C[1] + sh['dy'], BASE_C[2]), yaw=yaw + sh['yaw'], pitch=pitch + sh['pitch'], roll=sh['roll'])


def person_occl(s):
    # 5.5초부터 왼쪽에서 걸어 들어와 8초에 포스터 앞(조금 왼쪽, 레코드와 겹침)에 선다
    if s < 5.5:
        return None
    # 12초부터 오른쪽으로 걸어 나간다(14초에 화면 밖) → 포스터가 다시 보인다
    x = keyed(s, [(5.5, -1.6), (8.0, -0.05), (12.0, -0.05), (14.0, 1.9)])
    walking = s < 8.0 or 12.0 < s < 14.0
    bob = 0.015 * abs(math.sin((s - 5.5) * 6.0)) if walking else 0.0
    return (0.8, x, bob)


def cam_second(s):
    sh = shake(s)
    pitch = keyed(s, [(0, 3.0), (5.0, 3.0), (7.0, -9.0)])
    yaw = keyed(s, [(0, 0.0), (7.5, 0.0), (8.5, -7.0), (10.0, 0.0)])
    return dict(C=(BASE_C[0] + sh['dx'], BASE_C[1] + sh['dy'], BASE_C[2]), yaw=yaw + sh['yaw'], pitch=pitch + sh['pitch'], roll=sh['roll'])


def truth(R, C, PH):
    chars = {}
    for cid, ox in CHARS.items():
        chars[cid] = {'feet': project(R, C, (ox, 0.0, STAND)), 'head': project(R, C, (ox, CHAR_H, STAND))}
    corners = [project(R, C, (sx * PW / 2, POSTER_Y + sy * PH / 2, 0.0)) for sx, sy in ((-1, 1), (1, 1), (1, -1), (-1, -1))]
    return chars, corners


def write_clip(name, poster_name, seconds, cam_fn, person_fn=None):
    poster = load_poster(poster_name)
    n = int(seconds * FPS)
    meta = {'name': name, 'poster': poster_name, 'fps': FPS, 'w': W, 'h': H, 'f': F, 'longFov': LONG_FOV,
            'world': {'posterY': POSTER_Y, 'stand': STAND, 'chars': CHARS, 'height': CHAR_H},
            'bar': {'bits': BAR_BITS, 'x': BAR_X, 'y': BAR_Y, 'w': BAR_W, 'h': BAR_H}, 'frames': []}
    path = os.path.join(OUT, f'{name}.y4m')
    with open(path, 'wb') as fh:
        fh.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        for i in range(n):
            s = i / FPS
            cam = cam_fn(s)
            person = person_fn(s) if person_fn else None
            img, R, C = render(poster, cam, person, i)
            fh.write(b'FRAME\n')
            fh.write(cv2.cvtColor(img, cv2.COLOR_BGR2YUV_I420).tobytes())
            a, b, g = device_orientation(R)
            chars, corners = truth(R, C, PW * poster.shape[0] / poster.shape[1])
            meta['frames'].append({'i': i, 't': round(s, 4), 'yaw': cam['yaw'], 'pitch': cam['pitch'], 'roll': cam['roll'], 'C': list(map(float, C)),
                                   'alpha': a, 'beta': b, 'gamma': g, 'chars': chars, 'poster': corners,
                                   'person': None if person is None else {'z': person[0], 'x': person[1]}})
            if i in (0, int(4.5 * FPS), int(7 * FPS), int(9.5 * FPS), n - 1):
                cv2.imwrite(os.path.join(OUT, f'{name}_preview_{i:03d}.jpg'), img)
    with open(os.path.join(OUT, f'{name}.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh)
    print(name, n, 'frames', round(os.path.getsize(path) / 1048576), 'MB', flush=True)


if __name__ == '__main__':
    jobs = {
        'ar_main': ('3U_Main', 14, cam_main, None),
        'ar_occl': ('3U_Main', 16, cam_occl, person_occl),
        'ar_second': ('3U_Second', 10, cam_second, None),
    }
    for name, (poster_name, sec, fn, pfn) in jobs.items():
        if ONLY and name not in ONLY:
            continue
        write_clip(name, poster_name, sec, fn, pfn)
