// 포스터 조각 인식(2026-11-20). 부스에서 포스터가 높이 걸려 조명을 바로 받으면 반사로 일부가 하얗게 날아가 인식이 잘 안 됐다.
// MindAR는 포스터 한 장에서 크기마다 무늬 점을 몇백 개까지만 뽑아 두는데, 포스터 전체로 뽑으면 점이 넓게 흩어져서
// 일부만 또렷할 때 맞는 점이 모자란다. 그래서 포스터 일부(조각)를 인식 대상에 더 넣는다. 조각은 같은 넓이에 점이 2배쯤 빽빽하다.
//
// - 대상 파일(.mind)은 [원래 포스터들 …, 조각들 …] 순서다. base = 원래 포스터 수, 조각 i = 파일의 base + i 번째.
// - 조각 하나 = { of: 원래 포스터 번호, x, y } — 그 포스터를 1000x1438로 뽑은 판에서 조각의 왼쪽 위(픽셀). 크기는 늘리거나 줄이지 않았다.
// - 조각으로 찾으면 자세를 포스터 전체 기준으로 옮겨 원래 번호로 넘긴다(cropToPoster). 따라가기 · 영상 겹치기 · 카드는 원래 포스터 그대로다.
// - 만든 법: README "인식 대상"의 "포스터 조각".

export const CROP_SETS = {
  // 허브 메인 셋: 0 OFF THE RECORD, 1 사용금지, 2 UNMUTE. 조각은 포스터마다 아래쪽 55%(y 647~1438, 폭 전체) 하나씩
  'targets_main3_crops.mind': {
    base: 3,
    crops: [
      { of: 0, x: 0, y: 647 },
      { of: 1, x: 0, y: 647 },
      { of: 2, x: 0, y: 647 },
    ],
  },
  // 사진 앱 포스터 AR: 0 3U_Main, 1 3U_Second. 조각은 위와 같이 아래쪽 55%
  'targets_otr_crops.mind': {
    base: 2,
    crops: [
      { of: 0, x: 0, y: 647 },
      { of: 1, x: 0, y: 647 },
    ],
  },
};

// 대상 파일 주소 → 조각 정보(없으면 null)
export function cropSetFor(url) {
  const name = String(url).split(/[?#]/)[0].split('/').pop();
  return CROP_SETS[name] ?? null;
}

// 조각 번호면 원래 포스터 번호, 아니면 그대로
export function posterOf(set, i) {
  if (!set || !(i >= set.base)) return i;
  return set.crops[i - set.base]?.of ?? -1;
}

// MindAR 찾기 결과 { targetIndex, modelViewTransform(3×4) }가 조각이면 원래 포스터 것으로 옮긴다.
// 자세는 대상 그림 픽셀 좌표 → 카메라. 조각 좌표 = 포스터 좌표 - (x, y)이므로 이동 열만 바뀐다: t' = t - x·R열0 - y·R열1
export function cropToPoster(set, result) {
  const i = result?.targetIndex;
  if (!set || !(i >= set.base)) return result;
  const c = set.crops[i - set.base];
  const m = result.modelViewTransform;
  if (!c || !m) return { ...result, targetIndex: -1, modelViewTransform: null };
  return {
    ...result,
    targetIndex: c.of,
    modelViewTransform: m.map((r) => [r[0], r[1], r[2], r[3] - r[0] * c.x - r[1] * c.y]),
  };
}
