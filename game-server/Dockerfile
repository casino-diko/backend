FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

USER node

# baccarat, dragon-tiger, poker
EXPOSE 8007 8008 8009

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
	CMD wget -qO- "http://127.0.0.1:${HEALTHCHECK_PORT:-8007}/health" > /dev/null || exit 1

CMD ["node", "src/index.js"]
