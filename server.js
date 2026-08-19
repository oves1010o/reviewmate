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
const PLAN = { name: '리뷰메이트 월정액', price: 9900, trialDays: 7 };

const fs = require('fs');
const DB_FILE = path.join(__dirname, 'db.json');
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { users: new Map(Object.entries(data.users || {})), browserSessions: new Map() };
  } catch { return { users: new Map(), browserSessions: new Map() }; }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: Object.fromEntries(db.users) }, null, 2));
}
const db = loadDB();
function generateId() { return Math.random().toString(36).substr(2, 12); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const user = db.users.get(req.session.userId);
  if (!user) return res.status(401).json({ error: '유효하지 않은 세션입니다.' });
  req.user = user; next();
}
function requireSubscription(req, res, next) { return next(); }

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, storeName } = req.body;
  if (!email || !password || !storeName) return res.status(400).json({ error: '필수 항목을 입력해주세요.' });
  for (const [, u] of db.users) {
    if (u.email === email) return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
  }
  const trialEnd = new Date(); trialEnd.setDate(trialEnd.getDate() + PLAN.trialDays);
  const userId = generateId();
  db.users.set(userId, {
    userId, email, password: await bcrypt.hash(password, 10), storeName,
    plan: 'standard', subscriptionActive: false, trialEndsAt: trialEnd.toISOString(),
    billingKey: null, nextBillingDate: null, naverId: null, naverPw: null, placeId: null,
    tone: 'warm', emphasis: '', usedThisMonth: 0, createdAt: new Date().toISOString()
  });
  saveDB();
  res.json({ success: true, userId });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  let found = null;
  for (const [, u] of db.users) { if (u.email === email) { found = u; break; } }
  if (!found || !await bcrypt.compare(password, found.password))
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
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
  const now = new Date();
  safe.isTrialActive = now < new Date(req.user.trialEndsAt);
  safe.trialDaysLeft = Math.max(0, Math.ceil((new Date(req.user.trialEndsAt) - now) / 86400000));
  res.json(safe);
});

app.put('/api/user/config', requireAuth, (req, res) => {
  const { storeName, tone, emphasis, region, category, seoKeywords } = req.body;
  Object.assign(req.user, { storeName, tone, emphasis, region, category });
  if (seoKeywords) req.user.seoKeywords = seoKeywords;
  db.users.set(req.user.userId, req.user); saveDB();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// ✅ Puppeteer 공통 설정 (오늘 수정 핵심)
// ══════════════════════════════════════════════════════════════════════════
const PUPPETEER_EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

function getBaseLaunchArgs(headless) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',   // ✅ Railway 메모리 제한 대응
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  if (!headless) {
    args.push('--window-position=200,100', '--window-size=500,650', '--new-window', '--foreground');
  }
  return args;
}

async function getOrCreateBrowser(sessionId, headless = true) {
  const existing = db.browserSessions.get(sessionId);
  if (existing) {
    if (existing.headless !== headless) {
      await existing.browser.close().catch(() => {}); db.browserSessions.delete(sessionId);
    } else {
      try { await existing.page.title(); return existing; }
      catch { db.browserSessions.delete(sessionId); }
    }
  }
  console.log('[Browser] 새 브라우저 생성, headless:', headless, 'exec:', PUPPETEER_EXEC);
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    executablePath: PUPPETEER_EXEC,  // ✅ 추가
    args: getBaseLaunchArgs(headless),
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

function normalizeReviewText(text = '') {
  return text.replace(/\s+/g, ' ').replace(/[~!！?？.,]/g, '').trim().toLowerCase();
}

async function findReviewCardByText(page, reviewText) {
  const target = normalizeReviewText(reviewText);
  const cards = await page.$$('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
  if (!cards.length) throw new Error('리뷰 카드를 찾을 수 없습니다.');
  let bestCard = null, bestScore = -1, bestIndex = -1, bestText = '';
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const cardText = await card.evaluate((el) => {
      const textEl = el.querySelector('a[data-pui-click-code="text"]') || el.querySelector('[class*="vn15t2"]') || el.querySelector('[class*="pui__vn"]');
      return textEl?.innerText?.trim() || '';
    });
    if (!cardText) continue;
    const norm = normalizeReviewText(cardText);
    if (norm === target) return { card, index: i, matchedText: cardText, score: 100 };
    if (norm.includes(target) || target.includes(norm)) {
      const score = Math.min(norm.length, target.length) + 50;
      if (score > bestScore) { bestScore = score; bestCard = card; bestIndex = i; bestText = cardText; }
    }
  }
  if (bestCard) return { card: bestCard, index: bestIndex, matchedText: bestText, score: bestScore };
  throw new Error(`일치하는 리뷰를 찾지 못했습니다: ${reviewText.slice(0, 30)}`);
}

function getBrowserKey(sessionId, mode) { return `${sessionId}:${mode}`; }

async function createFreshBrowser(sessionId, headless = true) {
  const key = getBrowserKey(sessionId, headless ? 'headless' : 'visible');
  const existing = db.browserSessions.get(key);
  if (existing) { await existing.browser?.close().catch(() => {}); db.browserSessions.delete(key); }
  console.log('[createFreshBrowser] headless:', headless, 'exec:', PUPPETEER_EXEC, 'DISPLAY:', process.env.DISPLAY);
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    executablePath: PUPPETEER_EXEC,  // ✅ 추가
    args: getBaseLaunchArgs(headless),
    defaultViewport: null
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 700 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  const s = { browser, page, loggedIn: false, cookies: null, placeId: null, headless };
  db.browserSessions.set(key, s);
  if (headless) { db.browserSessions.set(sessionId, s); }
  return s;
}

async function applyCookiesToPage(page, cookies) {
  const normalized = cookies.map(cookie => {
    const c = { name: cookie.name, value: cookie.value, domain: cookie.domain || '.naver.com',
      path: cookie.path || '/', httpOnly: cookie.httpOnly ?? false, secure: cookie.secure ?? true, sameSite: cookie.sameSite };
    if (cookie.expires && cookie.expires > 0) c.expires = cookie.expires;
    return c;
  });
  await page.setCookie(...normalized);
}

async function waitForNaverLogin(page, timeoutMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (page.isClosed()) throw new Error('로그인 창이 닫혔습니다.');
      const cookies = await page.cookies('https://naver.com');
      if (cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES')) return cookies;
    } catch (e) { if (e.message === '로그인 창이 닫혔습니다.') throw e; }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('로그인 시간이 초과되었습니다.');
}

// ✅ 로그 강화된 naverLoginWithPopup
async function naverLoginWithPopup(sessionId, placeId) {
  console.log('[naverLoginWithPopup] 시작 sessionId:', sessionId, 'placeId:', placeId);
  const visible = await createFreshBrowser(`${sessionId}_visible`, false);
  const { browser: visibleBrowser, page: p2 } = visible;
  await p2.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await p2.bringToFront(); } catch (e) {}
  const cookies = await waitForNaverLogin(p2);
  console.log('[naverLoginWithPopup] 로그인 감지! 쿠키 추출 완료');
  const headless = await createFreshBrowser(sessionId, true);
  const { page: headlessPage } = headless;
  await applyCookiesToPage(headlessPage, cookies);
  await headlessPage.goto('https://naver.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const copiedCookies = await headlessPage.cookies('https://naver.com');
  if (!copiedCookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES'))
    throw new Error('headless 세션 로그인 검증 실패');
  headless.cookies = copiedCookies; headless.loggedIn = true; headless.placeId = placeId;
  await headlessPage.goto(`https://smartplace.naver.com/bizes/place/${placeId}/reviews`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('[naverLoginWithPopup] 스마트플레이스 이동 완료!');
  await visibleBrowser.close().catch(() => {});
  return { success: true };
}

async function analyzeOwnerStyle(page, placeId) {
  try {
    await page.goto(`https://smartplace.naver.com/bizes/place/${placeId}/reviews`, { waitUntil: 'networkidle2' });
    await delay(3000);
    return await page.evaluate(() => {
      const replies = [];
      document.querySelectorAll('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_content"]').forEach((el, i) => {
        if (i >= 10) return;
        const text = el.innerText?.trim();
        if (text && text.length > 10) replies.push(text);
      });
      return replies;
    });
  } catch(e) { return []; }
}

async function generateAIReply(user, reviewText, existingReplies = []) {
  const toneMap = { warm: '따뜻하고 친근한 말투', professional: '전문적인 말투', cheerful: '밝고 유쾌한 말투', humble: '겸손하고 정중한 말투', casual: '편안한 말투', premium: '세련되고 고급스러운 말투' };
  const isNegative = reviewText.includes('별로') || reviewText.includes('실망');
  const sentimentGuide = isNegative ? '⚠️ 부정적 리뷰: 진심으로 사과하고 개선 의지를 보여주세요.' : '😊 긍정적 리뷰: 감사함을 표현하고 재방문을 유도하세요.';
  const seoKeywords = user.seoKeywords || [];
  const styleGuide = existingReplies.length > 0
    ? `[기존 답변 스타일]\n${existingReplies.slice(0,5).map((r,i) => `${i+1}. "${r}"`).join('\n')}`
    : `톤: ${toneMap[user.tone] || '따뜻하고 친근한 말투'}`;
  const prompt = `당신은 "${user.storeName || '우리 가게'}" 사장님입니다.

[형식]
- 첫 줄: "안녕하세요! ${user.storeName || '저희 가게'}입니다😊"
- 2~3문장: 리뷰에 공감하는 진심 어린 답변
- 마지막: 재방문 유도 + 감사 인사
- 이모지 1~2개

[스타일] ${styleGuide}
${sentimentGuide}
${seoKeywords.length > 0 ? `SEO 키워드: ${seoKeywords.join(', ')}` : ''}
${user.emphasis ? `강조 포인트: ${user.emphasis}` : ''}

[고객 리뷰] "${reviewText}"

답변 텍스트만 출력, 200자 내외`;
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  return response.content[0].text.trim();
}

// ══════════════════════════════════════════════════════════════════════════
// API 엔드포인트
// ══════════════════════════════════════════════════════════════════════════

app.post('/api/seo-keywords', requireAuth, async (req, res) => {
  try {
    const prompt = `가게 정보로 SEO 키워드 5개 추출.\n가게명: ${req.user.storeName}\n업종: ${req.user.category || '음식점'}\n지역: ${req.user.region || ''}\nJSON 배열만: ["키워드1","키워드2","키워드3","키워드4","키워드5"]`;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
    const keywords = JSON.parse(response.content[0].text.trim());
    req.user.seoKeywords = keywords; db.users.set(req.user.userId, req.user); saveDB();
    res.json({ keywords });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/naver-login-url', requireAuth, (req, res) => {
  const placeId = req.query.placeId || req.user.placeId;
  if (placeId) { req.user.placeId = placeId; db.users.set(req.user.userId, req.user); saveDB(); }
  res.json({ loginUrl: 'https://nid.naver.com/nidlogin.login', placeId });
});

// ✅ 응답 선처리 + 백그라운드 Puppeteer 실행
app.post('/api/naver-open-login', requireAuth, async (req, res) => {
  try {
    console.log('[API] /api/naver-open-login 호출됨', req.body);
    const { placeId } = req.body;
    const sessionId = req.session.id;
    if (placeId) { req.user.placeId = placeId; db.users.set(req.user.userId, req.user); saveDB(); }
    res.json({ success: true, message: '로그인 창이 열렸습니다' });
    naverLoginWithPopup(sessionId, req.user.placeId || placeId).catch(err => {
      console.error('[naverLoginWithPopup] 에러:', err.message, err.stack);
    });
  } catch(e) {
    console.error('[API] naver-open-login 에러:', e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/naver-cookie', requireAuth, async (req, res) => {
  const { cookies, placeId } = req.body;
  try {
    const s = await getOrCreateBrowser(req.session.id, true);
    for (const cookie of cookies) {
      try { await s.page.setCookie({ name: cookie.name, value: cookie.value, domain: cookie.domain || '.naver.com', path: cookie.path || '/' }); } catch(e) {}
    }
    s.loggedIn = true; s.placeId = placeId || req.user.placeId;
    if (placeId) req.user.placeId = placeId;
    req.user.naverConnected = true; db.users.set(req.user.userId, req.user); saveDB();
    await s.page.goto(`https://smartplace.naver.com/bizes/place/${s.placeId}/reviews`, { waitUntil: 'networkidle2', timeout: 15000 });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/login/status', async (req, res) => {
  const sessionId = req.session.id;
  const s = db.browserSessions.get(sessionId);
  if (s && s.loggedIn) { res.json({ loggedIn: true }); return; }
  try {
    const { page } = await getOrCreateBrowser(sessionId, true);
    const cookies = await page.cookies('https://naver.com');
    const isLoggedIn = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
    if (isLoggedIn && s && req.user) {
      s.loggedIn = true; req.user.naverConnected = true;
      db.users.set(req.user.userId, req.user); saveDB();
    }
    res.json({ loggedIn: isLoggedIn });
  } catch(e) { res.json({ loggedIn: false }); }
});

app.get('/api/reviews', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, { waitUntil: 'networkidle2' });
    await delay(3000);
    const reviews = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]').forEach((card, idx) => {
        if (idx >= 20) return;
        const textEl = card.querySelector('a[data-pui-click-code="text"], [class*="vn15t2"], [class*="pui__vn"]');
        const hasReply = !!card.querySelector('[class*="owner_reply"], [class*="OwnerReply"], [class*="reply_area"]');
        const text = textEl?.innerText?.trim();
        if (text && text.length > 5 && !hasReply) items.push({ id: card.id || `r${idx}`, text, stars: '5', date: '', element_idx: idx });
      });
      return items;
    });
    res.json({ reviews });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/generate', requireAuth, requireSubscription, async (req, res) => {
  const { reviewText, useStyleAnalysis } = req.body;
  try {
    let existingReplies = [];
    if (useStyleAnalysis !== false && req.user.placeId) {
      const cached = req.user.cachedReplies;
      const cacheAge = req.user.cacheTime ? (Date.now() - req.user.cacheTime) : Infinity;
      if (cached && cacheAge < 3600000) { existingReplies = cached; }
      else {
        try {
          const { page } = await getOrCreateBrowser(req.session.id);
          existingReplies = await analyzeOwnerStyle(page, req.user.placeId);
          req.user.cachedReplies = existingReplies; req.user.cacheTime = Date.now();
          db.users.set(req.user.userId, req.user); saveDB();
        } catch(e) {}
      }
    }
    const reply = await generateAIReply(req.user, reviewText, existingReplies);
    res.json({ reply, styleAnalyzed: existingReplies.length > 0, replyCount: existingReplies.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reply', requireAuth, requireSubscription, async (req, res) => {
  const { reviewElementIdx, reviewText, replyText } = req.body;
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    if (!page.url().includes('/reviews')) {
      await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(3000);
    }
    await page.waitForSelector('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]', { timeout: 10000 });
    let matched;
    if (reviewText && reviewText.trim()) {
      matched = await findReviewCardByText(page, reviewText);
    } else {
      const cards = await page.$$('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]');
      const card = cards[reviewElementIdx];
      if (!card) throw new Error('리뷰 카드를 찾을 수 없습니다.');
      matched = { card, index: reviewElementIdx, matchedText: '', score: 0 };
    }
    const replyBtn = await matched.card.$('button[class*="Review_btn_write"]');
    if (!replyBtn) throw new Error('답글 쓰기 버튼을 찾을 수 없습니다.');
    await replyBtn.click(); await delay(1200);
    const ta = await page.waitForSelector('textarea[placeholder], textarea', { visible: true, timeout: 10000 });
    await ta.click({ clickCount: 3 }); await delay(200);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace'); await delay(150);
    await page.keyboard.type(replyText, { delay: 35 }); await delay(500);
    const typedValue = await page.evaluate(() => document.querySelector('textarea[placeholder], textarea')?.value || '');
    if (!typedValue || typedValue.trim().length < 2) throw new Error('텍스트 입력 실패');
    const submitBtn = await page.waitForSelector('button[class*="Review_btn_enter"]', { visible: true, timeout: 10000 });
    const isDisabled = await page.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true', submitBtn);
    if (isDisabled) throw new Error('등록 버튼이 비활성화 상태입니다.');
    await submitBtn.click(); await delay(2000);
    req.user.usedThisMonth = (req.user.usedThisMonth || 0) + 1;
    db.users.set(req.user.userId, req.user); saveDB();
    res.json({ success: true, matchedIndex: matched.index, matchedText: matched.matchedText });
  } catch(err) { console.error('댓글 등록 오류:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/auto-reply-all', requireAuth, requireSubscription, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache');
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    const { page } = await getOrCreateBrowser(req.session.id);
    await page.goto(`https://smartplace.naver.com/bizes/place/${req.user.placeId}/reviews`, { waitUntil: 'networkidle2' });
    await delay(3000);
    const reviews = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('li[class*="Review_pui_review"], li[class*="Review_review_list_item"]').forEach((card, idx) => {
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
      send({ type: 'progress', current: i + 1, total: reviews.length, reviewText: r.text });
      try {
        const reply = await generateAIReply(req.user, r.text);
        send({ type: 'generated', reply });
        success++; send({ type: 'replied', success: true });
        await delay(5000 + Math.random() * 10000);
      } catch(e) { failed++; send({ type: 'replied', success: false, error: e.message }); await delay(2000); }
    }
    send({ type: 'done', success, failed }); res.end();
  } catch(err) { send({ type: 'error', message: err.message }); res.end(); }
});

app.post('/api/cs-reply', requireAuth, async (req, res) => {
  try {
    const { situation, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: '내용을 입력해주세요.' });
    const sitMap = { complaint: '고객 불만', inquiry: '일반 문의', refund: '환불 요청', negative: '부정 리뷰', noshow: '노쇼 대응' };
    const prompt = `${req.user.storeName} CS 담당자로서 "${sitMap[situation]||'문의'}" 상황 답변.\n고객: "${content}"\n2~4문장, 200자 이내, 텍스트만 출력`;
    const response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reply/negative', requireAuth, async (req, res) => {
  try {
    const { reviewText, starRating } = req.body;
    const prompt = `${req.user.storeName} 사장님으로서 별점${starRating}점 리뷰 답변: "${reviewText}"\n진심 사과와 개선 약속, 250자 이내, 텍스트만`;
    const response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 450, messages: [{ role: 'user', content: prompt }] });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cs-chat', async (req, res) => {
  try {
    const { message, storeInfo } = req.body || {};
    if (!message) return res.status(400).json({ error: '메시지를 입력해주세요.' });
    const prompt = `"${storeInfo?.storeName||'우리 가게'}" CS AI. 문의: "${message}"\n100자 이내, 정중하게, 텍스트만`;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cs-info/:placeId', (req, res) => {
  let storeInfo = null;
  for (const [, user] of db.users) {
    if (user.placeId === req.params.placeId) { storeInfo = { storeName: user.storeName, category: user.category, region: user.region, placeId: req.params.placeId }; break; }
  }
  if (!storeInfo) return res.status(404).json({ error: '매장을 찾을 수 없습니다.' });
  res.json(storeInfo);
});

app.post('/api/cs-helper', requireAuth, async (req, res) => {
  try {
    const { complaint } = req.body || {};
    if (!complaint) return res.status(400).json({ error: '내용을 입력해주세요.' });
    const prompt = `"${req.user.storeName}" 사장님으로서 불만 처리: "${complaint}"\n사과와 해결책, 150자 이내, 텍스트만`;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/prepare', requireAuth, (req, res) => {
  res.json({ clientKey: process.env.TOSS_CLIENT_KEY || 'test_ck_여기에입력', customerKey: req.user.userId, orderId: `order_${req.user.userId}_${Date.now()}`, orderName: PLAN.name, amount: 0 });
});

app.post('/api/payment/confirm', requireAuth, async (req, res) => {
  const { authKey, customerKey } = req.body;
  try {
    const tossRes = await fetch('https://api.tosspayments.com/v1/billing/authorizations/confirm', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey, customerKey })
    });
    if (!tossRes.ok) throw new Error('빌링키 발급 실패');
    const tossData = await tossRes.json();
    req.user.billingKey = tossData.billingKey; req.user.subscriptionActive = true;
    db.users.set(req.user.userId, req.user); res.json({ success: true });
  } catch(err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/subscription/cancel', requireAuth, (req, res) => {
  req.user.subscriptionActive = false; db.users.set(req.user.userId, req.user);
  res.json({ success: true });
});

app.post('/api/admin/update-file', async (req, res) => {
  const { filename, content: fileContent } = req.body;
  if (!filename || !fileContent) return res.status(400).json({ error: 'filename, content 필요' });
  try {
    fs.writeFileSync(path.join(__dirname, filename), fileContent, 'utf-8');
    res.json({ success: true });
    if (filename === 'server.js') setTimeout(() => process.exit(0), 500);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  const fp = path.join(__dirname, 'pages', 'dashboard.html');
  if (fs.existsSync(fp)) return res.sendFile(fp);
  res.status(404).json({ error: 'dashboard.html not found' });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(process.env.PORT || 3001, () => console.log('✅ 리뷰메이트 서버 실행 중: http://localhost:3001'));

try {
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', async () => { console.log('[Scheduler] 새벽 2시 자동 처리 시작...'); }, { timezone: 'Asia/Seoul' });
  console.log('✅ 자동 스케줄러 등록 완료 (매일 새벽 2시 KST)');
} catch(e) { console.log('⚠️ node-cron 없음.'); }
