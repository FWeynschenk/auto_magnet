# Stage 1 — build Vue client
FROM node:22-slim AS client-builder
WORKDIR /build
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2 — production server
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=client-builder /build/dist ./client/dist

EXPOSE 62201
CMD ["node", "server/index.js"]
