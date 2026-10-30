FROM node:22-alpine

ENV NODE_ENV=production \
    HTTP_PORT=8000

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

USER node

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${HTTP_PORT}/health" || exit 1

# node is PID 1 and forwards SIGTERM to the workers (graceful shutdown in server.js)
CMD ["node", "server.js"]
