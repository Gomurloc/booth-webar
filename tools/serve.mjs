// 사이트를 로컬에서 띄우는 작은 정적 서버(저장소 폴더 전체). 빌드 없음.
// 카메라는 https나 localhost에서만 켜진다: 이 컴퓨터의 브라우저로 http://localhost:<포트>/ 를 연다.
// 폰으로 시험하려면 https 주소가 필요하다(README의 "폰으로 미리 보기").
// 영상은 Range 요청(부분 받기)을 지원해야 iOS 사파리가 튼다.
// 쓰는 법: node tools/serve.mjs [--port 8780]   (--port 0 이면 빈 포트를 고른다)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.mind': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
};

function resolveSafe(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + path.sep + rel);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

export function startServer(port = 8780, { quiet = true } = {}) {
  const server = http.createServer((req, res) => {
    let file = resolveSafe(req.url);
    let st = file && fs.statSync(file, { throwIfNoEntry: false });
    // 폴더 주소에 / 를 빼먹으면 / 를 붙여 보낸다(상대 경로가 맞게)
    if (st?.isDirectory()) {
      const u = new URL(req.url, 'http://x');
      res.writeHead(301, { location: u.pathname + '/' + u.search });
      res.end();
      return;
    }
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('없음: ' + req.url);
      if (!quiet) console.log('404', req.url);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end || start < 0) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const want = i > 0 ? Number(process.argv[i + 1]) : 8780;
  let server;
  try {
    server = await startServer(want, { quiet: false });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    server = await startServer(0, { quiet: false }); // 쓰고 있으면 빈 포트로
  }
  console.log(`허브: http://localhost:${server.address().port}/  (끄려면 Ctrl+C)`);
}
