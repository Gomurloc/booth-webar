// 사진 내보내기: JPEG 만들기, 파일 이름, 공유·내려받기, 인쇄.
// 사진은 기기 밖 서버로 올리지 않는다. 공유는 기기의 공유 시트, 저장은 기기 안 내려받기다.
// 파일 이름 함수는 순수해서 노드 시험이 가져다 쓴다(나머지는 부를 때만 DOM을 쓴다).

const pad2 = (n) => String(n).padStart(2, '0');

export function photoFileName(d) {
  const day = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `OFF_THE_RECORD_${day}_${time}.jpg`;
}

// toBlob은 메모리가 모자라면 null을 준다. 그때는 dataURL로 한 번 더 시도한다
export function canvasToJpeg(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.type === 'image/jpeg') return resolve(blob);
        try {
          const url = canvas.toDataURL('image/jpeg', quality);
          const bin = atob(url.slice(url.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve(new Blob([bytes], { type: 'image/jpeg' }));
        } catch (e) {
          reject(e);
        }
      },
      'image/jpeg',
      quality,
    );
  });
}

export function makePhotoFile(blob, date) {
  return new File([blob], photoFileName(date), { type: 'image/jpeg', lastModified: date.getTime() });
}

export function canShareFile(file) {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

// 공유 시트로 보낸다. 반드시 클릭 처리기 맨 처음에 await 없이 불러야 한다(사파리는 사용자 동작이 await를 넘기지 못한다).
// 파일만 보낸다: iOS는 글·주소를 같이 넣으면 거절한 적이 있다. 사용자가 닫으면(AbortError) 조용히 넘어간다.
// 반환 Promise: 'shared' | 'cancelled' | 'failed'
export function sharePhoto(file) {
  let p;
  try {
    p = navigator.share({ files: [file] });
  } catch {
    return Promise.resolve('failed');
  }
  return p.then(
    () => 'shared',
    (e) => (e?.name === 'AbortError' ? 'cancelled' : 'failed'),
  );
}

// <a download>로 기기에 저장. 주소는 잠시 뒤에 해제한다(바로 해제하면 일부 브라우저가 못 받는다)
export function downloadPhoto(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// 인쇄: 결과 화면에 있는 동안 인쇄 영역(사진만)과 용지 크기(@page)를 늘 채워 두고, 인쇄는 print()만 부른다.
// 인쇄가 끝나면 걷어 내는 방식은 iPad 사파리에서 afterprint가 인쇄 시트가 닫히기 전에 와서
// 사진 대신 앱 화면이 인쇄될 수 있었다(WebKit 버그 245171). 그래서 걷어 내는 일을 결과 화면을 떠날 때로 옮겼다.
// 용지는 4×6인치(셀피 엽서와 거의 같다). @page size는 사파리 18.2 미만에서 무시되므로 iPad는 인쇄 시트에서 용지를 고른다.
export function setPrintPhoto(src, landscape) {
  const area = document.getElementById('인쇄영역');
  const img = area?.querySelector('img');
  if (!img) return;
  let style = document.getElementById('인쇄용지');
  if (!src) {
    img.removeAttribute('src');
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = '인쇄용지';
    document.head.append(style);
  }
  style.textContent = `@page { size: ${landscape ? '6in 4in' : '4in 6in'}; margin: 0; }`;
  if (img.getAttribute('src') !== src) img.src = src;
}

// 인쇄 대화상자를 연다. 크롬은 print()가 대화상자를 닫을 때까지 멈추고 afterprint를 보낸다.
// 반환 Promise는 대화상자가 닫히면(안 오는 브라우저는 60초 뒤) 끝난다. 실패해도 던지지 않는다
let printing = false;
export async function printPhoto() {
  if (printing) return false;
  printing = true;
  try {
    const img = document.querySelector('#인쇄영역 img');
    if (!img?.getAttribute('src')) return false;
    await img.decode().catch(() => {}); // 디코드가 덜 끝나도 인쇄는 한다(크롬은 인쇄 전에 이미지를 기다린다)
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('afterprint', finish);
        resolve();
      };
      window.addEventListener('afterprint', finish);
      setTimeout(finish, 60_000);
      window.print();
    });
    return true;
  } catch {
    return false;
  } finally {
    printing = false;
  }
}
