FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY api/ ./api/
COPY server.js relay.js ./
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
