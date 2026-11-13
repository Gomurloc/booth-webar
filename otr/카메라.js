// 카메라 열기·바꾸기·끄기. 오류는 화면에 띄울 종류(kind)로 바꿔 던진다.
// 지킬 것
// - 카메라는 https나 localhost에서만 켜진다. 그 밖에서는 navigator.mediaDevices 자체가 없다.
// - 해상도·방향은 늘 가로 숫자로 'ideal' 요청만 한다. exact/min은 기기에 없으면 묻지도 않고 실패한다.
//   폰은 들고 있는 방향에 맞춰 알아서 돌려 준다. 실제 크기는 videoWidth/videoHeight로만 읽는다.
// - 카메라를 바꿀 때는 이전 트랙을 먼저 끈다(일부 기기는 두 카메라를 동시에 못 연다).

export class CameraError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // 'insecure' | 'denied' | 'nocam' | 'busy' | 'failed'
    this.cause = cause;
  }
}

export function cameraSupport() {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return 'ok';
}

function classify(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'nocam';
    case 'NotReadableError':
    case 'AbortError':
      return 'busy';
    default:
      return 'failed';
  }
}

function constraints({ deviceId, facing, resolution }) {
  const k4 = resolution === '4k';
  const video = {
    width: { ideal: k4 ? 3840 : 1920 },
    height: { ideal: k4 ? 2160 : 1080 },
    frameRate: { ideal: 30 },
  };
  if (deviceId) video.deviceId = { ideal: deviceId };
  else if (facing) video.facingMode = { ideal: facing };
  return { audio: false, video };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// 반환: { stream, track, facing('user'|'environment'), deviceId }
export async function openCamera(opts) {
  const support = cameraSupport();
  if (support === 'insecure') throw new CameraError('insecure');
  if (support !== 'ok') throw new CameraError('failed');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(opts));
  } catch (e) {
    throw new CameraError(classify(e), e);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new CameraError('nocam');
  }
  const s = track.getSettings?.() ?? {};
  // 트랙이 방향을 알려 주면 그대로. 안 알려 주면(노트북 웹캠, 일부 브라우저) 요청한 방향으로 친다.
  // 요청도 없으면(카메라를 직접 고름) 사용자를 보는 카메라로 친다. 이렇게 해야 폰에서 앞뒤 바꾸기가 번갈아 간다
  const reported = s.facingMode;
  const facing = reported ? (reported === 'environment' ? 'environment' : 'user') : opts.facing === 'environment' ? 'environment' : 'user';
  return { stream, track, facing, deviceId: s.deviceId ?? '' };
}

// iOS: muted·playsInline을 속성으로 먼저 넣어야 전체 화면으로 튀지 않고 저절로 재생된다
export async function attachVideo(video, stream) {
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  if (video.readyState < 1) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  try {
    await video.play();
  } catch {
    // 일부 브라우저는 play()를 거절해도 autoplay 속성으로 곧 재생한다. 첫 프레임은 그리기 쪽에서 기다린다
  }
}

// 권한을 받은 뒤에야 이름(label)이 채워진다
export async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `카메라 ${i + 1}` }));
  } catch {
    return [];
  }
}
