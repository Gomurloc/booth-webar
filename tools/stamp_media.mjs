// index.html의 영상·첫 장면 주소 끝에 ?v=(영상 내용 해시 8자리)를 붙인다.
// 왜: 폰 브라우저가 같은 주소로 예전에 받아 둔 영상을 계속 틀었다(2026-11-16, 사용금지 v4를 올린 뒤에도
//     QR로 들어가면 옛 영상이 나옴. 서버에는 v4가 올라가 있었다). 주소가 바뀌면 새로 받는다.
// 영상을 바꾸면 이 도구를 돌린다. tools/encode_video.mjs가 끝에 알아서 부른다.
// 쓰는 법: node tools/stamp_media.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');
const hashes = new Map();
const hashOf = (name) => {
  if (!hashes.has(name)) {
    const f = path.join(ROOT, 'video', name + '.mp4');
    hashes.set(name, fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 8) : null);
  }
  return hashes.get(name);
};
const changes = [];
// 첫 장면(.jpg)도 영상과 함께 만들어지므로 영상 해시를 같이 쓴다
const out = html.replace(/video\/([\w-]+)\.(mp4|jpg)(\?v=[0-9a-f]+)?/g, (m, name, ext) => {
  const h = hashOf(name);
  if (!h) return m;
  const next = `video/${name}.${ext}?v=${h}`;
  if (next !== m) changes.push(`${m} → ${next}`);
  return next;
});
if (out !== html) {
  fs.writeFileSync(INDEX + '.tmp', out);
  fs.renameSync(INDEX + '.tmp', INDEX);
}
console.log(changes.length ? changes.join('\n') : '바꿀 주소 없음(이미 최신)');
