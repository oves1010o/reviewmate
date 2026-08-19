# 리뷰메이트 전체 작업 컨텍스트

> 작성일: 2026년 4월 20일  
> 이 문서를 Claude에 첨부하면 작업을 바로 이어갈 수 있습니다.

---

## 1. 프로젝트 개요

**리뷰메이트(ReviewMate)** 는 네이버 스마트플레이스 리뷰에 AI가 자동으로 답글을 생성·등록해주는 SaaS 서비스입니다.

- 사장님이 로그인 후 네이버 계정을 연동하면
- 미답변 리뷰를 자동으로 불러와
- Claude AI가 가게 스타일에 맞는 답글을 생성하고
- Puppeteer(Chrome 자동화)로 스마트플레이스에 직접 등록

---

## 2. 기술 스택

| 항목 | 내용 |
|------|------|
| 런타임 | Node.js 20 |
| 프레임워크 | Express.js |
| AI | Anthropic Claude API (claude-sonnet-4-20250514, claude-haiku-4-5-20251001) |
| 자동화 | Puppeteer + Xvfb (헤드리스 Chrome) |
| 인증 | express-session + bcryptjs |
| DB | 파일 기반 db.json (Map 구조) |
| 호스팅 | Railway (Docker 기반) |
| 결제 | 토스페이먼츠 (미완성) |

---

## 3. 접속 정보

| 항목 | 내용 |
|------|------|
| 배포 URL | https://reviewmate-saas-production-00b8.up.railway.app |
| GitHub | https://github.com/rlaehddnr3352-ctrl/reviewmate-saas |
| 로컬 경로 | C:\reviewmate-saas-v2\backend\server.js |
| 테스트 계정 | test@reviewmate.com / test1234! |
| Railway 프로젝트 | helpful-generosity / production |
| Railway 서비스 ID | 45e17421-71ae-4d07-952c-1c17892d4171 |

---

## 4. 파일 구조

```
reviewmate-saas/
├── backend/
│   ├── server.js          ← 핵심. 전체 API + Puppeteer 로직 (778줄)
│   ├── Dockerfile         ← 오늘 수정 완료
│   ├── package.json       ← puppeteer, express, anthropic 등
│   ├── railway.json       ← { "build": { "builder": "DOCKERFILE" } }
│   ├── db.json            ← 유저 데이터 (재배포 시 초기화됨!)
│   ├── .env.example       ← 환경변수 예시
│   └── pages/
│       ├── login.html     ← 로그인/회원가입 UI
│       └── dashboard.html ← 메인 대시보드 UI
├── docs/
└── frontend/pages/        ← 현재 backend/pages와 동일 내용
```

---

## 5. 현재 Dockerfile 내용 (수정 완료본)

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fonts-nanum \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --only=production
COPY . .

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -ac +render -noreset & sleep 5 && node server.js"]
```

**변경 이유:**
- `node:20-alpine` → `node:20-slim`: Alpine은 musl libc 기반이라 Chromium/Xvfb 호환성 불안정. Debian(slim) 으로 변경
- `apk` → `apt-get`: Debian 패키지 관리자
- `sleep 2` → `sleep 5`: Xvfb가 완전히 초기화되기 전에 Node가 뜨는 문제 방지

---

## 6. server.js 핵심 구조 요약

### 6-1. Puppeteer 실행 공통 설정
```javascript
const PUPPETEER_EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

function getBaseLaunchArgs(headless) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',  // Railway 메모리 부족 방지 핵심
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...'
  ];
  if (!headless) {
    args.push('--window-position=200,100', '--window-size=500,650',
              '--new-window', '--foreground');
  }
  return args;
}
```

### 6-2. 브라우저 세션 관리
```javascript
// 브라우저 인스턴스를 세션별로 Map에 저장
const db = { users: new Map(), browserSessions: new Map() }

// headless/visible 모드 분리 키
function getBrowserKey(sessionId, mode) { return `${sessionId}:${mode}`; }

// 기존 세션 재사용 or 새로 생성
async function getOrCreateBrowser(sessionId, headless = true) { ... }

// 완전 새 브라우저 생성 (로그인용)
async function createFreshBrowser(sessionId, headless = true) { ... }
```

### 6-3. 네이버 로그인 플로우
```javascript
async function naverLoginWithPopup(sessionId, placeId) {
  // 1. visible 브라우저로 네이버 로그인 페이지 열기
  const visible = await createFreshBrowser(`${sessionId}_visible`, false);
  await p2.goto('https://nid.naver.com/nidlogin.login');

  // 2. 사용자가 직접 로그인할 때까지 최대 10분 대기
  const cookies = await waitForNaverLogin(p2);  // NID_AUT 쿠키 감지

  // 3. headless 브라우저에 쿠키 복사 → 스마트플레이스 이동
  const headless = await createFreshBrowser(sessionId, true);
  await applyCookiesToPage(headlessPage, cookies);
  await headlessPage.goto(`https://smartplace.naver.com/bizes/place/${placeId}/reviews`);

  // 4. visible 브라우저 닫기
  await visibleBrowser.close();
}
```

**⚠️ 현재 문제:**  
Railway는 GUI 없는 서버환경이므로 `headless: false`로 창을 띄워도 사용자가 볼 수 없음.  
Xvfb(가상 디스플레이)로 실행은 되지만 사용자 상호작용 불가.

### 6-4. 주요 API 엔드포인트
```
POST /api/auth/signup           회원가입
POST /api/auth/login            로그인
POST /api/logout                로그아웃
GET  /api/user/me               내 정보
PUT  /api/user/config           설정 저장

POST /api/naver-open-login      네이버 로그인 창 열기 ← 현재 디버깅 중
GET  /api/login/status          네이버 로그인 상태
POST /api/naver-cookie          쿠키 직접 전달 방식

GET  /api/reviews               미답변 리뷰 목록
POST /api/generate              AI 답글 생성
POST /api/reply                 리뷰에 답글 등록
POST /api/auto-reply-all        전체 자동 답글 (SSE 스트리밍)

POST /api/seo-keywords          SEO 키워드 추출
POST /api/cs-reply              CS 답변 생성
POST /api/cs-chat               CS 챗봇
POST /api/cs-helper             불만 처리 도우미
GET  /api/health                헬스체크
```

---

## 7. 오늘 디버깅 과정 전체

### 7-1. 초기 증상
- "네이버 로그인 창 열기" 버튼 클릭 → 아무 반응 없음
- 서버 응답도 없는 상태

### 7-2. Railway 로그에서 발견한 에러
```
[162:162] ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:256
Missing X server or $DISPLAY
The platform failed to initialize. Exiting.
```
→ Xvfb가 뜨기 전에 Puppeteer가 실행되거나, Alpine 환경에서 Xvfb 연동 실패

### 7-3. 추가로 발견한 문제들
1. `node:20-alpine` 이미지에서 Chromium + Xvfb 조합 불안정
2. `puppeteer.launch()`에 `executablePath` 미지정
3. `--disable-dev-shm-usage` 옵션 없어서 Railway 컨테이너 메모리 문제 발생 가능
4. API가 에러 시 조용히 실패 (catch 없음) → 클라이언트에서 무반응으로 보임

### 7-4. 적용한 수정
1. Dockerfile: Alpine → Slim, sleep 5
2. server.js: executablePath 추가, --disable-dev-shm-usage 추가, 로그 추가, 응답 선처리

### 7-5. 배포 결과
- Dockerfile commit: `Update Dockerfile to use node:20-slim base image` ✅
- server.js commit: `fix: add executablePath and disable-dev-shm-usage for Puppeteer on Railway` ✅
- Railway 배포: **COMPLETED / Deployment successful** ✅

---

## 8. 앞으로 해야 할 작업 (우선순위순)

### 🔴 긴급

#### 1. Railway 유료 플랜 전환
- 현재 Trial 잔여: 5일 또는 $4.82
- Railway 대시보드 → 우측 상단 "Choose a Plan" → Hobby ($5/월)

#### 2. 네이버 로그인 방식 변경 (핵심 과제)

**현재 방식의 근본적 문제:**
Railway 서버는 GUI가 없어서 Puppeteer로 창을 열어도 사용자가 볼 수 없습니다.
Xvfb는 서버 내부에서만 작동하는 가상 디스플레이입니다.

**권장 해결 방법 — 아이디/비번 자동 입력 방식:**
```javascript
// server.js naverLoginWithPopup 함수를 아래처럼 변경
async function naverAutoLogin(sessionId, naverId, naverPw, placeId) {
  const s = await createFreshBrowser(sessionId, true); // headless: true
  const { page } = s;

  await page.goto('https://nid.naver.com/nidlogin.login');
  await page.type('#id', naverId, { delay: 80 });
  await page.type('#pw', naverPw, { delay: 80 });
  await page.click('.btn_login');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // 로그인 성공 확인
  const cookies = await page.cookies('https://naver.com');
  const loggedIn = cookies.some(c => c.name === 'NID_AUT');
  if (!loggedIn) throw new Error('로그인 실패 - 아이디/비번 확인 필요');

  // 스마트플레이스 이동
  await page.goto(`https://smartplace.naver.com/bizes/place/${placeId}/reviews`);
  s.loggedIn = true;
  s.cookies = cookies;
}
```

**대시보드에 추가할 UI:**
```html
<!-- 네이버 계정 연동 폼 -->
<input type="text" id="naverId" placeholder="네이버 아이디" />
<input type="password" id="naverPw" placeholder="네이버 비밀번호" />
<input type="text" id="placeId" placeholder="스마트플레이스 ID (숫자)" />
<button onclick="connectNaver()">네이버 연동</button>
```

**API 수정:**
```javascript
// /api/naver-open-login 을 아래처럼 교체
app.post('/api/naver-auto-login', requireAuth, async (req, res) => {
  const { naverId, naverPw, placeId } = req.body;
  try {
    await naverAutoLogin(req.session.id, naverId, naverPw, placeId);
    // 비번은 암호화해서 저장 (자동 재로그인용)
    req.user.naverId = naverId;
    req.user.naverPw = await bcrypt.hash(naverPw, 10);
    req.user.placeId = placeId;
    saveDB();
    res.json({ success: true });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});
```

> ⚠️ 보안 주의: 비밀번호 저장 시 반드시 암호화. 가능하면 로그인 성공 후 쿠키만 저장하고 비번은 폐기.

---

### 🟡 중요

#### 3. DB 영속성 해결
현재 `db.json`은 컨테이너 내부에 있어서 Railway 재배포 시 **모든 유저 데이터가 삭제**됩니다.

**Railway PostgreSQL 추가 방법:**
1. Railway 대시보드 → `+ New` → `Database` → `PostgreSQL`
2. 연결 후 `DATABASE_URL` 환경변수 자동 생성됨
3. server.js에서 `pg` 라이브러리로 교체

**임시 해결책 (빠른 적용):**
Railway에 Volume 마운트 추가:
```
Railway → 서비스 → Settings → Volumes
→ Mount Path: /app/data
→ db.json 경로를 /app/data/db.json 으로 변경
```

#### 4. 세션 영속성 해결
현재 메모리 세션 → Railway 재시작 시 모든 로그인 세션 초기화

**해결:** Railway에 Redis 추가
```
Railway → + New → Database → Redis
→ REDIS_URL 환경변수 자동 생성
→ connect-redis 패키지로 세션 스토어 교체
```

---

### 🟢 나중에

#### 5. 토스페이먼츠 연동 완성
- `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY` 환경변수 설정 필요
- 현재 `/api/payment/prepare`, `/api/payment/confirm` API는 코드만 있고 실제 키 없음

#### 6. 2단계 인증 대응
네이버 로그인 시 SMS/앱 인증이 뜨는 경우 처리 로직 필요
```javascript
// 로그인 후 2단계 인증 페이지 감지
const url = page.url();
if (url.includes('nid.naver.com/login/sso')) {
  // 사용자에게 인증 코드 입력 요청 (WebSocket 또는 폴링)
}
```

#### 7. 리뷰 셀렉터 안정화
네이버 스마트플레이스 UI가 변경되면 Puppeteer 셀렉터가 깨질 수 있음
```javascript
// 현재 사용 중인 셀렉터들 (깨지면 여기 수정)
'li[class*="Review_pui_review"]'
'li[class*="Review_review_list_item"]'
'a[data-pui-click-code="text"]'
'button[class*="Review_btn_write"]'
'button[class*="Review_btn_enter"]'
```

---

## 9. 환경변수 목록 (Railway Variables 탭)

| 변수명 | 필수 | 현재 상태 | 설명 |
|--------|------|-----------|------|
| `ANTHROPIC_API_KEY` | ✅ 필수 | 확인 필요 | AI 답글 생성 |
| `SESSION_SECRET` | 권장 | 미설정 시 기본값 | 세션 암호화 키 |
| `PORT` | 자동 | Railway 자동 설정 | 서버 포트 |
| `PUPPETEER_EXECUTABLE_PATH` | ✅ 필수 | Dockerfile ENV로 설정됨 `/usr/bin/chromium` | Chromium 경로 |
| `DISPLAY` | ✅ 필수 | Dockerfile ENV로 설정됨 `:99` | Xvfb 디스플레이 |
| `NODE_ENV` | 권장 | `production` | 환경 구분 |
| `TOSS_CLIENT_KEY` | 결제 시 필수 | 미설정 | 토스페이먼츠 |
| `TOSS_SECRET_KEY` | 결제 시 필수 | 미설정 | 토스페이먼츠 |

---

## 10. 다음 작업 시 Claude에게 전달할 내용

이 파일을 첨부하고 아래처럼 말하면 됩니다:

```
리뷰메이트 SaaS 네이버 연동 디버깅 계속 진행합니다.
첨부 파일에 전체 컨텍스트 있습니다.

현재 상태:
- Dockerfile, server.js 수정 후 Railway 재배포 완료 (COMPLETED)
- 네이버 로그인 버튼 테스트 결과: [여기에 Railway 로그 붙여넣기]

다음 할 일:
- 네이버 로그인 방식을 아이디/비번 자동 입력 방식으로 변경
```

---

## 11. 트러블슈팅 치트시트

| 증상 | 원인 | 해결 |
|------|------|------|
| 버튼 클릭 후 무반응 | API 에러가 catch 없이 실패 | Railway 로그 확인 |
| `Missing X server or $DISPLAY` | Xvfb 미실행 or 타이밍 문제 | sleep 값 늘리기, DISPLAY 환경변수 확인 |
| `Failed to launch browser` | executablePath 경로 오류 | `/usr/bin/chromium` vs `/usr/bin/chromium-browser` 확인 |
| `Page crashed` | 메모리 부족 | `--disable-dev-shm-usage` 확인, Railway 플랜 업그레이드 |
| 재배포 후 로그인 풀림 | 메모리 세션 초기화 | Redis 세션 스토어 적용 |
| 재배포 후 회원 데이터 사라짐 | db.json 초기화 | Railway Volume or PostgreSQL 적용 |
| 네이버 로그인 창 안 보임 | Railway 서버는 GUI 없음 | 아이디/비번 자동 입력 방식으로 변경 |

---

*문서 끝 — Claude와 함께 작업 중 (2026.04.20)*
