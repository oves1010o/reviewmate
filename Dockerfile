FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-nanum \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --only=production
COPY . .

CMD ["node", "server.js"]
