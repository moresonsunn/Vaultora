# ---- frontend builder (React SPA, compiled to static files) ----
FROM node:20 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- runtime ----
FROM node:20-alpine

# Stamped by CI (Actions passes --build-arg). Shown in the UI footer + /api/version.
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    NODE_ENV=production \
    PORT=8090 \
    STORAGE_ROOT=/data \
    APP_DATA=/app/data \
    TZ=UTC \
    PUID=1000 \
    PGID=1000

RUN apk add --no-cache su-exec tzdata wget \
  && addgroup -S appuser 2>/dev/null || true \
  && adduser -S -G appuser appuser 2>/dev/null || true

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund --build-from-source
COPY src ./src
COPY --from=frontend /build/public ./public
COPY openapi.yaml ./openapi.yaml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data /app/data \
  && node -e "console.log('build ok')"

EXPOSE 8090
VOLUME ["/data", "/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8090}/health | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
