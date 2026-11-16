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
ENV PORT=3000 HOST=0.0.0.0
CMD ["bun", "server.js"]
