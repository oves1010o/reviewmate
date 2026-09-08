#!/bin/sh
set -e

echo "[start.sh] Xvfb 가상 화면 준비 중..."
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# 이전 실행(비정상 종료/재시작)이 남긴 잠금파일이 있으면 Xvfb가 아예 못 뜨므로 먼저 정리
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
pkill -9 Xvfb 2>/dev/null || true
pkill -9 x11vnc 2>/dev/null || true

Xvfb :99 -screen 0 1280x1024x24 -ac +render -noreset &
XVFB_PID=$!

# Xvfb가 실제로 소켓을 열 때까지 최대 10초 대기 (막연한 sleep 대신 실제 준비 여부 확인)
for i in $(seq 1 20); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    echo "[start.sh] Xvfb 준비 완료 (${i}00ms 이내)"
    break
  fi
  sleep 0.5
done

if [ ! -e /tmp/.X11-unix/X99 ]; then
  echo "[start.sh] ⚠️ Xvfb가 10초 안에 시작되지 않았습니다. 네이버 로그인창 기능이 동작하지 않을 수 있습니다."
fi

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[start.sh] ⚠️ Xvfb 프로세스가 죽어있습니다 (PID $XVFB_PID). 헤드풀 브라우저 실행이 실패할 수 있습니다."
fi

echo "[start.sh] 화면공유(VNC) 서버 준비 중..."
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -bg -o /tmp/x11vnc.log
websockify --heartbeat=30 6080 localhost:5900 &
echo "[start.sh] VNC 준비 완료 (포트 6080)"

echo "[start.sh] 서버 시작..."
exec node server.js
