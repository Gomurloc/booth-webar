# 가짜 카메라 영상(y4m) 만들기: 부스 벽에 걸린 메인 포스터를 폰(세로 480x640)으로 약 1m에서 비춘 장면.
# 크롬 --use-file-for-fake-video-capture 에 넣어 tools/check.mjs가 허브 전체 흐름을 확인한다(끝나면 처음부터 되풀이).
# - otr.y4m, unmute.y4m: 포스터가 8초 동안 화면에 있다(손떨림 조금).
# - dont.y4m: 포스터 5초 → 1.5초 동안 옆으로 돌려 포스터가 화면 밖으로 → 벽만 9.5초(추적을 놓친 뒤 동작 확인용).
# - wall.y4m: 포스터 없는 벽 5초(인식 안 됨 안내 확인용).
# 폰 기본 카메라(제약 없이 요청)는 세로로 들면 480x640을 준다. MindAR도 이 크기로 처리한다.
# 쓰는 법: python tools/make_cams.py <포스터 렌더 폴더(Poster_B2_*.png)> <출력 폴더(ASCII 경로)> [--only dont,wall]
import math
import os
import sys

import cv2
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
W, H, FPS = 480, 640, 15
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20261113)

# 카메라: 세로 화각 약 65도(폰 기본 카메라), 포스터 B2 0.5 x 0.707 m
VFOV = math.radians(65)
F = (H / 2) / math.tan(VFOV / 2)
K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
PW, PH = 0.5, 0.707


def load_poster(name, width=1400):
    im = cv2.imread(os.path.join(SRC, f'Poster_B2_{name}.png'), cv2.IMREAD_COLOR)
    h = round(im.shape[0] * width / im.shape[1])
    return cv2.resize(im, (width, h), interpolation=cv2.INTER_AREA)


def wall_texture():
    # 밝은 회색 칠한 벽 + 약한 얼룩(부스 가벽)
    base = np.full((H * 2, W * 3, 3), (176, 180, 184), np.float32)
    noise = cv2.GaussianBlur(rng.normal(0, 1, (H * 2, W * 3)).astype(np.float32), (0, 0), 25)
    noise = noise / (np.abs(noise).max() + 1e-6) * 10
    base += noise[..., None]
    fine = rng.normal(0, 2.5, base.shape[:2]).astype(np.float32)
    base += fine[..., None]
    return np.clip(base, 0, 255)


WALL = wall_texture()


def rot(yaw, pitch, roll):
    y, p, r = map(math.radians, (yaw, pitch, roll))
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return Rz @ Rx @ Ry


def plane_to_image(R, t, Rc):
    # 벽 평면(z=0, 미터 X·Y, y는 아래가 +) → 화면 픽셀. 카메라 좌표 = Rc(R p + t), Rc는 카메라를 돌린 각(팬)
    return K @ Rc @ np.column_stack([R[:, 0], R[:, 1], t])


def render(poster, cam):
    # 벽에 걸린 포스터. 포스터는 카메라에서 d m 앞, 조금 비스듬히(yaw·pitch·roll), 카메라는 pan만큼 옆으로 돌린다
    d, yaw, pitch, roll, pan = cam['d'], cam['yaw'], cam['pitch'], cam['roll'], cam['pan']
    R = rot(yaw, pitch, roll)
    t = np.array([cam['dx'], cam['dy'], d])
    P = plane_to_image(R, t, rot(pan, 0, 0))
    # 벽: 무늬 1px = 4mm, 무늬 밖은 거울로 이어 붙인다(화면 안의 모든 빛줄기가 벽 앞쪽에 닿는 각도만 쓴다)
    s = 0.004
    th, tw = WALL.shape[:2]
    A = np.array([[s, 0, -tw / 2 * s], [0, s, -th / 2 * s], [0, 0, 1]])
    frame = cv2.warpPerspective(WALL, P @ A, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    # 포스터
    ph, pw = poster.shape[:2]
    Ap = np.array([[PW / pw, 0, -PW / 2], [0, PH / ph, -PH / 2], [0, 0, 1]])
    M = P @ Ap
    warped = cv2.warpPerspective(poster.astype(np.float32), M, (W, H), flags=cv2.INTER_AREA)
    mask = cv2.warpPerspective(np.ones((ph, pw), np.float32), M, (W, H), flags=cv2.INTER_LINEAR)
    frame = frame * (1 - mask[..., None]) + warped * mask[..., None]
    # 조명: 위가 조금 밝고, 노출 약간 낮게, 카메라 잡음
    yy = np.linspace(1.06, 0.9, H, dtype=np.float32)[:, None, None]
    frame = frame * yy * cam['gain']
    frame += rng.normal(0, 3.0, frame.shape).astype(np.float32)
    frame = cv2.GaussianBlur(frame, (0, 0), 0.6)
    return np.clip(frame, 0, 255).astype(np.uint8)


def shake(i):
    # 손떨림: 느린 흔들림 두 개를 섞는다
    s = i / FPS
    return dict(dx=0.006 * math.sin(s * 1.7) + 0.003 * math.sin(s * 4.1 + 1),
                dy=0.005 * math.sin(s * 1.3 + 2) + 0.002 * math.sin(s * 5.3),
                roll=2.0 + 0.6 * math.sin(s * 0.9), yaw=8 + 1.2 * math.sin(s * 0.7), pitch=-4 + 0.8 * math.sin(s * 1.1))


def write_y4m(path, frames_iter, n):
    with open(path, 'wb') as fh:
        fh.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        for k, bgr in enumerate(frames_iter):
            fh.write(b'FRAME\n')
            fh.write(cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420).tobytes())
    print(os.path.basename(path), n, 'frames', round(os.path.getsize(path) / 1048576), 'MB', flush=True)


def clip(poster, seconds, pan_at=None, pan_len=1.5, d=1.0):
    n = int(seconds * FPS)
    for i in range(n):
        c = shake(i)
        s = i / FPS
        pan = 0.0
        if pan_at is not None and s >= pan_at:
            k = min(1.0, (s - pan_at) / pan_len)
            pan = 52 * (0.5 - 0.5 * math.cos(math.pi * k))  # 옆으로 52도 돌림(포스터가 화면 밖으로)
        cam = dict(d=d, yaw=c['yaw'], pitch=c['pitch'], roll=c['roll'], pan=pan, dx=c['dx'], dy=c['dy'], gain=0.96)
        yield render(poster, cam)


def render_many(posters, cam):
    # 벽에 나란히 걸린 여러 장. posters = [(그림, 가로 위치 m)], cam['cx'] = 카메라가 벽을 따라 옮겨 간 거리(m)
    R = rot(cam['yaw'], cam['pitch'], cam['roll'])
    t = np.array([cam['dx'] - cam['cx'], cam['dy'], cam['d']])
    P = plane_to_image(R, t, rot(cam['pan'], 0, 0))
    s = 0.004
    th, tw = WALL.shape[:2]
    A = np.array([[s, 0, -tw / 2 * s], [0, s, -th / 2 * s], [0, 0, 1]])
    frame = cv2.warpPerspective(WALL, P @ A, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    for poster, ox in posters:
        ph, pw = poster.shape[:2]
        Ap = np.array([[PW / pw, 0, ox - PW / 2], [0, PH / ph, -PH / 2], [0, 0, 1]])
        M = P @ Ap
        warped = cv2.warpPerspective(poster.astype(np.float32), M, (W, H), flags=cv2.INTER_AREA)
        mask = cv2.warpPerspective(np.ones((ph, pw), np.float32), M, (W, H), flags=cv2.INTER_LINEAR)
        frame = frame * (1 - mask[..., None]) + warped * mask[..., None]
    yy = np.linspace(1.06, 0.9, H, dtype=np.float32)[:, None, None]
    frame = frame * yy * cam['gain']
    frame += rng.normal(0, 3.0, frame.shape).astype(np.float32)
    frame = cv2.GaussianBlur(frame, (0, 0), 0.6)
    return np.clip(frame, 0, 255).astype(np.uint8)


def ease(a, b, k):
    k = max(0.0, min(1.0, k))
    return a + (b - a) * (0.5 - 0.5 * math.cos(math.pi * k))


def wall3_frames(posters, seconds=14):
    # 메인 포스터 셋을 0.8m 간격으로(왼쪽 OFF THE RECORD, 가운데 사용금지, 오른쪽 UNMUTE).
    # 0~3초 사용금지 1m → 3~4.5초 UNMUTE로 옮김 → 7초까지 UNMUTE → 7~9초 1.7m로 물러나 사용금지를 가운데에
    # (양옆 포스터는 화면 가장자리에 반쯤 걸린다) → 14초까지 그대로. 앞에서 잡은 UNMUTE가 가장자리에 남아도
    # 가운데 사용금지로 카드가 바뀌는지 본다
    for i in range(int(seconds * FPS)):
        s = i / FPS
        c = shake(i)
        if s < 3:
            cx, d = 0.0, 1.0
        elif s < 4.5:
            cx, d = ease(0.0, 0.8, (s - 3) / 1.5), 1.0
        elif s < 7:
            cx, d = 0.8, 1.0
        else:
            k = (s - 7) / 2
            cx, d = ease(0.8, 0.0, k), ease(1.0, 1.7, k)
        cam = dict(d=d, cx=cx, yaw=c['yaw'] * 0.5, pitch=c['pitch'], roll=c['roll'], pan=0, dx=c['dx'], dy=c['dy'], gain=0.96)
        yield render_many(posters, cam)


def still_frame(poster, d=1.0):
    c = shake(0)
    return render(poster, dict(d=d, yaw=c['yaw'], pitch=c['pitch'], roll=c['roll'], pan=0, dx=c['dx'], dy=c['dy'], gain=0.96))


if __name__ == '__main__':
    only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
    # 사용금지: 포스터 5초 → 1.5초 동안 돌림 → 벽 9.5초(16초마다 되풀이). 영상(8초)이 도는 사이에 추적을 놓치게
    jobs = [('otr', '3U_Main', 8, None), ('unmute', 'MP3_Main', 8, None), ('dont', 'Dont_Main', 16, 5.0)]
    for name, poster_name, sec, pan_at in jobs:
        if only and name not in only:
            continue
        poster = load_poster(poster_name)
        cv2.imwrite(os.path.join(OUT, f'{name}_preview.jpg'), still_frame(poster))
        write_y4m(os.path.join(OUT, f'{name}.y4m'), clip(poster, sec, pan_at), int(sec * FPS))
    # 포스터 없는 벽: 카메라를 포스터에서 멀리 돌린다
    blank = np.zeros((10, 7, 3), np.uint8)

    def wall_frames():
        for i in range(5 * FPS):
            c = shake(i)
            cam = dict(d=1.0, yaw=c['yaw'], pitch=c['pitch'], roll=c['roll'], pan=60, dx=c['dx'], dy=c['dy'], gain=0.96)
            yield render(blank, cam)
    if not only or 'wall' in only:
        write_y4m(os.path.join(OUT, 'wall.y4m'), wall_frames(), 5 * FPS)
    # 세 장이 나란히 걸린 벽(가장자리에 걸린 포스터 놓아주기 확인용)
    if not only or 'wall3' in only:
        trio = [(load_poster('3U_Main', 900), -0.8), (load_poster('Dont_Main', 900), 0.0), (load_poster('MP3_Main', 900), 0.8)]
        frames = list(wall3_frames(trio))
        for sec in (1, 6, 12):
            cv2.imwrite(os.path.join(OUT, f'wall3_preview_{sec}s.jpg'), frames[sec * FPS])
        write_y4m(os.path.join(OUT, 'wall3.y4m'), iter(frames), len(frames))
