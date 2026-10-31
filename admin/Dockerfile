# ---- build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- run (Next.js standalone server)
FROM node:22-alpine
ENV NODE_ENV=production \
	PORT=3001 \
	HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
	CMD wget -qO- http://127.0.0.1:3001/health > /dev/null || exit 1

CMD ["node", "server.js"]
