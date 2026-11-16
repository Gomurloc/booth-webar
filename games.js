// 세 게임과 인식 대상(.mind) 정의. 화면 글자는 포스터에 적힌 말만 쓴다.
// - line: 포스터에 적힌 장르·소개 문구(그대로 옮김)
// - what: 이 허브에서 열리는 콘텐츠 설명
// - href: 다른 페이지로 가는 콘텐츠(가기 전에 허브가 카메라를 놓는다). 없으면 허브 안에서 연다(사용금지 영상).
//   다른 사이트 주소도 된다(UNMUTE 팀 테스트)
// - site, siteLabel: 팀이 따로 만든 사이트. 사용금지는 포스터 영상 끝 화면에 이 단추를 둔다
// - arHref: 사진 앱 포스터 AR 주소. 포스터를 알아본 카드와 직접 고르기 둘 다 이 주소로 연다(2026-11-14부터).
//   href(포스터 없이 쓰는 원래 사진 앱)는 사진 앱 안의 "포스터 없이" 단추가 같은 일을 한다

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
    // 포스터 위 영상(2026-11-16): 메인 포스터를 알아본 카드는 이 영상부터 튼다(포스터가 잔잔하게 움직이는 반복 영상).
    // 끝 화면에는 사진 앱 단추를 두지 않는다(2026-11-16: 사진 앱은 부스에 QR을 따로 둔다). 직접 고르기는 지금처럼 사진 앱으로 바로 간다
    live: { what: '포스터가 움직여요', open: '포스터 움직이기' },
  },
  dont: {
    id: 'dont',
    name: '사용금지',
    line: '1인칭 심리 호러 · 어드벤처',
    what: '포스터가 움직여요\u00a0· 소리가 나요', // 가운뎃점이 줄 앞에 오지 않게 앞을 붙인다
    open: '사용금지 열기',
    thumb: 'img/dont.jpg',
    // 사용금지 팀 사이트(2026-11-16 받음): 밤 10시 이후의 학교를 3D로 걸어 다니는 페이지. 포스터 영상이 끝나면 간다
    // ?from=booth: 팀 사이트가 이 값을 보고 부스에서 온 사람에게만 "← 부스로" 단추를 띄운다(2026-11-16 두 팀에 요청)
    site: 'https://do-not-access.com/ar/?from=booth',
    siteLabel: '10시 이후의 학교 들어가기',
  },
  unmute: {
    id: 'unmute',
    name: 'UNMUTE',
    line: '웹캠 기반 스토리형 리듬 게임',
    what: '음악 질문 9개로 내 색 찾기',
    open: '테스트 하러 가기',
    thumb: 'img/unmute.jpg',
    // UNMUTE 팀이 만든 컬러 테스트(2026-11-16 받음). 우리 시안(unmute/)은 남겨 두지만 허브에서는 열지 않는다
    href: 'https://unmute-mp3.github.io/unmute-test/?from=booth', // ?from=booth는 위 사용금지와 같다
  },
};

// 화면에 늘어놓는 순서(인식 대상 순서와 같게)
export const GAME_ORDER = ['otr', 'dont', 'unmute'];

// 사용금지 메인 포스터에서 영상이 겹칠 자리(포스터 한 장 = 0~1, 왼쪽 위가 0).
// 2026-11-14부터 영상이 포스터 전체(제목 아래로 "뒤돌아보지마" 핏빛 글자가 써짐)를 덮는다. 영상 크기 720x1028 = 포스터 비율.
// 예전 장면 칸만 덮던 값: x 48~884, y 360~1196 / 928x1325(정사각형 영상)
export const DONT_OVERLAY = { x0: 0, y0: 0, x1: 1, y1: 1 };
// OFF THE RECORD 메인 포스터 위 영상(2026-11-16): 포스터 전체를 덮는다. 영상 크기 = 포스터 비율(1113:1600)
export const OTR_OVERLAY = { x0: 0, y0: 0, x1: 1, y1: 1 };

// 인식 대상 묶음. MindAR는 앞 번호부터 맞춰 보고 처음 맞는 하나만 따라간다.
// 기본은 메인 포스터 셋(게임끼리 헷갈림 0, 측정). ?targets=all6 이면 여섯 장 모두(같은 게임 두 장은 같은 콘텐츠)
export const TARGET_SETS = {
  main3: {
    file: 'targets/targets_main3.mind',
    targets: [
      { game: 'otr', poster: '3U_Main', overlay: OTR_OVERLAY },
      { game: 'dont', poster: 'Dont_Main', overlay: DONT_OVERLAY },
      { game: 'unmute', poster: 'MP3_Main' },
    ],
  },
  all6: {
    file: 'targets/targets_all6.mind',
    targets: [
      { game: 'otr', poster: '3U_Main', overlay: OTR_OVERLAY },
      { game: 'otr', poster: '3U_Second' },
      { game: 'dont', poster: 'Dont_Main', overlay: DONT_OVERLAY },
      // 두 번째 포스터는 그림 배치가 달라 영상을 겹치지 않고 화면 가운데에 띄운다
      { game: 'dont', poster: 'Dont_Second' },
      { game: 'unmute', poster: 'MP3_Main' },
      { game: 'unmute', poster: 'MP3_Second' },
    ],
  },
};
