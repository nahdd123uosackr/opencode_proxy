# Stage 1: Build uTLS bridge (Go)
FROM golang:1.24-alpine AS builder
WORKDIR /build
COPY utls_bridge/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o utls_bridge .

# Stage 2: Bun runtime
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --production --ignore-scripts
COPY api/ ./api/
COPY server.js relay.js ./
COPY --from=builder /build/utls_bridge ./utls_bridge/utls_bridge
EXPOSE 3000
# Northflank(Generic)에서는 PORT=8080 고정이므로 환경변수 미설정 시 8080으로 기동한다.
# server.js 의 기본값도 8080 이라 ENV PORT 는 주지 않는다.
ENV HOST=0.0.0.0
CMD ["bun", "server.js"]
