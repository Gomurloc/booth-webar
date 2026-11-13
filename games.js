// 세 게임과 인식 대상(.mind) 정의. 화면 글자는 포스터에 적힌 말만 쓴다.
// - line: 포스터에 적힌 장르·소개 문구(그대로 옮김)
// - what: 이 허브에서 열리는 콘텐츠 설명
// - href: 다른 페이지로 가는 콘텐츠(가기 전에 허브가 카메라를 놓는다). 없으면 허브 안에서 연다(사용금지 영상)
// - arHref: 포스터를 알아본 카드에서 열 때의 주소(사진 앱 포스터 AR). 직접 고르기 단추는 href(포스터 없이 쓰는 원래 사진 앱)

export const GAMES = {
  otr: {
    id: 'otr',
    name: 'OFF THE RECORD',
    line: '우주 화물 회수 게임',
    what: '캐릭터와 함께 사진을 찍어요',
    open: '사진 찍으러 가기',
    thumb: 'img/otr.jpg',
    href: 'otr/',
    arHref: 'otr/?ar=1',
  },
  dont: {
    id: 'dont',
    name: '사용금지',
    line: '1인칭 심리 호러 · 어드벤처',
    what: '포스터가 움직여요\u00a0· 소리가 나요', // 가운뎃점이 줄 앞에 오지 않게 앞을 붙인다
    open: '사용금지 열기',
    thumb: 'img/dont.jpg',
  },
  unmute: {
    id: 'unmute',
    name: 'UNMUTE',
    line: '웹캠 기반 스토리형 리듬 게임',
    what: '나는 어떤 빛일까? 짧은 테스트',
    open: '테스트 하러 가기',
    thumb: 'img/unmute.jpg',
    href: 'unmute/',
  },
};

// 화면에 늘어놓는 순서(인식 대상 순서와 같게)
export const GAME_ORDER = ['otr', 'dont', 'unmute'];

// 사용금지 메인 포스터에서 영상이 겹칠 자리(포스터 한 장 = 0~1, 왼쪽 위가 0).
// 2026-11-14부터 영상이 포스터 전체(제목 아래로 "뒤돌아보지마" 핏빛 글자가 써짐)를 덮는다. 영상 크기 720x1028 = 포스터 비율.
// 예전 장면 칸만 덮던 값: x 48~884, y 360~1196 / 928x1325(정사각형 영상)
export const DONT_OVERLAY = { x0: 0, y0: 0, x1: 1, y1: 1 };

// 인식 대상 묶음. MindAR는 앞 번호부터 맞춰 보고 처음 맞는 하나만 따라간다.
// 기본은 메인 포스터 셋(게임끼리 헷갈림 0, 측정). ?targets=all6 이면 여섯 장 모두(같은 게임 두 장은 같은 콘텐츠)
export const TARGET_SETS = {
  main3: {
    file: 'targets/targets_main3.mind',
    targets: [
      { game: 'otr', poster: '3U_Main' },
      { game: 'dont', poster: 'Dont_Main', overlay: DONT_OVERLAY },
      { game: 'unmute', poster: 'MP3_Main' },
    ],
  },
  all6: {
    file: 'targets/targets_all6.mind',
    targets: [
      { game: 'otr', poster: '3U_Main' },
      { game: 'otr', poster: '3U_Second' },
      { game: 'dont', poster: 'Dont_Main', overlay: DONT_OVERLAY },
      // 두 번째 포스터는 그림 배치가 달라 영상을 겹치지 않고 화면 가운데에 띄운다
      { game: 'dont', poster: 'Dont_Second' },
      { game: 'unmute', poster: 'MP3_Main' },
      { game: 'unmute', poster: 'MP3_Second' },
    ],
  },
};
