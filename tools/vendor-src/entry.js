// vendor/mindar-three.js 묶음의 진입점(tools/build_vendor.mjs가 묶는다).
// MindAR 1.2.5 배포본(dist)의 three.js 래퍼를 그대로 쓰고, 허브가 영상 판을 만들 때 쓰는 three 조각을 같은 three에서 내보낸다
// (three가 둘이 되면 렌더러가 다른 쪽 물체를 못 알아본다).
export { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
// 사진 앱 AR(otr/?ar=1)은 렌더러 없이 인식기(Controller)만 쓴다. MindARThree와 같은 조각(controller-*.js)이라 묶음이 커지지 않는다.
// 공개 경로(mindar-image.prod.js)로 가져오면 window.MINDAR에 Compiler까지 붙이는 부수 효과가 따라오므로 조각에서 바로 가져온다.
// (1.2.5 배포본에서 그 조각의 Controller 이름은 C. 버전을 바꾸면 mindar-image.prod.js의 import 줄을 보고 맞춘다)
export { C as Controller } from 'mind-ar/dist/controller-mGt1s8dJ.js';
export {
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  VideoTexture,
  CanvasTexture,
  SRGBColorSpace,
  LinearFilter,
  Color,
  REVISION,
} from 'three';
export const MINDAR_VERSION = '1.2.5';
