# Stage 1: Build uTLS bridge (Go)
FROM golang:1.24-alpine AS builder
WORKDIR /build
COPY utls_bridge/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o utls_bridge .

# Stage 2: Node.js runtime
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY api/ ./api/
COPY server.js relay.js ./
COPY --from=builder /build/utls_bridge ./utls_bridge/utls_bridge
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
