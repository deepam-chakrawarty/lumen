# Lumen proxy — lightweight Bun image for India-friendly hosts (e.g. Railway/Fly Mumbai, OCI Mumbai).
FROM oven/bun:1.4.2-alpine AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY config ./config
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATABASE_URL=sqlite:./data/lumen.db

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["bun", "run", "src/index.ts"]
