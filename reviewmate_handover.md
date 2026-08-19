# 리뷰메이트 (ReviewMate) 인수인계 문서

> 작성일: 2026년 4월 20일  
> 작업자 → 인수자 인계용

---

## 📌 프로젝트 기본 정보

| 항목 | 내용 |
|------|------|
| 서비스명 | 리뷰메이트 (ReviewMate) |
| 배포 URL | https://reviewmate-saas-production-00b8.up.railway.app |
| GitHub | https://github.com/rlaehddnr3352-ctrl/reviewmate-saas |
| 호스팅 | Railway (Trial, **5일 또는 $4.82 남음 — 유료 플랜 전환 필요!**) |
| DB | 파일 기반 (`backend/db.json`) |
| 테스트 계정 | test@reviewmate.com / test1234! |

---

## 🗂️ 프로젝트 구조

```
reviewmate-saas/
├── backend/
│   ├── server.js         ← 핵심 서버 파일 (Node.js + Express)
│   ├── Dockerfile        ← 오늘 수정 완료
│   ├── package.json
│   ├── db.json           ← 유저 데이터 저장소 (파일 DB)
│   ├── railway.json      ← Railway 빌드 설정
│   └── pages/            ← 프론트엔드 HTML 파일들
│       ├── login.html
│       └── dashboard.html
├── docs/
└── frontend/pages/
```

---

## ✅ 오늘 완료한 작업

### 1. Dockerfile 수정 (`backend/Dockerfile`)
**문제:** `node:20-alpine` 이미지에서 Xvfb + Chromium 조합이 제대로 작동 안 함

**수정 내용:**
```dockerfile
# 변경 전
FROM node:20-alpine
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont xvfb
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -ac +render -noreset & sleep 2 && node server.js"]

# 변경 후
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

**핵심 변경 포인트:**
- Alpine → Slim (Debian 기반, chromium/xvfb 호환성 훨씬 좋음)
- `sleep 2` → `sleep 5` (Xvfb 완전히 뜰 시간 확보)
- commit: `Update Dockerfile to use node:20-slim base image`

---

### 2. server.js 대폭 수정 (`backend/server.js`)
**문제:** Puppeteer 실행 시 `executablePath` 미설정, `--disable-dev-shm-usage` 옵션 누락 → Railway 컨테이너에서 Chrome 실행 실패

**핵심 변경 내용:**

#### A. Puppeteer 공통 실행 옵션 함수 추가
```javascript
const PUPPETEER_EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

function getBaseLaunchArgs(headless) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',   // ← 핵심! 메모리 부족 방지
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 ...'
  ];
  // visible 모드일 때 추가 옵션
  if (!headless) {
    args.push('--window-position=200,100', '--window-size=500,650', ...);
  }
  return args;
}
```

#### B. getOrCreateBrowser / createFreshBrowser에 executablePath 추가
```javascript
const browser = await puppeteer.launch({
  headless: headless ? 'new' : false,
  executablePath: PUPPETEER_EXEC,   // ← 핵심 추가!
  args: getBaseLaunchArgs(headless),
  defaultViewport: null
});
```

#### C. /api/naver-open-login 로그 추가 + 응답 선처리
```javascript
app.post('/api/naver-open-login', requireAuth, async (req, res) => {
  console.log('[API] /api/naver-open-login 호출됨', req.body);
  // 응답 먼저 보내고 → Puppeteer 백그라운드 실행
  res.json({ success: true, message: '로그인 창이 열렸습니다' });
  naverLoginWithPopup(sessionId, ...).catch(err => {
    console.error('[naverLoginWithPopup] 에러:', err.message, err.stack);
  });
});
```

#### D. naverLoginWithPopup 로그 추가
```javascript
async function naverLoginWithPopup(sessionId, placeId) {
  console.log('[naverLoginWithPopup] 시작 sessionId:', sessionId, 'placeId:', placeId);
  // ...
  console.log('[createFreshBrowser] headless:', headless, 'exec:', PUPPETEER_EXEC, 'DISPLAY:', process.env.DISPLAY);
}
```

- commit: `fix: add executablePath and disable-dev-shm-usage for Puppeteer on Railway`
- **배포 결과: ✅ COMPLETED / Deployment successful**

---

## 🔍 현재 상태 (배포 완료 후)

| 기능 | 상태 |
|------|------|
| 서버 기동 | ✅ 정상 |
| 로그인 / 회원가입 | ✅ 작동 |
| AI 답변 생성 | ✅ 작동 |
| 대시보드 | ✅ 작동 |
| 네이버 로그인 창 열기 | ❓ **배포 후 첫 테스트 필요** |
| 리뷰 자동 답글 등록 | ❓ 네이버 로그인 성공 후 테스트 필요 |

---

## 🧪 지금 당장 해야 할 테스트

### Step 1. 네이버 로그인 버튼 테스트
1. https://reviewmate-saas-production-00b8.up.railway.app/login.html 접속
2. `test@reviewmate.com` / `test1234!` 로그인
3. 대시보드 → **"네이버 로그인 창 열기"** 버튼 클릭
4. Railway 로그(Deploy Logs)에서 아래 메시지 확인:
   ```
   [API] /api/naver-open-login 호출됨
   [naverLoginWithPopup] 시작 sessionId: xxx
   [createFreshBrowser] headless: false exec: /usr/bin/chromium DISPLAY: :99
   ```

### Step 2. 로그 확인 방법
Railway 대시보드 → `helpful-generosity` 프로젝트 → `reviewmate-saas` 서비스
→ 최신 배포 **View logs** → **Deploy Logs** 탭

---

## 🚨 앞으로 해야 할 작업

### [긴급] Railway 유료 플랜 전환
- 현재 Trial: **5일 또는 $4.82 남음**
- 결제 안 하면 서비스 중단됨
- Railway 대시보드 우측 상단 → **"Choose a Plan"** 클릭
- Hobby 플랜 $5/월 권장

---

### [1단계] 네이버 로그인 디버깅 (최우선)

**시나리오 A: 버튼 클릭 후 로그에 에러 없이 정상 흐름이면**
→ Railway는 GUI가 없는 서버라 Xvfb로 가상 화면을 띄워도 **사용자가 직접 로그인할 수 없음**
→ 아래 대안 중 하나 선택 필요:

| 방법 | 설명 | 난이도 |
|------|------|--------|
| **방법 1. 아이디/비번 직접 입력** | 대시보드에서 네이버 ID/PW 입력 → 서버가 자동으로 로그인 | ⭐⭐ |
| **방법 2. 쿠키 직접 붙여넣기** | 사용자가 로컬에서 네이버 로그인 후 쿠키 복사 → 서버에 전달 | ⭐⭐⭐ |
| **방법 3. 로컬 프록시 방식** | 로컬 PC에서 Puppeteer 실행, 서버는 API만 | ⭐⭐⭐⭐ |

**현재 코드에서 방법 1 구현 위치:**
- `server.js` → `/api/naver-open-login` 엔드포인트 수정
- 대시보드 HTML에 ID/PW 입력 폼 추가

**시나리오 B: 로그에 에러가 나오면**
→ 에러 메시지 내용에 따라 추가 수정 필요
→ 흔한 에러:
```
# 에러 1: chromium 경로 문제
Error: Failed to launch the browser process
→ server.js PUPPETEER_EXEC 경로 확인: /usr/bin/chromium vs /usr/bin/chromium-browser

# 에러 2: DISPLAY 연결 실패
Error: spawn /usr/bin/chromium ENOENT
→ Dockerfile CMD의 sleep 시간 늘리기 (5 → 10)

# 에러 3: 메모리 부족
Error: Page crashed
→ Railway 플랜 업그레이드 또는 --disable-dev-shm-usage 재확인
```

---

### [2단계] 네이버 로그인 연동 완성 후

- [ ] 리뷰 목록 불러오기 테스트 (`/api/reviews`)
- [ ] 리뷰 답글 자동 등록 테스트 (`/api/reply`)
- [ ] 전체 자동 답글 테스트 (`/api/auto-reply-all`)

---

### [3단계] 서비스 안정화

- [ ] `db.json` → MongoDB 또는 PostgreSQL 마이그레이션 (Railway 재시작 시 db.json 초기화됨!)
- [ ] 세션 스토어 → Redis 연동 (현재 메모리 세션 → 재시작 시 로그아웃)
- [ ] 토스페이먼츠 실제 연동 (현재 환경변수만 세팅, 미완성)
- [ ] 자동 스케줄러 (node-cron) 실제 동작 구현

---

### [4단계] DB 영속성 문제 해결 (중요!)

현재 `db.json`은 컨테이너 내부에 있어서 **Railway 재배포 시 데이터가 모두 사라집니다.**

```
해결 방법:
1. Railway에 PostgreSQL 추가 (무료 플랜 있음)
   → Railway 대시보드 → + New → Database → PostgreSQL
2. server.js에서 Prisma 또는 pg 라이브러리로 교체
```

---

## 🔧 환경변수 확인 (Railway Variables 탭)

Railway 대시보드 → Variables 탭에서 아래가 설정되어 있어야 합니다:

| 변수명 | 설명 | 현재 상태 |
|--------|------|-----------|
| `ANTHROPIC_API_KEY` | AI 답변 생성용 | 설정 필요 확인 |
| `SESSION_SECRET` | 세션 암호화 | 미설정 시 기본값 사용 |
| `TOSS_CLIENT_KEY` | 토스페이먼츠 | 미완성 |
| `TOSS_SECRET_KEY` | 토스페이먼츠 | 미완성 |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Dockerfile ENV로 설정됨 |
| `DISPLAY` | `:99` | Dockerfile ENV로 설정됨 |

---

## 📋 핵심 API 목록

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/auth/login` | 로그인 |
| POST | `/api/auth/signup` | 회원가입 |
| GET | `/api/user/me` | 내 정보 조회 |
| POST | `/api/naver-open-login` | 네이버 로그인 창 열기 ← 현재 디버깅 중 |
| GET | `/api/login/status` | 네이버 로그인 상태 확인 |
| GET | `/api/reviews` | 리뷰 목록 조회 |
| POST | `/api/generate` | AI 답글 생성 |
| POST | `/api/reply` | 리뷰에 답글 등록 |
| POST | `/api/auto-reply-all` | 전체 미답변 자동 처리 (SSE) |
| GET | `/api/health` | 서버 상태 확인 |

---

## 💡 작업 시 참고사항

1. **GitHub push → Railway 자동 배포** (약 30~60초 소요)
2. **파일 수정은 GitHub 웹에서 직접 가능** (연필 아이콘 클릭)
3. **로그 확인**: Railway → View logs → Deploy Logs 탭
4. **서버 재시작**: Railway → 배포 항목 우측 `···` → Redeploy
5. **로컬 개발**: `C:\reviewmate-saas-v2\backend\` 에서 `node server.js`

---

*이 문서는 Claude와 함께 작업한 내용을 기반으로 자동 생성되었습니다.*
