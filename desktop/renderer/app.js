const $ = (id) => document.getElementById(id);

const state = {
  tab: 'place',          // 'place' | 'store'
  reviews: [],           // 현재 탭의 리뷰 목록
  busy: false
};

// ── 작은 헬퍼 ───────────────────────────────────────────────────────────────
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else n[k] = v;
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
}

function showMsg(text, kind = '') {
  const m = $('msg');
  if (!text) { m.hidden = true; return; }
  m.hidden = false;
  m.className = 'msg ' + kind;
  m.textContent = text;
}

function setTokens(n) {
  const p = $('tokenPill');
  p.textContent = `토큰 ${n}개`;
  p.classList.toggle('low', n < 1);
}

function showLogin(msg) {
  $('mainView').hidden = true;
  $('loginView').hidden = false;
  const m = $('loginMsg');
  m.hidden = !msg;
  m.textContent = msg || '';
}

function showMain(me) {
  $('loginView').hidden = true;
  $('mainView').hidden = false;
  $('storeName').textContent = me.storeName || '리뷰메이트';
  setTokens(me.tokens || 0);
  const saved = localStorage.getItem('placeId') || me.placeId || '';
  $('placeId').value = saved;
  refreshNaverState();
}

// 서버에서 로그인이 풀렸다는 응답이면 로그인 화면으로
function handleAuthError(r) {
  if (r.code === 'NO_AUTH') { showLogin('다시 로그인해주세요.'); return true; }
  return false;
}

// ── 로그인 / 로그아웃 ───────────────────────────────────────────────────────
async function doLogin() {
  const btn = $('loginBtn');
  btn.disabled = true; btn.textContent = '로그인 중... (서버가 깨어나는 데 1분쯤 걸릴 수 있어요)';
  const r = await window.api.login({ email: $('email').value.trim(), password: $('password').value });
  btn.disabled = false; btn.textContent = '로그인';
  if (!r.ok) { showLogin(r.error); return; }
  $('password').value = '';
  showMain(r.data);
}

async function doLogout() {
  await window.api.logout();
  state.reviews = [];
  $('list').replaceChildren();
  showLogin('');
}

// ── 네이버 로그인 상태 ──────────────────────────────────────────────────────
async function refreshNaverState() {
  const r = await window.api.naverStatus(state.tab);
  const ok = r.ok && r.data.loggedIn;
  const s = $('naverState');
  s.textContent = ok ? '✓ 네이버 로그인됨' : '네이버 로그인이 필요해요';
  s.className = 'state' + (ok ? ' ok' : '');
  $('naverLoginBtn').hidden = ok;
  $('naverLogoutBtn').hidden = !ok;
}

async function doNaverLogin() {
  const btn = $('naverLoginBtn');
  btn.disabled = true;
  showMsg('열린 네이버 창에서 로그인해주세요. 로그인하면 창이 자동으로 닫혀요.');
  const r = await window.api.naverLogin(state.tab);
  btn.disabled = false;
  if (r.ok && r.data.loggedIn) showMsg('네이버 로그인이 완료됐어요.', 'ok');
  else showMsg((r.ok && r.data.error) || r.error || '네이버 로그인에 실패했어요.', 'err');
  refreshNaverState();
}

async function doNaverLogout() {
  await window.api.naverLogout();
  refreshNaverState();
  showMsg('이 PC에 저장된 네이버 로그인 정보를 지웠어요.');
}

// ── 탭 ──────────────────────────────────────────────────────────────────────
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  $('placeId').hidden = tab !== 'place';
  state.reviews = [];
  $('list').replaceChildren();
  showMsg('');
  refreshNaverState();
}

// ── 리뷰 불러오기 ───────────────────────────────────────────────────────────
async function loadReviews() {
  if (state.busy) return;
  state.busy = true;
  const btn = $('loadBtn');
  btn.disabled = true; btn.textContent = '불러오는 중...';
  showMsg('네이버에서 리뷰를 불러오는 중이에요. (10~30초)');

  let r;
  if (state.tab === 'place') {
    const placeId = $('placeId').value.trim();
    localStorage.setItem('placeId', placeId);
    r = await window.api.placeReviews(placeId);
  } else {
    r = await window.api.storeReviews();
  }

  state.busy = false;
  btn.disabled = false; btn.textContent = '리뷰 불러오기';

  if (!r.ok) {
    if (r.code === 'NAVER_LOGIN') refreshNaverState();
    showMsg(r.error, 'err');
    return;
  }
  state.reviews = r.data.map((x) => ({ ...x, reply: '', status: x.hasReply ? 'done' : 'new' }));
  const open = state.reviews.filter((x) => x.status !== 'done').length;
  showMsg(`리뷰 ${state.reviews.length}개 (답글 없는 리뷰 ${open}개)`, 'ok');
  render();
}

// ── 리뷰 카드 ───────────────────────────────────────────────────────────────
function render() {
  const list = $('list');
  list.replaceChildren();
  if (!state.reviews.length) { list.append(el('div', { class: 'empty' }, '표시할 리뷰가 없어요.')); return; }
  state.reviews.forEach((rv, i) => list.append(card(rv, i)));
}

function card(rv, i) {
  const meta = [rv.product, rv.writer, rv.date].filter(Boolean).join(' · ');
  const c = el('div', { class: 'card' + (rv.status === 'done' ? ' done' : '') });
  c.append(el('div', { class: 'meta' }, meta || '리뷰', rv.hasReply ? el('span', { class: 'tag' }, '답글 있음') : null));
  c.append(el('div', { class: 'text' }, rv.text));

  if (rv.status === 'done') {
    if (rv.posted) c.append(el('div', { class: 'meta', style: 'margin-top:8px' }, '✓ 등록 완료'));
    return c;
  }

  const area = el('div', { class: 'reply' });
  const ta = el('textarea', { placeholder: 'AI 답글 생성을 누르거나 직접 입력하세요.' });
  ta.value = rv.reply || '';
  ta.addEventListener('input', () => { rv.reply = ta.value; });

  const genBtn = el('button', { class: 'ghost', onclick: () => generate(rv, ta, genBtn) }, 'AI 답글 생성 (토큰 1개)');
  const postBtn = el('button', { class: 'btn', onclick: () => post(rv, c, postBtn) }, '네이버에 등록');
  area.append(ta, el('div', { class: 'row' }, genBtn, postBtn));
  c.append(area);
  return c;
}

async function generate(rv, ta, btn) {
  btn.disabled = true; btn.textContent = '생성 중...';
  const r = await window.api.generate({
    reviewText: rv.text,
    source: state.tab,
    productName: rv.product || ''
  });
  btn.disabled = false; btn.textContent = 'AI 답글 생성 (토큰 1개)';
  if (!r.ok) {
    if (handleAuthError(r)) return;
    showMsg(r.code === 'NO_TOKENS' ? '토큰이 부족해요. 위의 "토큰 충전"을 눌러주세요.' : r.error, 'err');
    return;
  }
  rv.reply = r.data.reply;
  ta.value = r.data.reply;
  setTokens(r.data.tokensLeft);
}

async function post(rv, cardEl, btn) {
  if (!rv.reply || !rv.reply.trim()) { showMsg('등록할 답글이 비어있어요.', 'err'); return; }
  if (!confirm('이 답글을 네이버에 등록할까요?\n\n' + rv.reply)) return;
  btn.disabled = true; btn.textContent = '등록 중...';
  const r = state.tab === 'place'
    ? await window.api.placeReply({ placeId: $('placeId').value.trim(), reviewText: rv.text, replyText: rv.reply })
    : await window.api.storeReply({ reviewId: rv.reviewId, product: rv.product, replyText: rv.reply });
  btn.disabled = false; btn.textContent = '네이버에 등록';
  if (!r.ok) {
    if (r.code === 'NAVER_LOGIN') refreshNaverState();
    showMsg(r.error, 'err');
    return;
  }
  rv.status = 'done'; rv.posted = true;
  showMsg('답글을 등록했어요.', 'ok');
  cardEl.replaceWith(card(rv, 0));
}

// ── 시작 ────────────────────────────────────────────────────────────────────
$('loginBtn').addEventListener('click', doLogin);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn').addEventListener('click', doLogout);
$('chargeBtn').addEventListener('click', () => window.api.openCharge());
$('naverLoginBtn').addEventListener('click', doNaverLogin);
$('naverLogoutBtn').addEventListener('click', doNaverLogout);
$('loadBtn').addEventListener('click', loadReviews);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

(async function init() {
  const r = await window.api.me();
  if (r.ok) showMain(r.data);
  else showLogin(r.code === 'NO_AUTH' ? '' : r.error);
})();
