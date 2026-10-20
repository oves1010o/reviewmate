const { app, BrowserWindow, ipcMain, session, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const SERVER = (process.env.REVIEWMATE_SERVER || 'https://reviewmate-kdyl.onrender.com').replace(/\/$/, '');
const DEBUG = process.env.REVIEWMATE_DEBUG === '1'; // 1이면 백그라운드 네이버 창을 화면에 보여줌
const SMOKE = process.argv.includes('--smoke');
const PARTITION = 'persist:naver'; // 네이버 로그인 상태가 이 PC에 저장되는 저장소
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LOGIN_URL = {
  place: 'https://nid.naver.com/nidlogin.login',
  store: 'https://accounts.commerce.naver.com/login'
};

// 스마트스토어 리뷰 목록 주소 (테스트에서만 환경변수로 바꿈)
const STORE_LIST_URL = process.env.REVIEWMATE_STORE_URL || 'https://sell.smartstore.naver.com/#/review/search';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 설정(서버 로그인 토큰) 저장 ─────────────────────────────────────────────
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
}
function saveToken(token) {
  const cfg = readConfig();
  if (!token) { delete cfg.token; delete cfg.tokenEnc; }
  else if (safeStorage.isEncryptionAvailable()) { cfg.tokenEnc = safeStorage.encryptString(token).toString('base64'); delete cfg.token; }
  else { cfg.token = token; delete cfg.tokenEnc; }
  writeConfig(cfg);
}
function loadToken() {
  const cfg = readConfig();
  try {
    if (cfg.tokenEnc) return safeStorage.decryptString(Buffer.from(cfg.tokenEnc, 'base64'));
  } catch { /* 복호화 실패 시 재로그인 */ }
  return cfg.token || '';
}

// ── 리뷰메이트 서버 호출 ────────────────────────────────────────────────────
async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = loadToken();
    if (!t) { const e = new Error('로그인이 필요합니다.'); e.code = 'NO_AUTH'; throw e; }
    headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try {
    // 무료 서버는 잠들어 있다가 깨는 데 오래 걸릴 수 있어 넉넉히 기다림
    res = await fetch(SERVER + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
  } catch (e) {
    throw new Error('서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `서버 오류 (${res.status})`);
    e.code = res.status === 401 ? 'NO_AUTH' : res.status === 402 ? 'NO_TOKENS' : 'SERVER';
    throw e;
  }
  return data;
}

// ── 네이버 브라우저 창 (이 앱에 내장된 크롬) ────────────────────────────────
function makeNaverWindow({ show }) {
  const win = new BrowserWindow({
    width: 1100, height: 800, show,
    title: '네이버',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setUserAgent(CHROME_UA);
  return win;
}

async function hasNaverLogin() {
  const ses = session.fromPartition(PARTITION);
  const [a, b] = await Promise.all([ses.cookies.get({ name: 'NID_AUT' }), ses.cookies.get({ name: 'NID_SES' })]);
  return a.length > 0 || b.length > 0;
}

async function loadPage(win, url) {
  await win.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(String(e.message))) throw e; });
  await delay(1500); // 로그인 화면으로 넘기는 이동이 약간 늦게 일어날 수 있음
  await assertLoggedIn(win, url);
}

// 로그인이 풀려 있으면 NAVER_LOGIN 오류를 던짐
// (스마트스토어는 로그인 주소로 이동시키고, 스마트플레이스는 같은 주소에 안내 문구만 띄움)
async function assertLoggedIn(win, url) {
  const needLogin = () => {
    if (/sell\.smartstore\.naver\.com/.test(url)) setStoreFlag(false);
    const e = new Error('네이버 로그인이 필요합니다. 먼저 "네이버 로그인"을 해주세요.');
    e.code = 'NAVER_LOGIN';
    return e;
  };
  if (/nid\.naver\.com|accounts\.commerce\.naver\.com\/login/.test(win.webContents.getURL())) throw needLogin();
  const body = await run(win, `document.body ? document.body.innerText : ''`).catch(() => '');
  if (body.includes('네이버 로그인이 필요한 기능입니다')) throw needLogin();
}

const run = (win, code) => win.webContents.executeJavaScript(code, true);

async function waitFor(win, selector, timeout = 20000) {
  const sel = JSON.stringify(selector);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await run(win, `!!document.querySelector(${sel})`)) return true;
    await delay(400);
  }
  return false;
}

async function withWorker(fn, { show = DEBUG } = {}) {
  const win = makeNaverWindow({ show });
  try { return await fn(win); } finally { if (!win.isDestroyed()) win.destroy(); }
}
// 답글 등록은 글자 입력이 필요해서 창을 화면에 보여준다 (숨은 창에서는 입력이 안 먹힐 수 있고, 사장님도 등록 과정을 눈으로 확인할 수 있음)
const withVisibleWorker = (fn) => withWorker(fn, { show: true });

// 답글 입력창에 실제 키 입력과 같은 이벤트로 글자를 넣음 (React 화면에서도 인식됨)
// selector로 범위를 좁혀서 입력한다 (스마트스토어 목록에는 검색창 textarea가 먼저 있어서, 범위를 안 좁히면 엉뚱한 곳에 입력됨)
async function typeIntoTextarea(win, text, selector = 'textarea', pick = 'first') {
  if (!(await waitFor(win, selector, 10000))) throw new Error('답글 입력창을 찾지 못했습니다.');
  const target = `(() => { const a = document.querySelectorAll(${JSON.stringify(selector)}); return ${pick === 'last' ? 'a[a.length - 1]' : 'a[0]'}; })()`;
  await run(win, `(() => { const t = ${target}; t.focus(); t.select(); })()`);
  win.webContents.focus();
  await delay(150);
  await win.webContents.insertText(text);
  await delay(500);
  const typed = await run(win, `(${target})?.value || ''`);
  if (!typed || typed.trim().length < 2) throw new Error('답글 입력에 실패했습니다.');
}

// ── IPC: 모든 응답을 { ok, data | error, code } 형태로 통일 ────────────────
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || '' }; }
  });
}

handle('auth:login', async ({ email, password }) => {
  const d = await api('/api/desktop/login', { method: 'POST', body: { email, password }, auth: false });
  saveToken(d.token);
  return { storeName: d.storeName, placeId: d.placeId, tokens: d.tokens };
});
handle('auth:logout', async () => {
  try { await api('/api/desktop/logout', { method: 'POST' }); } catch { /* 서버 실패해도 로컬 토큰은 지움 */ }
  saveToken('');
  return true;
});
handle('auth:me', async () => {
  const me = await api('/api/user/me');
  return { storeName: me.storeName, placeId: me.placeId || '', tokens: me.tokens || 0, email: me.email };
});

// 스마트스토어(커머스 ID) 로그인은 일반 네이버 쿠키와 별개일 수 있어 따로 표시를 저장
function setStoreFlag(v) { const c = readConfig(); c.storeLogin = !!v; writeConfig(c); }

handle('naver:status', async (kind) => ({
  loggedIn: kind === 'store' ? !!readConfig().storeLogin : await hasNaverLogin()
}));
handle('naver:logout', async () => {
  await session.fromPartition(PARTITION).clearStorageData();
  setStoreFlag(false);
  return true;
});
handle('naver:login', (kind) => new Promise((resolve) => {
  const isStore = kind === 'store';
  const win = makeNaverWindow({ show: true });
  win.setTitle('네이버 로그인 - 로그인하면 이 창은 자동으로 닫혀요');
  win.loadURL(LOGIN_URL[isStore ? 'store' : 'place']).catch(() => {});
  let done = false;
  const finish = (r) => {
    if (done) return;
    done = true;
    clearInterval(timer); clearTimeout(limit);
    if (isStore) setStoreFlag(!!r.loggedIn);
    if (!win.isDestroyed()) win.destroy();
    resolve(r);
  };
  // 스마트플레이스: 네이버 로그인 쿠키가 생기면 완료 / 스마트스토어: 판매자센터 화면에 도착하면 완료
  const storeArrived = () => {
    if (win.isDestroyed()) return false;
    const u = win.webContents.getURL();
    return /^https:\/\/sell\.smartstore\.naver\.com\//.test(u) && !/login/i.test(u);
  };
  const timer = setInterval(async () => {
    if (isStore ? storeArrived() : await hasNaverLogin()) finish({ loggedIn: true });
  }, 1500);
  const limit = setTimeout(() => finish({ loggedIn: false, error: '로그인 시간이 초과되었습니다.' }), 10 * 60 * 1000);
  win.on('closed', () => { if (!done) finish({ loggedIn: false, error: '로그인 창이 닫혔습니다.' }); });
}));

// 스마트플레이스: 리뷰 목록 (서버 코드와 같은 선택자)
handle('place:reviews', (placeId) => withWorker(async (win) => {
  if (!/^\d+$/.test(String(placeId || ''))) throw new Error('스마트플레이스 ID(숫자)를 입력해주세요.');
  await loadPage(win, `https://smartplace.naver.com/bizes/place/${placeId}/reviews`);
  const ok = await waitFor(win, 'li[class*="Review_pui_review"], li[class*="Review_review_list_item"]', 20000);
  if (!ok) throw new Error('리뷰 목록을 찾지 못했습니다. (ID가 맞는지, 리뷰가 있는지 확인해주세요)');
  return run(win, `(() => {
    const out = [];
    document.querySelectorAll('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]').forEach((card, idx) => {
      if (idx >= 30) return;
      const textEl = card.querySelector('a[data-pui-click-code="text"], [class*="vn15t2"], [class*="pui__vn"]');
      const text = textEl?.innerText?.trim();
      const hasReply = !!card.querySelector('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_area"]');
      if (text && text.length > 5) out.push({ key: 'p' + idx + ':' + text.slice(0, 20), text, hasReply });
    });
    return out;
  })()`);
}));

// 스마트플레이스: 답글 등록 (리뷰 글로 카드를 찾아서 입력)
handle('place:reply', ({ placeId, reviewText, replyText }) => withVisibleWorker(async (win) => {
  if (!replyText || !replyText.trim()) throw new Error('답글 내용이 비어있습니다.');
  await loadPage(win, `https://smartplace.naver.com/bizes/place/${placeId}/reviews`);
  const sel = 'li[class*="Review_pui_review"], li[class*="Review_review_list_item"]';
  if (!(await waitFor(win, sel, 20000))) throw new Error('리뷰 목록을 찾지 못했습니다.');
  const found = await run(win, `((target) => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').replace(/[~!！?？.,]/g, '').trim().toLowerCase();
    const t = norm(target);
    const cards = [...document.querySelectorAll(${JSON.stringify(sel)})];
    let best = -1, bestScore = -1;
    cards.forEach((card, i) => {
      const el = card.querySelector('a[data-pui-click-code="text"], [class*="vn15t2"], [class*="pui__vn"]');
      const c = norm(el?.innerText);
      if (!c) return;
      let score = -1;
      if (c === t) score = 100;
      else if (c.includes(t) || t.includes(c)) score = Math.min(c.length, t.length) + 50;
      else if (c.includes(t.slice(0, 20)) || t.includes(c.slice(0, 20))) score = 20;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0) return { ok: false, error: '일치하는 리뷰를 찾지 못했습니다.' };
    const btn = cards[best].querySelector('button[class*="Review_btn_write"]');
    if (!btn) return { ok: false, error: '답글 쓰기 버튼을 찾지 못했습니다. (이미 답글이 달린 리뷰일 수 있어요)' };
    btn.click();
    return { ok: true };
  })(${JSON.stringify(reviewText)})`);
  if (!found.ok) throw new Error(found.error);
  await delay(1200);
  await typeIntoTextarea(win, replyText);
  const submitted = await run(win, `(() => {
    const b = document.querySelector('button[class*="Review_btn_enter"]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    b.click(); return true;
  })()`);
  if (!submitted) throw new Error('등록 버튼을 누르지 못했습니다.');
  await delay(2000);
  return true;
}));

// 스마트스토어: 리뷰 목록 (판매자센터 표 구조)
handle('store:reviews', () => withWorker(async (win) => {
  await loadPage(win, STORE_LIST_URL);
  const ok = await waitFor(win, ".ag-center-cols-container [role='row'][row-id]", 25000);
  if (!ok) {
    await assertLoggedIn(win, 'https://sell.smartstore.naver.com/'); // 로그인이 풀린 거면 그 안내를 우선 표시
    throw new Error('리뷰 표를 찾지 못했습니다. (스마트스토어 판매자 계정으로 로그인했는지 확인해주세요)');
  }
  const rows = await run(win, `(() => [...document.querySelectorAll(".ag-center-cols-container [role='row'][row-id]")].map((row) => {
    const cells = [...row.querySelectorAll('[col-id]')];
    const byId = Object.fromEntries(cells.map((c) => [c.getAttribute('col-id'), c.innerText.trim()]));
    const reviewId = row.querySelector('[col-id="reviewContent"] a')?.getAttribute('ng-click')?.match(/openReviewDetailModal\\((\\d+)/)?.[1] || '';
    return { reviewId, productNo: byId.productNo || '', productName: byId.productName || '', reviewContent: byId.reviewContent || '', writerId: byId.writerId || '', createDate: byId.createDate || '' };
  }))()`);
  return rows.filter((r) => r.productName && r.reviewContent)
    .map((r) => ({ key: r.reviewId || [r.productNo, r.createDate, r.writerId].join('|'), reviewId: r.reviewId, product: r.productName, writer: r.writerId, text: r.reviewContent, date: r.createDate }));
}));

// 스마트스토어: 답글 등록 (리뷰 상세창 열기 → 입력 → 등록)
// 흐름은 친구분 프로그램(naver-review-automation.js)을 따름:
// 리뷰 링크를 "실제로 클릭" → 상세창 안의 입력칸에 입력 → 답글 등록 버튼 → 저장 확인
// (openReviewDetailModal 은 화면 내부(AngularJS) 함수라 window 에서 직접 부를 수 없음)
handle('store:reply', ({ reviewId, product, replyText }) => withVisibleWorker(async (win) => {
  if (!/^\d+$/.test(String(reviewId || ''))) throw new Error('이 리뷰는 자동 등록용 식별자가 없습니다. 목록을 새로고침 해주세요.');
  if (!replyText || !replyText.trim()) throw new Error('답글 내용이 비어있습니다.');
  const LIST = STORE_LIST_URL;
  const ROW = ".ag-center-cols-container [role='row'][row-id]";
  const MODAL = '.data-target-review-detail.in';
  const linkSel = `[ng-click*="openReviewDetailModal(${reviewId},"]`;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  await loadPage(win, LIST);
  if (!(await waitFor(win, ROW, 25000))) { await assertLoggedIn(win, LIST); throw new Error('리뷰 표를 찾지 못했습니다.'); }

  // 현재 목록에 없으면 리뷰 번호로 검색
  let found = await run(win, `!!document.querySelector(${JSON.stringify(linkSel)})`);
  if (!found) {
    await run(win, `(() => { const b = [...document.querySelectorAll('button, label')].find((x) => /1개월/.test(x.innerText)); if (b) b.click(); })()`);
    await delay(500);
    const hasBox = await run(win, `(() => { const t = document.querySelector("textarea[ng-model='vm.searchFormData.viewData.searchKeyword'], textarea[placeholder*='복수 검색']"); if (!t) return false; t.focus(); t.select(); return true; })()`);
    if (hasBox) {
      win.webContents.focus();
      await win.webContents.insertText(String(reviewId));
      await delay(300);
      await run(win, `(() => { const b = [...document.querySelectorAll('button')].find((x) => /^\\s*검색\\s*$/.test(x.innerText) && !x.disabled); if (b) b.click(); })()`);
      await delay(2500);
    }
    found = await waitFor(win, linkSel, 8000);
  }
  if (!found) throw new Error('이 리뷰를 목록에서 찾지 못했어요. (조회 기간 밖이거나 삭제된 리뷰일 수 있어요)');

  await run(win, `document.querySelector(${JSON.stringify(linkSel)}).click()`);
  if (!(await waitFor(win, MODAL, 10000))) throw new Error('리뷰 상세창이 열리지 않았습니다.');
  await delay(1500);

  // 엉뚱한 리뷰에 답글이 달리지 않도록 상세창의 리뷰 번호/상품명을 확인
  const detailText = await run(win, `document.querySelector(${JSON.stringify(MODAL)}).innerText`);
  if (!detailText.includes(String(reviewId))) throw new Error('다른 리뷰의 상세창이 열려서 등록을 중단했어요.');
  if (product && !norm(detailText).includes(norm(product))) throw new Error('상품명이 달라서 등록을 중단했어요.');

  // 이미 답글이 있으면 덮어쓰지 않음
  const hasReply = await run(win, `(() => { const m = document.querySelector(${JSON.stringify(MODAL)}); return !!([...m.querySelectorAll('button')].find((b) => /답글 수정|답글 삭제/.test(b.innerText)) || m.querySelector('[progress-button="vm.func.updateCommentContent()"]')); })()`);
  if (hasReply) throw new Error('이미 답글이 등록된 리뷰예요.');

  await typeIntoTextarea(win, replyText, `${MODAL} textarea`, 'last');

  const submitted = await run(win, `(() => {
    const m = document.querySelector(${JSON.stringify(MODAL)});
    const b = [...m.querySelectorAll('button')].find((x) => /답글 등록/.test(x.innerText) && !x.disabled)
      || m.querySelector('button[progress-button="vm.func.createCommentContent()"]');
    if (!b || b.disabled) return false;
    b.click(); return true;
  })()`);
  if (!submitted) throw new Error('답글 등록 버튼을 찾지 못했습니다.');
  await delay(800);

  // 확인 팝업이 뜨면 "확인" (삭제 팝업이면 중단)
  const confirmRes = await run(win, `(() => {
    const m = [...document.querySelectorAll('.bootbox.modal.in, .modal.in:not(.data-target-review-detail)')].pop();
    if (!m) return 'none';
    if (/삭제/.test(m.innerText)) return 'delete';
    const b = [...m.querySelectorAll('button')].reverse().find((x) => /확인/.test(x.innerText));
    if (b) { b.click(); return 'clicked'; }
    return 'none';
  })()`);
  if (confirmRes === 'delete') throw new Error('삭제 확인창이 떠서 자동 등록을 중단했어요.');

  // 저장 확인: 상세창에 "답글 수정/삭제" 버튼이 생기면 저장된 것
  await delay(2500);
  const saved = await run(win, `(() => { const m = document.querySelector(${JSON.stringify(MODAL)}) || document; return !!([...m.querySelectorAll('button')].find((b) => /답글 수정|답글 삭제/.test(b.innerText))); })()`);
  if (!saved) throw new Error('네이버 화면에서 답글 저장 완료를 확인하지 못했어요. 네이버에서 직접 확인해주세요.');
  return true;
}));

// AI 답글 생성 (서버가 만들고 토큰 1개 차감)
handle('ai:generate', (payload) => api('/api/desktop/generate', { method: 'POST', body: payload }));

handle('open:charge', async () => { await shell.openExternal(`${SERVER}/charge.html`); return true; });

// ── 메인 창 ────────────────────────────────────────────────────────────────
function createMainWindow() {
  const win = new BrowserWindow({
    width: 980, height: 760, minWidth: 760, minHeight: 560,
    title: '리뷰메이트',
    show: !SMOKE,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 앱 안에서 외부 링크가 새 창으로 열리지 않게
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.whenReady().then(async () => {
    session.fromPartition(PARTITION).setUserAgent(CHROME_UA);
    const win = createMainWindow();
    if (SMOKE) {
      win.webContents.once('did-finish-load', async () => {
        const r = await win.webContents.executeJavaScript(`JSON.stringify({
          hasApi: typeof window.api === 'object',
          methods: Object.keys(window.api || {}),
          loginViewVisible: !document.getElementById('loginView').hidden,
          mainViewHidden: document.getElementById('mainView').hidden
        })`);
        console.log('SMOKE_RESULT ' + r);
        // 선택: 환경변수로 계정을 주면 서버/네이버 연동까지 점검 (SMOKE_EMAIL, SMOKE_PASSWORD)
        if (process.env.SMOKE_EMAIL) {
          const call = (name, arg) => win.webContents.executeJavaScript(`window.api.${name}(${arg === undefined ? '' : JSON.stringify(arg)})`);
          const show = (label, x) => console.log(`E2E ${label} ${JSON.stringify(x)}`);
          show('login', await call('login', { email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }));
          show('me', await call('me'));
          show('generate', await call('generate', { reviewText: '맛있고 친절해요', source: 'place' }));
          show('naverStatus(place)', await call('naverStatus', 'place'));
          show('naverStatus(store)', await call('naverStatus', 'store'));
          show('placeReviews(비로그인)', await call('placeReviews', '1402114061'));
          show('storeReviews(비로그인)', await call('storeReviews'));
          show('placeReviews(잘못된ID)', await call('placeReviews', 'abc'));
          show('logout', await call('logout'));
          show('me(로그아웃후)', await call('me'));
        }
        app.exit(0);
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
}
