// 사용금지 영상을 웹용으로 바꾼다(아무 원본 → 폰에서 바로 도는 mp4 + 첫 장면 그림).
// 결과: H.264 main(level 4.0) · yuv420p(BT.709 표시) · 720x720 · 30fps 이하 · AAC 128k · +faststart(받는 중에도 재생 시작).
//       같은 이름의 .jpg(첫 장면)도 만든다. 허브가 영상을 받는 동안 이 그림을 먼저 보여 준다(video poster).
// 비트레이트: 붐비는 행사장 회선(1.5~2Mbps)에서도 끊기지 않게 영상 1600kbps(+소리 128k ≈ 1.75Mbps)를 기본으로 한다.
//       15초면 약 3.3MB. 입자감 있는 그림이라 이보다 낮추면 뭉개진다(2026-11-13 1500·2000kbps 비교).
//       --max-mb(기본 8)는 상한이다. 길이가 길어 한도를 넘으면 그만큼 낮춘다.
// 쓰는 법: node tools/encode_video.mjs <원본.mp4> [결과.mp4] [--size 720] [--kbps 1600] [--max-mb 8] [--gop 2]
//          --gop: 키프레임 간격(초). 반복 영상은 길이만큼(예: 10) 주면 2초마다 압축 무늬가 바뀌며 가만있는 곳이 살짝 깜빡이는 것이 없다
//          video/ 안에 쓰면 끝에 tools/stamp_media.mjs로 index.html의 영상 주소 판 번호(?v=)를 바꾼다
//          결과를 빼면 video/dont.mp4(+ video/dont.jpg)에 쓴다(허브가 읽는 이름).
// 필요: ffmpeg, ffprobe가 PATH에 있어야 한다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_KBPS = 128;
const MAX_FPS = 30; // 720x720에서 level 4.0 한도 안(60fps 원본도 30으로 줄인다)

function parseArgs(argv) {
  const a = { size: 720, w: 0, h: 0, maxMb: 8, kbps: 1600, gop: 2, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--size') a.size = Number(argv[++i]);
    else if (k === '--wh') [a.w, a.h] = argv[++i].split('x').map(Number); // 정사각형이 아닌 크기(예: 포스터 전체 720x1028)
    else if (k === '--max-mb') a.maxMb = Number(argv[++i]);
    else if (k === '--gop') a.gop = Number(argv[++i]);
    else if (k === '--kbps' || k === '--cap-kbps') a.kbps = Number(argv[++i]);
    else a.files.push(k);
  }
  if (!a.files[0]) {
    console.error('쓰는 법: node tools/encode_video.mjs <원본.mp4> [결과.mp4] [--size 720] [--kbps 1600] [--max-mb 8]');
    process.exit(2);
  }
  a.src = path.resolve(a.files[0]);
  a.out = path.resolve(a.files[1] ?? path.join(ROOT, 'video', 'dont.mp4'));
  a.poster = a.out.replace(/\.mp4$/i, '') + '.jpg';
  return a;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}를 실행하지 못했어요: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} 실패 (${r.status})\n${(r.stderr || '').split('\n').slice(-15).join('\n')}`);
  return r.stdout;
}

function probe(file) {
  const json = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  const v = json.streams.find((s) => s.codec_type === 'video');
  const au = json.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
  return { duration: Number(json.format.duration), size: Number(json.format.size), v, a: au, fps: d ? n / d : 0 };
}

function encode(a, src, videoKbps) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'));
  const passlog = path.join(tmpDir, 'pass');
  const tmpOut = a.out + '.tmp.mp4';
  const W = a.w || a.size, H = a.h || a.size;
  const fps = src.fps > MAX_FPS + 0.5 ? MAX_FPS : 0;
  // 기본은 정사각형(포스터 장면 칸). --wh를 주면 그 크기로 맞춘다(포스터 전체를 덮는 판)
  // 색: 결과를 BT.709로 맞추고 표시를 붙인다. 원본에 BT.709 표시가 있으면 그대로 두고, 표시가 없으면 BT.601로 보고 바꾼다.
  //     편집 대본이 처음부터 BT.709로 내보내면 크롬에서 첫 장면이 포스터와 가장 가깝다
  //     (2026-11-14 크롬 비교, 포스터와 평균 밝기 차: 표시 없는 BT.601 약 +2, 처음부터 BT.709 약 0)
  const vf = [`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos:out_color_matrix=bt709:out_range=tv`, `crop=${W}:${H}`, 'setsar=1', fps ? `fps=${fps}` : null]
    .filter(Boolean)
    .join(',');
  const gop = Math.round((fps || src.fps || 24) * a.gop); // 기본 2초마다 키프레임(되감기·다시 보기가 빠르게)
  const common = [
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'main', '-level:v', '4.0', '-pix_fmt', 'yuv420p', '-preset', 'slow',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    // 최대 비트레이트를 평균의 1.3배로 묶어 받는 속도가 고르게(느린 회선에서 한 장면만 크게 튀지 않게)
    '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.3)}k`, '-bufsize', `${Math.round(videoKbps * 1.5)}k`,
    '-g', String(gop), '-passlogfile', passlog,
  ];
  run('ffmpeg', ['-y', '-v', 'error', '-i', a.src, ...common, '-pass', '1', '-an', '-f', 'null', '-']);
  run('ffmpeg', [
    '-y', '-v', 'error', '-i', a.src, ...common, '-pass', '2',
    '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', tmpOut,
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return tmpOut;
}

const a = parseArgs(process.argv.slice(2));
const src = probe(a.src);
if (!src.v) throw new Error('원본에 영상이 없어요');
const budgetKbps = (a.maxMb * 1024 * 1024 * 8 * 0.95) / src.duration / 1000; // 컨테이너 몫 5%를 남긴다
let videoKbps = Math.min(a.kbps, Math.floor(budgetKbps - (src.a ? AUDIO_KBPS : 0)));
if (videoKbps < 300) throw new Error(`영상이 너무 길어요(${src.duration.toFixed(1)}초). --max-mb를 늘려 주세요`);
console.log(`원본 ${path.basename(a.src)}: ${src.v.width}x${src.v.height} ${src.fps.toFixed(2)}fps ${src.duration.toFixed(2)}초 ${(src.size / 1048576).toFixed(1)}MB, 소리 ${src.a ? '있음' : '없음'}`);

fs.mkdirSync(path.dirname(a.out), { recursive: true });
for (let attempt = 0; attempt < 3; attempt++) {
  console.log(`인코딩: 영상 ${videoKbps}kbps + 소리 ${AUDIO_KBPS}kbps`);
  const tmp = encode(a, src, videoKbps);
  const size = fs.statSync(tmp).size;
  if (size <= a.maxMb * 1024 * 1024) {
    fs.renameSync(tmp, a.out);
    // 첫 장면 그림(영상을 받는 동안 보이는 그림). 결과 영상에서 뽑아야 색·크기가 똑같다
    run('ffmpeg', ['-y', '-v', 'error', '-i', a.out, '-frames:v', '1', '-q:v', '4', a.poster]);
    const r = probe(a.out);
    const mbps = ((size * 8) / r.duration / 1e6).toFixed(2);
    console.log(
      `결과 ${path.relative(ROOT, a.out)}: ${r.v.width}x${r.v.height} ${r.v.profile}@${r.v.level / 10} ${r.v.pix_fmt} ${r.fps.toFixed(2)}fps ` +
        `${r.duration.toFixed(2)}초 ${(size / 1048576).toFixed(2)}MB(평균 ${mbps}Mbps), 소리 ${r.a ? r.a.codec_name + ' ' + Math.round(r.a.bit_rate / 1000) + 'k' : '없음'}`,
    );
    console.log(`첫 장면 ${path.relative(ROOT, a.poster)}: ${(fs.statSync(a.poster).size / 1024).toFixed(0)}KB`);
    // 허브가 읽는 영상이면 index.html의 주소 판 번호(?v=)를 새 내용에 맞춘다(폰이 예전 영상을 계속 틀지 않게)
    if (path.dirname(a.out) === path.join(ROOT, 'video')) spawnSync(process.execPath, [path.join(ROOT, 'tools', 'stamp_media.mjs')], { stdio: 'inherit' });
    process.exit(0);
  }
  fs.rmSync(tmp, { force: true });
  videoKbps = Math.floor(videoKbps * 0.85);
  console.log(`한도(${a.maxMb}MB)를 넘어서(${(size / 1048576).toFixed(2)}MB) 비트레이트를 낮춰 다시 해요`);
}
throw new Error('한도 안에 맞추지 못했어요');
