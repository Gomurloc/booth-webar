// vendor/mindar-three.js 묶음의 진입점(tools/build_vendor.mjs가 묶는다).
// MindAR 1.2.5 배포본(dist)의 three.js 래퍼를 그대로 쓰고, 허브가 영상 판을 만들 때 쓰는 three 조각을 같은 three에서 내보낸다
// (three가 둘이 되면 렌더러가 다른 쪽 물체를 못 알아본다).
export { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
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
