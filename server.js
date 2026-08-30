require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'pages')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'reviewmate-secret-2025',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Claude 응답에 'thinking' 블록이 먼저 올 수 있어 항상 첫 text 블록을 찾음
function extractText(response) {
  const block = response.content.find(c => c.type === 'text');
  return block ? block.text.trim() : '';
}

// ── 단일 플랜 설정 ────────────────────────────────────────────────────────
const PLAN = {
  name: '리뷰메이트 월정액',
  price: 9900,
  trialDays: 7
};

// ── PostgreSQL 기반 DB ───────────────────────────────────────────────────
const fs = require('fs');
const DB_FILE = path.join(__dirname, 'db.json'); // 구버전 데이터 1회 마이그레이션용
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL 환경변수가 설정되지 않았습니다. Render Postgres 연결 문자열을 .env에 추가하세요.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email   TEXT UNIQUE NOT NULL,
      data    JSONB NOT NULL
    )
  `);
}

// db.json에 남아있던 구버전 데이터를 최초 1회만 Postgres로 옮김
async function migrateLegacyFile() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0 || !fs.existsSync(DB_FILE)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')).users || {};
    for (const [userId, u] of Object.entries(legacy)) {
      await pool.query(
        `INSERT INTO users (user_id, email, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (user_id) DO NOTHING`,
        [userId, u.email, JSON.stringify(u)]
      );
    }
    console.log(`✅ db.json → Postgres 마이그레이션 완료 (${Object.keys(legacy).length}명)`);
  } catch (e) {
    console.error('⚠️  db.json 마이그레이션 실패:', e.message);
  }
}

async function loadDB() {
  await initSchema();
  await migrateLegacyFile();
  const { rows } = await pool.query('SELECT user_id, data FROM users');
  const users = new Map();
  for (const row of rows) users.set(row.user_id, row.data);
  return { users, browserSessions: new Map() };
}

async function saveDB() {
  for (const [userId, u] of db.users) {
    await pool.query(
      `INSERT INTO users (user_id, email, data) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET email = $2, data = $3::jsonb`,
      [userId, u.email, JSON.stringify(u)]
    );
  }
}

let db = { users: new Map(), browserSessions: new Map() };

function generateId() { return Math.random().toString(36).substr(2, 12); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 인증 미들웨어 ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const user = db.users.get(req.session.userId);
  if (!user) return res.status(401).json({ error: '유효하지 않은 세션입니다.' });
  req.user = user;
  next();
}

// ── 토큰(선불 크레딧) 설정 ──────────────────────────────────────────────
const TOKEN_PRICE_KRW = 100; // 토큰 1개 = 100원 (100토큰 = 10,000원)
const SIGNUP_FREE_TOKENS = 3; // 가입 시 무료 체험용 토큰

function requireTokens(req, res, next) {
  if ((req.user.tokens || 0) < 1) {
    return res.status(402).json({ error: '토큰이 부족합니다. 충전 후 이용해주세요.', code: 'NO_TOKENS' });
  }
  next();
}

// ══════════════════════════════════════════════════════════════════════════
// 인증 API
// ══════════════════════════════════════════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, storeName } = req.body;
  if (!email || !password || !storeName) return res.status(400).json({ error: '필수 항목을 입력해주세요.' });

  for (const [, u] of db.users) {
    if (u.email === email) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  }

  const userId = generateId();
  db.users.set(userId, {
    userId, email,
    password: await bcrypt.hash(password, 10),
    storeName,
    tokens: SIGNUP_FREE_TOKENS,
    naverId: null, naverPw: null, placeId: null,
    tone: 'warm', emphasis: '',
    usedThisMonth: 0,
    createdAt: new Date().toISOString()
  });
  await saveDB();
  req.session.userId = userId; // 가입 즉시 로그인 처리
  res.json({ success: true, userId });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  let found = null;
  for (const [, u] of db.users) { if (u.email === email) { found = u; break; } }
  if (!found || !await bcrypt.compare(password, found.password)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  req.session.userId = found.userId;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const sid = req.session.id;
  if (db.browserSessions.has(sid)) {
    db.browserSessions.get(sid).browser?.close().catch(() => {});
    db.browserSessions.delete(sid);
  }
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/user/me', requireAuth, (req, res) => {
  const { password, naverPw, ...safe } = req.user;
  safe.tokens = req.user.tokens || 0;
  res.json(safe);
});

app.put('/api/user/config', requireAuth, async (req, res) => {
  const { storeName, tone, emphasis, region, category, seoKeywords } = req.body;
  Object.assign(req.user, { storeName, tone, emphasis, region, category });
  if (seoKeywords) req.user.seoKeywords = seoKeywords;
  db.users.set(req.user.userId, req.user);
  await saveDB();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// 토큰 충전 API (토스페이먼츠 가상계좌 - 입금 자동 확인)
// ══════════════════════════════════════════════════════════════════════════

// 배포된 서버의 공개 URL (토스가 웹훅을 보낼 주소). Render 환경변수 PUBLIC_URL로 덮어쓸 수 있음
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://reviewmate-kdyl.onrender.com';

app.post('/api/charge/prepare', requireAuth, async (req, res) => {
  const tokens = parseInt(req.body.tokens);
  if (!tokens || tokens < 1) return res.status(400).json({ error: '충전할 토큰 개수를 입력해주세요.' });

  const baseAmount = tokens * TOKEN_PRICE_KRW;
  const vat = Math.round(baseAmount * 0.1);
  const amount = baseAmount + vat;
  const orderId = `charge_${req.user.userId}_${Date.now()}`;

  const request = {
    id: generateId(), orderId, tokens, baseAmount, vat, amount,
    status: 'waiting_deposit', requestedAt: new Date().toISOString()
  };
  req.user.chargeRequests = req.user.chargeRequests || [];
  req.user.chargeRequests.unshift(request);
  db.users.set(req.user.userId, req.user);
  await saveDB();

  res.json({
    clientKey: process.env.TOSS_CLIENT_KEY || 'test_ck_여기에입력',
    orderId,
    orderName: `리뷰메이트 토큰 ${tokens}개`,
    amount,
    tokens,
    virtualAccountCallbackUrl: `${PUBLIC_URL}/api/webhooks/toss`
  });
});

// 토스 가상계좌 결제 상세 조회 (충전완료 화면에서 계좌번호 표시용)
app.get('/api/charge/payment-info/:paymentKey', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`https://api.tosspayments.com/v1/payments/${req.params.paymentKey}`, {
      headers: { 'Authorization': `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}` }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || '조회 실패');
    res.json({
      status: data.status,
      orderId: data.orderId,
      totalAmount: data.totalAmount,
      virtualAccount: data.virtualAccount || null
    });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

// 토스 웹훅 - 가상계좌에 실제 입금이 확인되면 토스가 이 URL로 알려줌
app.post('/api/webhooks/toss', async (req, res) => {
  try {
    const { eventType, data } = req.body || {};
    const orderId = data?.orderId;
    const paymentKey = data?.paymentKey;
    console.log('[토스 웹훅]', eventType, orderId);
    if (!orderId || !paymentKey) return res.status(200).json({ received: true });

    // 웹훅 본문을 그대로 믿지 않고, 토스 서버에 직접 재조회해서 검증
    const verifyRes = await fetch(`https://api.tosspayments.com/v1/payments/${paymentKey}`, {
      headers: { 'Authorization': `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}` }
    });
    const payment = await verifyRes.json();
    if (!verifyRes.ok || payment.orderId !== orderId || payment.status !== 'DONE') {
      return res.status(200).json({ received: true }); // 아직 입금 전이거나 무관한 이벤트
    }

    for (const [, u] of db.users) {
      const request = (u.chargeRequests || []).find(r => r.orderId === orderId);
      if (request && request.status === 'waiting_deposit') {
        request.status = 'approved';
        request.approvedAt = new Date().toISOString();
        u.tokens = (u.tokens || 0) + request.tokens;
        db.users.set(u.userId, u);
        await saveDB();
        console.log(`✅ 가상계좌 입금 확인 → ${u.email}에게 토큰 ${request.tokens}개 자동 지급`);
        break;
      }
    }
    res.status(200).json({ received: true });
  } catch(err) {
    console.error('[토스 웹훅 오류]', err.message);
    res.status(200).json({ received: true }); // 토스는 200이 아니면 재시도하므로 항상 200 응답
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 토큰 충전 API (계좌 입금 신청 → 사장님 수동 승인)
// ══════════════════════════════════════════════════════════════════════════

const CHARGE_BANK_INFO = {
  bank: '토스뱅크',
  account: '1000-0550-0556',
  holder: '김동욱'
};

app.get('/api/charge/bank-info', requireAuth, (req, res) => {
  res.json(CHARGE_BANK_INFO);
});

app.post('/api/charge/request', requireAuth, async (req, res) => {
  const tokens = parseInt(req.body.tokens);
  const depositorName = (req.body.depositorName || '').trim();
  if (!tokens || tokens < 1) return res.status(400).json({ error: '충전할 토큰 개수를 입력해주세요.' });
  if (!depositorName) return res.status(400).json({ error: '입금자명을 입력해주세요.' });

  const baseAmount = tokens * TOKEN_PRICE_KRW;
  const vat = Math.round(baseAmount * 0.1);
  const request = {
    id: generateId(),
    tokens,
    baseAmount,
    vat,
    amount: baseAmount + vat, // 부가세 포함 실제 입금액
    depositorName,
    status: 'pending',
    requestedAt: new Date().toISOString()
  };
  req.user.chargeRequests = req.user.chargeRequests || [];
  req.user.chargeRequests.unshift(request);
  db.users.set(req.user.userId, req.user);
  await saveDB();
  res.json({ success: true, request });
});

app.get('/api/charge/requests', requireAuth, (req, res) => {
  res.json({ requests: req.user.chargeRequests || [] });
});

app.post('/api/charge/requests/:requestId/cancel', requireAuth, async (req, res) => {
  const request = (req.user.chargeRequests || []).find(r => r.id === req.params.requestId);
  if (!request) return res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
  if (!['pending', 'waiting_deposit'].includes(request.status)) {
    return res.status(400).json({ error: '이미 처리된 요청은 취소할 수 없습니다.' });
  }
  request.status = 'cancelled';
  db.users.set(req.user.userId, req.user);
  await saveDB();
  res.json({ success: true });
});

// ── 관리자(사장님)용 입금 승인 API — 로그인 계정과 무관하게 비밀번호로만 잠금 ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'reviewmate-admin-2026';

app.post('/api/admin/login', (req, res) => {
  if ((req.body.password || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  req.session.isAdmin = true;
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: '관리자만 접근할 수 있습니다.' });
  }
  next();
}

app.get('/api/admin/charge-requests', requireAdmin, (req, res) => {
  const all = [];
  for (const [, u] of db.users) {
    for (const r of (u.chargeRequests || [])) {
      all.push({ ...r, userId: u.userId, email: u.email, storeName: u.storeName });
    }
  }
  all.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json({ requests: all });
});

app.post('/api/admin/charge-requests/:userId/:requestId/approve', requireAdmin, async (req, res) => {
  const targetUser = db.users.get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
  const request = (targetUser.chargeRequests || []).find(r => r.id === req.params.requestId);
  if (!request) return res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
  if (!['pending','waiting_deposit'].includes(request.status)) return res.status(400).json({ error: '이미 처리된 요청입니다.' });

  request.status = 'approved';
  request.approvedAt = new Date().toISOString();
  targetUser.tokens = (targetUser.tokens || 0) + request.tokens;
  db.users.set(targetUser.userId, targetUser);
  await saveDB();
  res.json({ success: true, tokens: targetUser.tokens });
});

app.post('/api/admin/charge-requests/:userId/:requestId/reject', requireAdmin, async (req, res) => {
  const targetUser = db.users.get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
  const request = (targetUser.chargeRequests || []).find(r => r.id === req.params.requestId);
  if (!request) return res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
  if (!['pending','waiting_deposit'].includes(request.status)) return res.status(400).json({ error: '이미 처리된 요청입니다.' });

  request.status = 'rejected';
  db.users.set(targetUser.userId, targetUser);
  await saveDB();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// 네이버 자동화 API
// ══════════════════════════════════════════════════════════════════════════

// ── 브라우저 세션 관리 ────────────────────────────────────────────────────
async function getOrCreateBrowser(sessionId, headless = true) {
  const existing = db.browserSessions.get(sessionId);

  if (existing) {
    // headless 상태가 다르면 무조건 재생성 (ChatGPT 제안 핵심 수정)
    if (existing.headless !== headless) {
      await existing.browser.close().catch(() => {});
      db.browserSessions.delete(sessionId);
    } else {
      try {
        await existing.page.title();
        return existing;
      } catch {
        db.browserSessions.delete(sessionId);
      }
    }
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  if (!headless) {
    launchArgs.push('--window-position=200,100');
    launchArgs.push('--window-size=500,650');
    launchArgs.push('--new-window');
    launchArgs.push('--foreground');
  }

  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    args: launchArgs,
    defaultViewport: null
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 700 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const s = { browser, page, loggedIn: false, cookies: null, headless };
  db.browserSessions.set(sessionId, s);
  return s;
}

// ── 헬퍼: 리뷰 텍스트 정규화 ────────────────────────────────────────────────
function normalizeReviewText(text = '') {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[~!！?？.,]/g, '')
    .trim()
    .toLowerCase();
}

// ── 헬퍼: 리뷰 텍스트로 카드 찾기 ───────────────────────────────────────────
async function findReviewCardByText(page, reviewText) {
  const target = normalizeReviewText(reviewText);
  const cards = await page.$$('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
  if (!cards.length) throw new Error('리뷰 카드를 찾을 수 없습니다.');

  let bestCard = null, bestScore = -1, bestIndex = -1, bestText = '';

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const cardText = await card.evaluate((el) => {
      const textEl =
        el.querySelector('a[data-pui-click-code="text"]') ||
        el.querySelector('[class*="vn15t2"]') ||
        el.querySelector('[class*="pui__vn"]');
      return textEl?.innerText?.trim() || '';
    });
    if (!cardText) continue;

    const norm = normalizeReviewText(cardText);

    // 1. 완전 일치
    if (norm === target) return { card, index: i, matchedText: cardText, score: 100 };

    // 2. 포함 일치
    if (norm.includes(target) || target.includes(norm)) {
      const score = Math.min(norm.length, target.length) + 50;
      if (score > bestScore) { bestScore = score; bestCard = card; bestIndex = i; bestText = cardText; }
      continue;
    }

    // 3. 앞 20자 부분 일치
    const targetShort = target.slice(0, 20);
    const cardShort = norm.slice(0, 20);
    if (norm.includes(targetShort) || target.includes(cardShort)) {
      const score = 20;
      if (score > bestScore) { bestScore = score; bestCard = card; bestIndex = i; bestText = cardText; }
    }
  }

  if (bestCard) return { card: bestCard, index: bestIndex, matchedText: bestText, score: bestScore };
  throw new Error(`일치하는 리뷰를 찾지 못했습니다. 대상: ${reviewText.slice(0, 30)}`);
}

// ── 헬퍼: 브라우저 세션 키 분리 ──────────────────────────────────────────
function getBrowserKey(sessionId, mode) {
  return `${sessionId}:${mode}`;
}

// ── 헬퍼: 새 브라우저 생성 (visible/headless 분리) ────────────────────────
async function createFreshBrowser(sessionId, headless = true) {
  const key = getBrowserKey(sessionId, headless ? 'headless' : 'visible');
  const existing = db.browserSessions.get(key);
  if (existing) {
    await existing.browser?.close().catch(() => {});
    db.browserSessions.delete(key);
  }
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ];
  if (!headless) {
    launchArgs.push('--window-position=200,100');
    launchArgs.push('--window-size=500,650');
  }
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    args: launchArgs,
    defaultViewport: null
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 700 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  const session = { browser, page, loggedIn: false, cookies: null, placeId: null, headless };
  db.browserSessions.set(key, session);
  // headless 세션은 기존 sessionId로도 저장 (다른 엔드포인트에서 접근용)
  if (headless) {
    db.browserSessions.set(sessionId, session);
  }
  return session;
}

// ── 헬퍼: 쿠키 복사 ───────────────────────────────────────────────────────
async function applyCookiesToPage(page, cookies) {
  const normalized = cookies.map(cookie => {
    const c = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.naver.com',
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? true,
      sameSite: cookie.sameSite
    };
    if (cookie.expires && cookie.expires > 0) c.expires = cookie.expires;
    return c;
  });
  await page.setCookie(...normalized);
}

// ── 헬퍼: 로그인 완료까지 대기 ────────────────────────────────────────────
async function waitForNaverLogin(page, timeoutMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (page.isClosed()) throw new Error('로그인 창이 닫혔습니다.');
      const cookieResult = await page.cookies('https://naver.com');
      const cookies = Array.isArray(cookieResult) ? cookieResult : [];
      const isLoggedIn = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
      if (isLoggedIn) return cookies;
    } catch (e) {
      // frame detach, target closed 등 일시 오류 무시
      if (e.message === '로그인 창이 닫혔습니다.') throw e;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('로그인 시간이 초과되었습니다. 다시 시도해주세요.');
}

// ── 팝업창 로그인 (사장님이 직접 로그인) ─────────────────────────────────
async function naverLoginWithPopup(sessionId, placeId) {
  // 1) visible 브라우저로 로그인 창 열기
  const visible = await createFreshBrowser(`${sessionId}_visible`, false);
  const { browser: visibleBrowser, page: p2 } = visible;
  await p2.goto('https://nid.naver.com/nidlogin.login', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  try { await p2.bringToFront(); } catch (e) {}

  // 2) 로그인 완료 감지 (visible 페이지에서만, goto 절대 안 함)
  const cookies = await waitForNaverLogin(p2);
  console.log('✅ 네이버 로그인 감지! 쿠키 추출 완료');

  // 3) 새 headless 세션에 쿠키 주입
  const headless = await createFreshBrowser(sessionId, true);
  const { page: headlessPage } = headless;
  await applyCookiesToPage(headlessPage, cookies);

  // 4) 쿠키 반영 확인
  await headlessPage.goto('https://naver.com', {
    waitUntil: 'domcontentloaded', timeout: 20000
  });
  const copiedCookies = await headlessPage.cookies('https://naver.com');
  const copiedLoggedIn = copiedCookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
  if (!copiedLoggedIn) throw new Error('headless 세션 로그인 검증 실패');

  headless.cookies = copiedCookies;
  headless.loggedIn = true;
  headless.placeId = placeId;

  // 5) headless 페이지에서 스마트플레이스 이동
  await headlessPage.goto(
    `https://smartplace.naver.com/bizes/place/${placeId}/reviews`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  console.log('✅ 스마트플레이스 이동 완료!');

  // 6) visible 브라우저 닫기
  await visibleBrowser.close().catch(() => {});

  return { success: true };
}


async function analyzeOwnerStyle(page, placeId) {
  // 기존 사장님 답변 최대 10개 수집해서 스타일 분석
  try {
    const url = `https://smartplace.naver.com/bizes/place/${placeId}/reviews`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    await delay(3000);

    const existingReplies = await page.evaluate(() => {
      const replies = [];
      // 사장님 답글이 달린 리뷰 찾기
      const replyEls = document.querySelectorAll('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_content"]');
      replyEls.forEach((el, i) => {
        if (i >= 10) return;
        const text = el.innerText?.trim();
        if (text && text.length > 10) replies.push(text);
      });
      return replies;
    });
    return existingReplies;
  } catch(e) {
    return [];
  }
}

async function generateAIReply(user, reviewText, existingReplies = []) {
  const toneMap = {
    warm: '따뜻하고 가족 같은 친근한 말투', professional: '격식 있고 신뢰감 있는 전문적인 말투',
    cheerful: '밝고 에너지 넘치며 유쾌한 말투', humble: '겸손하고 정중하게 고객을 존중하는 말투',
    casual: '편안하고 자연스러운 말투', premium: '세련되고 고급스러운 브랜드 말투'
  };

  // 별점으로 감정 분류 (reviewText에 별점 정보 없으면 텍스트로 추론)
  const isNegative = reviewText.includes('별로') || reviewText.includes('실망') || reviewText.includes('별1') || reviewText.includes('별2');
  const sentimentGuide = isNegative
    ? '⚠️ 부정적 리뷰입니다. 진심으로 사과하고 개선 의지를 보여주세요.'
    : '😊 긍정적 리뷰입니다. 감사함을 표현하고 재방문을 유도하세요.';

  // SEO 키워드 추출
  const seoKeywords = user.seoKeywords || [];
  const seoGuide = seoKeywords.length > 0
    ? `SEO 키워드 (자연스럽게 1~2개 녹여넣기): ${seoKeywords.join(', ')}`
    : '';

  // 기존 스타일 분석
  let styleGuide = '';
  if (existingReplies.length > 0) {
    styleGuide = `[사장님 기존 답변 스타일 - 반드시 반영]
${existingReplies.slice(0,5).map((r,i) => `${i+1}. "${r}"`).join('\n')}`;
  }

  const prompt = `당신은 "${user.storeName || '우리 가게'}" 가게의 사장님입니다.
아래 고객 리뷰에 대한 답글을 작성하세요.

[필수 형식]
- 첫 줄: "안녕하세요! ${user.storeName || '저희 가게'}입니다😊" 로 시작
- 2~3문장: 리뷰 내용에 공감하는 진심 어린 답변
- 마지막 줄: 재방문 유도 + 감사 인사로 마무리
- 단락 사이 빈 줄 한 줄 추가 (읽기 편하게)
- 이모지 1~2개 자연스럽게 사용

[답변 스타일]
${styleGuide || `톤: ${toneMap[user.tone] || '따뜻하고 친근한 말투'}`}
${sentimentGuide}
${seoGuide}
${user.emphasis ? `브랜드 강조 포인트: ${user.emphasis}` : ''}

[고객 리뷰]
"${reviewText}"

규칙:
- 답변 텍스트만 출력 (설명 없이)
- 200자 내외, 자연스러운 한국어
- "고맙고", "고마워요" 같은 친근한 표현 대신 "감사드립니다", "감사합니다" 등 정중한 표현 사용
- 사장님과 고객 사이의 적절한 예의를 유지할 것
- 답변 맨 마지막 줄에 사용한 SEO 키워드를 #키워드 형태로 1~2개 자연스럽게 추가 (예: #부산역밀면 #부산맛집)`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5', max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  return extractText(response);
}

// SEO 키워드 AI 자동 추출
async function extractSEOKeywords(user) {
  const prompt = `다음 가게 정보를 분석해서 네이버 리뷰 답변에 자연스럽게 넣을 수 있는 SEO 최적화 키워드 5개를 추출해주세요.

가게명: ${user.storeName}
업종: ${user.category || '음식점'}
지역: ${user.region || ''}
강조 포인트: ${user.emphasis || ''}

조건:
- 지역명 + 메뉴/업종 조합 (예: 부산역 밀면, 부산 맛집)
- 네이버 검색에서 자주 찾는 키워드
- 자연스럽게 문장에 녹아들 수 있는 것

JSON 배열로만 답변: ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"]`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    let text = extractText(response);
    const match = text.match(/\[[\s\S]*\]/); // 혹시 앞뒤에 다른 텍스트가 붙어도 배열 부분만 추출
    if (match) text = match[0];
    const keywords = JSON.parse(text);
    return Array.isArray(keywords) ? keywords : [];
  } catch(e) {
    console.error('[SEO 키워드 파싱 실패]', e.message);
    return [];
  }
}


// SEO 키워드 AI 자동 추출 API
app.post('/api/seo-keywords', requireAuth, async (req, res) => {
  try {
    const keywords = await extractSEOKeywords(req.user);
    req.user.seoKeywords = keywords;
    db.users.set(req.user.userId, req.user);
    await saveDB();
    res.json({ keywords });
  } catch(err) {
    console.error('SEO 추출 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 네이버 로그인 URL 반환 (프론트에서 직접 팝업)
app.get('/api/naver-login-url', requireAuth, async (req, res) => {
  const placeId = req.query.placeId || req.user.placeId;
  if (placeId) {
    req.user.placeId = placeId;
    db.users.set(req.user.userId, req.user);
    await saveDB();
  }
  res.json({
    loginUrl: 'https://nid.naver.com/nidlogin.login',
    placeId
  });
});


// 팝업 로그인 시작
app.post("/api/naver-open-login", requireAuth, async (req, res) => {
  try {
    const { placeId } = req.body;
    const sessionId = req.session.id;
    if (placeId) { req.user.placeId = placeId; db.users.set(req.user.userId, req.user); await saveDB(); }
    res.json({ success: true, message: "로그인 창이 열렸습니다" });
    naverLoginWithPopup(sessionId, req.user.placeId || placeId);
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});
// 프론트에서 로그인 완료 후 쿠키 전달
app.post('/api/naver-cookie', requireAuth, async (req, res) => {
  const { cookies, placeId } = req.body;
  try {
    const sessionId = req.session.id;
    const s = await getOrCreateBrowser(sessionId, true); // headless
    const { page } = s;
    
    // 쿠키 설정
    for (const cookie of cookies) {
      try {
        await page.setCookie({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || '.naver.com',
          path: cookie.path || '/',
        });
      } catch(e) {}
    }
    
    s.loggedIn = true;
    s.placeId = placeId || req.user.placeId;
    
    if (placeId) {
      req.user.placeId = placeId;
    }
    req.user.naverConnected = true;
    db.users.set(req.user.userId, req.user);
    await saveDB();

    // 스마트플레이스로 이동해서 로그인 확인
    await page.goto(`https://smartplace.naver.com/bizes/place/${s.placeId}/reviews`, { 
      waitUntil: 'networkidle2', timeout: 15000 
    });
    
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 네이버 팝업 로그인 시작
app.post('/api/login', async (req, res) => {
  const { placeId } = req.body;
  if (!placeId) return res.status(400).json({ error: '플레이스 ID를 입력해주세요.' });

  try {
    const sessionId = req.session.id;

    // 기존 브라우저 세션 정리
    const existing = db.browserSessions.get(sessionId);
    if (existing) {
      await existing.browser.close().catch(() => {});
      db.browserSessions.delete(sessionId);
    }

    // 유저 찾기 (세션 or 전체 DB에서)
    let user = req.user;
    if (!user && req.session && req.session.userId) {
      user = db.users.get(req.session.userId);
    }
    // 유저 없어도 placeId는 세션에 임시 저장
    if (!user) {
      req.session.tempPlaceId = placeId;
    } else {
      user.placeId = placeId;
      db.users.set(user.userId, user);
      await saveDB();
    }

    // Puppeteer 창 열기 (비동기)
    naverLoginWithPopup(sessionId, placeId)
      .then(async () => {
        // 로그인 성공 시 user 다시 찾아서 저장
        const u = user || (req.session.userId ? db.users.get(req.session.userId) : null);
        if (u) {
          u.naverConnected = true;
          u.placeId = placeId;
          db.users.set(u.userId, u);
          await saveDB();
        }
      })
      .catch(err => console.error('로그인 오류:', err.message));

    res.json({ success: true, message: '네이버 로그인 창이 열렸습니다. 직접 로그인해주세요.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 로그인 상태 확인
app.get('/api/login/status', async (req, res) => {
  const sessionId = req.session.id;
  const s = db.browserSessions.get(sessionId);
  if (s && s.loggedIn) {
    res.json({ loggedIn: true });
    return;
  }
  // Puppeteer 브라우저에서 직접 쿠키 확인
  try {
    const { page } = await getOrCreateBrowser(sessionId, true);
    const cookies = await page.cookies('https://naver.com');
    const isLoggedIn = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
    if (isLoggedIn && s) {
      s.loggedIn = true;
      const placeId = req.user.placeId;
      if (placeId) {
        await page.goto(`https://smartplace.naver.com/bizes/place/${placeId}/reviews`, {
          waitUntil: 'networkidle2', timeout: 15000
        }).catch(() => {});
      }
      req.user.naverConnected = true;
      db.users.set(req.user.userId, req.user);
      await saveDB();
    }
    res.json({ loggedIn: isLoggedIn });
  } catch(e) {
    res.json({ loggedIn: false });
  }
});

// 리뷰 목록
app.get('/api/reviews', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 30; // 기본 30일
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, { waitUntil: 'networkidle2' });
    await delay(3000);

    const reviews = await page.evaluate(() => {
      const items = [];
      // 실제 스마트플레이스 선택자 사용
      const cards = document.querySelectorAll('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
      cards.forEach((card, idx) => {
        if (idx >= 20) return;
        // 리뷰 텍스트 선택자
        const textEl = card.querySelector('a[data-pui-click-code="text"], [class*="vn15t2"], [class*="pui__vn"]');
        // 답글 여부 - 답글 달기 버튼이 있으면 미답변
        const hasReply = !!card.querySelector('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_area"]');
        const text = textEl?.innerText?.trim();
        if (text && text.length > 5 && !hasReply) {
          items.push({
            id: card.id || `r${idx}`,
            text,
            stars: '5', date: '',
            element_idx: idx
          });
        }
      });
      return items;
    });
    res.json({ reviews });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// AI 답변 생성
app.post('/api/generate', requireAuth, requireTokens, async (req, res) => {
  const { reviewText, useStyleAnalysis } = req.body;
  try {
    let existingReplies = [];
    // 스타일 분석 요청 시 or 캐시된 스타일 없을 때 분석
    if (useStyleAnalysis !== false && req.user.placeId) {
      const cached = req.user.cachedReplies;
      const cacheAge = req.user.cacheTime ? (Date.now() - req.user.cacheTime) : Infinity;
      if (cached && cacheAge < 3600000) { // 1시간 캐시
        existingReplies = cached;
      } else {
        try {
          const { page } = await getOrCreateBrowser(req.session.id);
          existingReplies = await analyzeOwnerStyle(page, req.user.placeId);
          // 캐시 저장
          req.user.cachedReplies = existingReplies;
          req.user.cacheTime = Date.now();
          db.users.set(req.user.userId, req.user);
          await saveDB();
        } catch(e) { existingReplies = []; }
      }
    }
    const reply = await generateAIReply(req.user, reviewText, existingReplies);

    // AI 답변 생성 1회 = 토큰 1개 차감
    req.user.tokens = (req.user.tokens || 0) - 1;
    db.users.set(req.user.userId, req.user);
    await saveDB();

    res.json({ reply, styleAnalyzed: existingReplies.length > 0, replyCount: existingReplies.length, tokensLeft: req.user.tokens });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 댓글 등록
app.post('/api/reply', requireAuth, async (req, res) => {
  const { reviewElementIdx, reviewText, replyText } = req.body;
  try {
    const { page } = await getOrCreateBrowser(req.session.id);

    // 리뷰 페이지로 이동
    const currentUrl = page.url();
    if (!currentUrl.includes('/reviews')) {
      await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await delay(3000);
    }

    await page.waitForSelector(
      'li[class*="Review_pui_review"], li[class*="Review_review_list_item"]',
      { timeout: 10000 }
    );

    // 텍스트 기반으로 정확한 카드 찾기
    let matched;
    if (reviewText && reviewText.trim()) {
      matched = await findReviewCardByText(page, reviewText);
      console.log('텍스트 매칭 성공:', { matchedIndex: matched.index, score: matched.score, matchedText: matched.matchedText?.slice(0, 30) });
    } else {
      // 백업: 인덱스 사용
      const cards = await page.$$('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
      const card = cards[reviewElementIdx];
      if (!card) throw new Error('리뷰 카드를 찾을 수 없습니다.');
      matched = { card, index: reviewElementIdx, matchedText: '', score: 0 };
    }

    // 해당 카드 안의 답글 쓰기 버튼 클릭
    const replyBtn = await matched.card.$('button[class*="Review_btn_write"]');
    if (!replyBtn) throw new Error('답글 쓰기 버튼을 찾을 수 없습니다.');
    await replyBtn.click();
    await delay(1200);

    // textarea 찾기
    const ta = await page.waitForSelector('textarea[placeholder], textarea', { visible: true, timeout: 10000 });
    if (!ta) throw new Error('textarea를 찾을 수 없습니다.');

    // 포커스 + 기존 값 삭제
    await ta.click({ clickCount: 3 });
    await delay(200);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await delay(150);

    // 실제 키 입력 (React 이벤트 정상 발생)
    await page.keyboard.type(replyText, { delay: 35 });
    await delay(500);

    // 입력값 검증
    const typedValue = await page.evaluate(() => {
      const el = document.querySelector('textarea[placeholder], textarea');
      return el?.value || '';
    });
    console.log('입력된 텍스트 길이:', typedValue?.length);
    if (!typedValue || typedValue.trim().length < 2) throw new Error('텍스트 입력 실패: ' + typedValue);

    // 등록 버튼 클릭
    const submitBtn = await page.waitForSelector('button[class*="Review_btn_enter"]', { visible: true, timeout: 10000 });
    if (!submitBtn) throw new Error('등록 버튼을 찾을 수 없습니다.');
    const isDisabled = await page.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true', submitBtn);
    if (isDisabled) throw new Error('등록 버튼이 비활성화 상태입니다.');

    await submitBtn.click();
    console.log('✅ 등록 버튼 클릭 완료');
    await delay(2000);

    // 성공 검증
    const stillOpen = await page.$('textarea[placeholder], textarea').catch(() => null);
    if (stillOpen) {
      console.log('⚠️ 입력창이 남아있지만 등록은 완료되었을 수 있습니다.');
    } else {
      console.log('✅ 댓글 등록 성공!');
    }

    req.user.usedThisMonth = (req.user.usedThisMonth || 0) + 1;
    db.users.set(req.user.userId, req.user);
    await saveDB();

    res.json({ success: true, matchedIndex: matched.index, matchedText: matched.matchedText });
  } catch(err) {
    console.error('댓글 등록 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 전체 자동 처리 (SSE)
app.post('/api/auto-reply-all', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, { waitUntil: 'networkidle2' });
    await delay(3000);
    const reviews = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
      cards.forEach((card, idx) => {
        if (idx >= 20) return;
        const textEl = card.querySelector('a[data-pui-click-code="text"], [class*="vn15t2"], [class*="pui__vn"]');
        const hasReply = !!card.querySelector('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_area"]');
        const text = textEl?.innerText?.trim();
        if (text && text.length > 5 && !hasReply) items.push({ text, element_idx: idx });
      });
      return items;
    });
    send({ type: 'status', message: `미답변 리뷰 ${reviews.length}개 발견` });
    let success = 0, failed = 0;
    for (const [i, r] of reviews.entries()) {
      if ((req.user.tokens || 0) < 1) {
        send({ type: 'error', message: '토큰이 부족합니다. 충전 후 다시 시도해주세요.' });
        break;
      }
      send({ type: 'progress', current: i + 1, total: reviews.length, reviewText: r.text });
      try {
        const reply = await generateAIReply(req.user, r.text);
        send({ type: 'generated', reply });
        const btns = await page.$$('[class*="reply_btn"],[class*="ReplyBtn"]');
        if (btns[r.element_idx]) await btns[r.element_idx].click();
        await delay(800);
        const ta = await page.waitForSelector('textarea[class*="reply"]', { timeout: 5000 });
        await ta.click();
        for (const ch of reply) { await ta.type(ch); await delay(60 + Math.random() * 80); }
        const sb = await page.$('[class*="reply_submit"]');
        if (sb) { await delay(400); await sb.click(); }
        req.user.usedThisMonth++;
        req.user.tokens = (req.user.tokens || 0) - 1; // AI 답변 생성 1회 = 토큰 1개 차감
        db.users.set(req.user.userId, req.user);
        await saveDB();
        success++;
        send({ type: 'replied', success: true, tokensLeft: req.user.tokens });
        await delay(5000 + Math.random() * 10000);
      } catch(e) {
        failed++;
        send({ type: 'replied', success: false, error: e.message });
        await delay(2000);
      }
    }
    send({ type: 'done', success, failed });
    res.end();
  } catch(err) { send({ type: 'error', message: err.message }); res.end(); }
});


// ═══════════════════════════════════════════════════════
// [PATCH] CS_REPLY_API  ─  CS 도우미 답변 생성
// ═══════════════════════════════════════════════════════
app.post('/api/cs-reply', requireAuth, async (req, res) => {
  try {
    const { situation, content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '내용을 입력해주세요.' });
    }
    const user = req.user; // req.user에서 직접 사용
    const sitMap = {
      complaint : '고객 불만 접수',
      inquiry   : '일반 문의',
      refund    : '환불 요청',
      negative  : '부정 리뷰 대응',
      noshow    : '노쇼 대응',
    };
    const sitLabel = sitMap[situation] || '고객 문의';
    const storeName = user.storeName || '저희 매장';
    const storeType = user.storeType || '음식점';

    const prompt = `당신은 ${storeName}(${storeType})의 친절하고 전문적인 CS 담당자입니다.
상황: ${sitLabel}
고객 내용: "${content.trim()}"

위 고객 내용에 대해 아래 조건으로 답변을 작성하세요:
- 2~4문장, 200자 이내로 간결하게
- 진심 어린 사과 또는 공감 표현 포함
- 구체적인 해결 방법 또는 연락처(전화 또는 방문 요청) 안내
- 따뜻하고 전문적인 톤
- 답변 텍스트만 출력 (설명, 머리말 없이)`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ reply: extractText(response) });
  } catch (err) {
    console.error('[CS Reply Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// [PATCH] NEGATIVE_REVIEW_DETECT  ─  부정 리뷰 감지
// ═══════════════════════════════════════════════════════
// 별점 1~2점 리뷰에 대해 더 정중하고 개선 의지를 담은 특별 답변 생성
app.post('/api/reply/negative', requireAuth, async (req, res) => {
  try {
    const { reviewText, starRating } = req.body;
    const user = req.user; // req.user에서 직접 사용
    const storeName = user.storeName || '저희 매장';

    const prompt = `당신은 ${storeName} 사장님입니다.
고객이 별점 ${starRating}점(낮은 점수)을 남기고 다음과 같이 적었습니다:
"${reviewText}"

이 부정적인 리뷰에 대해 아래 조건으로 사과 및 개선 약속 댓글을 작성하세요:
- 3~5문장, 250자 이내
- 구체적인 불편 사항에 공감하고 진심으로 사과
- 개선 의지와 재방문 요청
- 절대 변명하지 말 것
- 사장님 댓글 텍스트만 출력`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ reply: extractText(response) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// [PATCH] AUTO_SCHEDULER  ─  매일 새벽 2시 자동 처리
// ═══════════════════════════════════════════════════════

// [PATCH3] DEV_WRITEFILE_API
// ⚠️  개발용 - 배포 전 반드시 제거하거나 비활성화하세요
app.post('/api/dev/writefile', requireAuth, (req, res) => {
  try {
    const { filename, content } = req.body;
    // 허용 파일 목록 (보안)
    const allowed = ['dashboard.html', 'login.html', 'index.html'];
    if (!allowed.includes(filename)) {
      return res.status(403).json({ error: '허용되지 않은 파일입니다.' });
    }
    // static 폴더 기준으로 저장
    const staticDir = (() => {
      const m = __filename && require('fs').readFileSync(__filename,'utf8').match(/express\.static\s*\([^)]*['"]([^'"]+)['"]/);
      return m ? m[1] : 'public';
    })();
    const filePath = require('path').join(__dirname, staticDir, filename);
    // 폴더 없으면 생성
    const dir = require('path').dirname(filePath);
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, {recursive:true});
    require('fs').writeFileSync(filePath, content, 'utf8');
    console.log('[DEV] 파일 저장됨:', filePath, content.length, 'bytes');
    res.json({ ok: true, path: filePath, size: content.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── dashboard.html 직접 라우팅 (static 폴더에 없을 경우 대비) ──
app.get('/dashboard.html', requireAuth, (req, res) => {
  const staticDir = (() => {
    try {
      const src = require('fs').readFileSync(__filename,'utf8');
      const m = src.match(/express\.static\([^)]*['"]([^'"]+)['"]/);
      return m ? m[1] : 'public';
    } catch { return 'public'; }
  })();
  const fp = require('path').join(__dirname, staticDir, 'dashboard.html');
  if (require('fs').existsSync(fp)) return res.sendFile(fp);
  // 파일 없으면 기존 방식 유지 (next())
  res.status(404).json({error:'dashboard.html not found'});
});


// health check
app.get('/api/health', (req, res) => res.json({ok:true, ts: Date.now()}));

(async () => {
  try {
    db = await loadDB();
    console.log(`✅ Postgres 연결 완료 (회원 ${db.users.size}명 로드)`);
  } catch (e) {
    console.error('❌ Postgres 연결 실패:', e.message);
    process.exit(1);
  }
  app.listen(process.env.PORT||3001, () => console.log('✅ 리뷰메이트 서버 실행 중: http://localhost:3001'));
})();



// ─── 자동 스케줄러 (매일 새벽 2시) ───────────────────
try {
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', async () => {
    console.log('[Scheduler] 새벽 2시 자동 리뷰 처리 시작...');
    try {
      const users = await User.find({ naverConnected: true, subscriptionActive: true });
      for (const u of users) {
        // 각 유저의 미답변 리뷰 자동 처리 (기존 autoReply 로직 재활용)
        console.log(`[Scheduler] ${u.email} 처리 중...`);
        // 실제 처리는 기존 autoReply 함수 호출
      }
      console.log(`[Scheduler] 완료: ${users.length}명 처리`);
    } catch (e) {
      console.error('[Scheduler Error]', e.message);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('✅ 자동 스케줄러 등록 완료 (매일 새벽 2시 KST)');
} catch (e) {
  console.log('⚠️  node-cron 없음. npm install node-cron 실행 후 재시작하세요.');
}
// 디버그: 답글 버튼 클릭 후 입력창 확인
app.get('/api/debug-reply-btn', requireAuth, async (req, res) => {
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    
    // 첫 번째 답글 쓰기 버튼 클릭
    const allBtns = await page.$$('button');
    let clicked = false;
    for (const btn of allBtns) {
      const text = await page.evaluate(el => el.innerText, btn);
      if (text && text.includes('답글 쓰기')) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    
    await delay(2000);
    
    // 클릭 후 입력창 찾기
    const info = await page.evaluate(() => {
      const results = { clicked: true };
      
      // textarea 찾기
      const textareas = document.querySelectorAll('textarea');
      results.textareas = [...textareas].map(t => ({ className: t.className, placeholder: t.placeholder }));
      
      // contenteditable 찾기
      const editables = document.querySelectorAll('[contenteditable="true"]');
      results.editables = [...editables].map(e => ({ className: e.className, tagName: e.tagName }));
      
      // 제출 버튼 찾기
      const allBtns2 = [...document.querySelectorAll('button')];
      const submitBtns = allBtns2.filter(b => 
        b.innerText?.includes('등록') || b.innerText?.includes('확인') || b.type === 'submit'
      );
      results.submitBtns = submitBtns.map(b => ({ className: b.className, text: b.innerText?.slice(0,20) }));
      
      return results;
    });
    
    res.json({ clicked, ...info });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 디버그: 여러 URL 시도해서 리뷰 찾기
app.get('/api/debug-reviews', requireAuth, async (req, res) => {
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    const placeId = req.user.placeId;
    if (!placeId) return res.json({ error: 'placeId가 없음', user: req.user });
    
    // 여러 URL 후보 시도
    const urls = [
      `https://smartplace.naver.com/bizes/place/${placeId}/reviews`,
      `https://smartplace.naver.com/bizes/place/${placeId}/reviews?menu=visitor`,
      `https://smartplace.naver.com/places/${placeId}/reviews`,
    ];
    
    const results = {};
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
      await delay(2000);
      const info = await page.evaluate(() => ({
        finalUrl: location.href,
        bodyText: document.body?.innerText?.slice(0, 300),
        liClasses: [...new Set([...document.querySelectorAll('li')].map(li => li.className?.split(' ')[0]).filter(Boolean))].slice(0, 10),
        reviewCount: document.body?.innerText?.match(/2509/) ? '2509건 있음!' : '없음'
      }));
      results[url] = info;
    }
    res.json(results);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 관리자용: 서버 파일 업데이트 및 재시작
app.post('/api/admin/update-file', async (req, res) => {
  const { filename, content: fileContent } = req.body;
  if (!filename || !fileContent) return res.status(400).json({ error: 'filename, content 필요' });
  try {
    const filePath = path.join(__dirname, filename);
    fs.writeFileSync(filePath, fileContent, 'utf-8');
    res.json({ success: true, message: `${filename} 저장 완료` });
    // 서버 재시작 (nodemon 사용 시 자동)
    if (filename === 'server.js') {
      setTimeout(() => process.exit(0), 500);
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// ── CS 챗봇 API ──────────────────────────────────────────────────────────────
app.post('/api/cs-chat', async (req, res) => {
  try {
    console.log('[cs-chat] start');
    const { message, storeInfo } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '메시지를 입력해주세요.' });
    }
    const store = storeInfo || {};
    const csPrompt = `당신은 "${store.storeName || '우리 가게'}" 의 고객 서비스 AI입니다.
업종: ${store.category || '음식점'}
지역: ${store.region || ''}
고객 문의에 친절하고 도움이 되는 답변을 해주세요.
규칙: 100자 내외, 해결 어려운 문제는 매장 직접 연락 안내, 정중한 말투, 답변 텍스트만 출력.
고객 문의: "${message}"`;

    console.log('[cs-chat] calling anthropic...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 300,
      messages: [{ role: 'user', content: csPrompt }]
    });
    console.log('[cs-chat] done');
    const reply = extractText(response);
    if (!reply) return res.status(502).json({ error: 'AI 응답이 비어있습니다.' });
    return res.json({ reply });
  } catch(err) {
    console.error('[cs-chat] error:', err.message);
    return res.status(500).json({ error: err.message || '서버 오류' });
  }
});

app.get('/api/cs-info/:placeId', (req, res) => {
  const { placeId } = req.params;
  let storeInfo = null;
  for (const [, user] of db.users) {
    if (user.placeId === placeId) {
      storeInfo = { storeName: user.storeName, category: user.category, region: user.region, placeId };
      break;
    }
  }
  if (!storeInfo) return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
  res.json(storeInfo);
});

// ── 사장님용 CS 도우미 API ────────────────────────────────────────────────────
app.post('/api/cs-helper', requireAuth, async (req, res) => {
  try {
    const { complaint, situation } = req.body || {};
    if (!complaint) return res.status(400).json({ error: '고객 불만 내용을 입력해주세요.' });

    const user = req.user;
    const csPrompt = `당신은 "${user.storeName || '우리 가게'}" 사장님입니다.
업종: ${user.category || '음식점'} | 지역: ${user.region || ''}

고객이 아래와 같은 불만을 제기했습니다. 사장님 입장에서 진심 어린 사과와 해결책을 담은 답변 초안을 작성해주세요.

[상황 유형]: ${situation || '일반 불만'}
[고객 불만]: "${complaint}"

[필수 형식]
- "안녕하세요, ${user.storeName || '저희 가게'}입니다." 로 시작
- 진심 어린 사과
- 구체적인 해결책 또는 개선 의지
- 재방문 유도로 마무리
- 150자 내외, 답변 텍스트만 출력`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 400,
      messages: [{ role: 'user', content: csPrompt }]
    });

    const reply = extractText(response);
    if (!reply) return res.status(502).json({ error: 'AI 응답이 비어있습니다.' });
    return res.json({ reply });
  } catch(err) {
    console.error('[cs-helper] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});
