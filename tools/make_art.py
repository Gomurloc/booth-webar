# 포스터 그림에서 사이트용 그림을 만든다(원본 포스터는 읽기만 한다).
# - img/otr.jpg, img/dont.jpg, img/unmute.jpg: 허브 단추에 붙는 포스터 썸네일(메인 포스터 전체)
# - unmute/art/poster.jpg: UNMUTE 결과 카드 그림(MP3 메인 포스터 전체)
# - unmute/art/bg.jpg: UNMUTE 테스트 배경(같은 포스터의 로고 아래 부분)
# - unmute/art/logo.png: UNMUTE 로고(MP3 메인 포스터 윗부분, 밤하늘은 투명)
# 쓰는 법: python tools/make_art.py <포스터 렌더 폴더(Poster_B2_*.png)> <저장소 폴더>
#   포스터 렌더는 PDF를 PyMuPDF로 뽑은 PNG(긴 변 4000px)를 썼다.
import os
import sys

import numpy as np
from PIL import Image

src, root = sys.argv[1], sys.argv[2]


def load(name):
    return Image.open(os.path.join(src, f'Poster_B2_{name}.png')).convert('RGB')


def save(im, rel, q):
    out = os.path.join(root, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, 'JPEG', quality=q, optimize=True, progressive=True)
    print(rel, im.size, os.path.getsize(out) // 1024, 'KB')


def fit_w(im, w):
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


for name, rel in (('3U_Main', 'img/otr.jpg'), ('Dont_Main', 'img/dont.jpg'), ('MP3_Main', 'img/unmute.jpg')):
    save(fit_w(load(name), 240), rel, 82)

mp3 = load('MP3_Main')
save(fit_w(mp3, 1080), 'unmute/art/poster.jpg', 82)
# 테스트 화면 배경: 포스터에서 로고 아래(도시·두 인물·디제잉 장비)만. 화면 글자 뒤에 큰 로고가 겹치지 않게
bw, bh = mp3.size
save(fit_w(mp3.crop((0, round(0.235 * bh), bw, bh)), 1080), 'unmute/art/bg.jpg', 78)

# 로고: 밝은 글자·네온만 남기고 남색 하늘은 투명하게(밝기로 뽑는다). 가장자리는 부드럽게 0으로
W, H = mp3.size
logo = fit_w(mp3.crop((round(0.10 * W), round(0.065 * H), round(0.90 * W), round(0.23 * H))), 1080)
a = np.asarray(logo).astype(np.float32) / 255
lum = a.max(axis=2)
alpha = np.clip((lum - 0.36) / 0.42, 0, 1)
alpha = alpha * alpha * (3 - 2 * alpha)
h, w = alpha.shape
ex = np.minimum(np.arange(w), np.arange(w)[::-1]) / (0.06 * w)
ey = np.minimum(np.arange(h), np.arange(h)[::-1]) / (0.12 * h)
alpha *= np.clip(ey, 0, 1)[:, None] * np.clip(ex, 0, 1)[None, :]
rgba = np.dstack([np.asarray(logo), (alpha * 255).astype(np.uint8)])
out = os.path.join(root, 'unmute/art/logo.png')
Image.fromarray(rgba, 'RGBA').save(out, optimize=True)
print('unmute/art/logo.png', logo.size, os.path.getsize(out) // 1024, 'KB')
old = os.path.join(root, 'unmute/art/logo.jpg')
if os.path.exists(old):
    os.remove(old)
