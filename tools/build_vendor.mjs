// vendor/mindar-three.js를 만든다: MindAR 1.2.5(dist, tfjs 포함) + three 0.187을 ES 모듈 한 파일로 묶고 줄인다.
// 사이트는 CDN 없이 이 파일만 읽는다(행사장 인터넷이 약해도, MindAR 배포처가 사라져도 돈다).
//
// 왜 손을 대나
// - MindAR 1.2.5 dist는 three에서 sRGBEncoding을 가져오는데 three r162부터 없어졌다. 그대로 쓰면 모듈 연결에서 멈춘다.
//   그래서 'three'를 진짜 three + sRGBEncoding(옛 상수 3001) 한 줄로 바꿔 끼운다. 값은 MindAR가 renderer.outputEncoding에
//   넣기만 하고 r187은 그 속성을 읽지 않는다(색 공간은 r187 기본값 sRGB 그대로).
// - 'three/addons/...'는 three의 examples/jsm으로 잇는다.
//
// 쓰는 법: node tools/build_vendor.mjs --nm <node_modules 폴더>
//   그 폴더에 mind-ar@1.2.5, three@0.187.0, vite가 있어야 한다. 빼면 이 저장소의 node_modules를 본다.
//   (처음 만들 때는 별도 작업 폴더에 npm install mind-ar@1.2.5 @tensorflow/tfjs@4.16.0 three@0.187.0 vite 한 것을 썼다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argNm = process.argv.indexOf('--nm');
const NM = path.resolve(argNm > 0 ? process.argv[argNm + 1] : path.join(ROOT, 'node_modules'));

const pkg = (name) => JSON.parse(fs.readFileSync(path.join(NM, name, 'package.json'), 'utf8'));
const mindVer = pkg('mind-ar').version;
const threeVer = pkg('three').version;
if (mindVer !== '1.2.5') throw new Error(`mind-ar ${mindVer}: 1.2.5만 시험했어요`);
console.log(`mind-ar ${mindVer}, three ${threeVer}, node_modules ${NM}`);

const { build } = await import(pathToFileURL(path.join(NM, 'vite', 'dist', 'node', 'index.js')).href);
const THREE_MAIN = path.join(NM, 'three', 'build', 'three.module.js').replaceAll('\\', '/');
const SHIM = '\0three-shim';

const resolver = {
  name: 'hub-vendor-resolve',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'three') return SHIM;
    // 경로는 / 로 맞춘다: vite가 상대 import('./controller-*.js')를 / 경로로 풀어서, \ 경로로 돌려주면 같은 파일이 두 번 묶인다
    if (id.startsWith('three/addons/')) return path.join(NM, 'three', 'examples', 'jsm', id.slice('three/addons/'.length)).replaceAll('\\', '/');
    if (id.startsWith('mind-ar/')) return path.join(NM, id).replaceAll('\\', '/');
    return null;
  },
  load(id) {
    if (id === SHIM) return `export * from ${JSON.stringify(THREE_MAIN)};\nexport const sRGBEncoding = 3001;\n`;
    return null;
  },
};

const outDir = path.join(ROOT, 'vendor');
await build({
  root: path.join(ROOT, 'tools', 'vendor-src'),
  configFile: false,
  logLevel: 'warn',
  plugins: [resolver],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir,
    emptyOutDir: false,
    minify: 'esbuild',
    target: ['es2020', 'safari15'],
    sourcemap: false,
    lib: { entry: path.join(ROOT, 'tools', 'vendor-src', 'entry.js'), formats: ['es'], fileName: () => 'mindar-three.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

// vite 라이브러리 모드는 ES 출력의 공백을 줄이지 않아서 esbuild로 한 번 더 줄인다(3.3MB → 약 2MB)
const outFile = path.join(outDir, 'mindar-three.js');
const esbuild = await import(pathToFileURL(path.join(NM, 'esbuild', 'lib', 'main.js')).href);
const min = await esbuild.transform(fs.readFileSync(outFile, 'utf8'), {
  minify: true,
  format: 'esm',
  target: ['es2020', 'safari15'],
  legalComments: 'none', // 라이선스 글은 LICENSES.txt에 모은다
});
fs.writeFileSync(outFile, `/* MindAR ${mindVer} + three.js ${threeVer} (+ TensorFlow.js) — 라이선스: vendor/LICENSES.txt, 만든 법: tools/build_vendor.mjs */\n` + min.code);

// 묶음에 든 라이브러리의 사용 허락(라이선스) 글을 같이 둔다
const licenses = [
  ['MindAR ' + mindVer + ' (MIT)', path.join(NM, 'mind-ar', 'LICENSE')],
  ['three.js ' + threeVer + ' (MIT)', path.join(NM, 'three', 'LICENSE')],
  ['TensorFlow.js ' + pkg('@tensorflow/tfjs').version + ' (Apache-2.0, MindAR dist 안에 들어 있음)', path.join(NM, '@tensorflow', 'tfjs', 'LICENSE')],
];
let text = 'vendor/mindar-three.js 에 들어 있는 라이브러리\n\n';
for (const [title, file] of licenses) {
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(LICENSE 파일 없음: 패키지 설명의 라이선스를 따른다)\n';
  text += `==== ${title} ====\n${body.trim()}\n\n`;
}
fs.writeFileSync(path.join(outDir, 'LICENSES.txt'), text);
const size = fs.statSync(path.join(outDir, 'mindar-three.js')).size;
console.log(`vendor/mindar-three.js ${(size / 1048576).toFixed(2)}MB`);
