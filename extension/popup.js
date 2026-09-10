const SERVER = 'https://reviewmate-kdyl.onrender.com';

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (kind || '');
}

async function connect() {
  const code = $('code').value.trim().toUpperCase();
  const type = document.querySelector('input[name="type"]:checked').value;

  if (code.length !== 6) {
    setStatus('연동 코드 6자리를 입력해 주세요.', 'err');
    return;
  }

  $('go').disabled = true;
  setStatus('네이버 로그인 정보를 읽는 중...');

  let cookies;
  try {
    // httpOnly 쿠키(NID_AUT/NID_SES 포함)까지 확장프로그램 권한으로 읽을 수 있음
    cookies = await chrome.cookies.getAll({ domain: 'naver.com' });
  } catch (e) {
    setStatus('네이버 쿠키를 읽지 못했습니다: ' + e.message, 'err');
    $('go').disabled = false;
    return;
  }

  const hasAuth = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
  if (!hasAuth) {
    setStatus('네이버에 먼저 로그인해 주세요.\n(새 탭에서 naver.com 로그인 후 다시 시도)', 'err');
    $('go').disabled = false;
    return;
  }

  const payload = cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path
  }));

  setStatus('리뷰메이트로 안전하게 전송 중...');
  try {
    const r = await fetch(SERVER + '/api/extension/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, type, cookies: payload })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      setStatus('✅ 연동 완료!\n리뷰메이트 창으로 돌아가 "연동 완료 확인"을 눌러주세요.', 'ok');
      $('code').value = '';
    } else {
      setStatus('❌ ' + (data.error || '연동에 실패했습니다.'), 'err');
    }
  } catch (e) {
    setStatus('전송 실패: ' + e.message, 'err');
  }
  $('go').disabled = false;
}

document.addEventListener('DOMContentLoaded', () => {
  $('go').addEventListener('click', connect);
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
});
