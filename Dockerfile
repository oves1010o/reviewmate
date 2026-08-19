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
