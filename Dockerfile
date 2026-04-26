# Multi-stage Node.js build for search-mcp
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc --noEmit -p tsconfig.json

# Stage 2: Production
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY README.md ./

# Copy config templates
COPY config.enc.dist ./config.enc.dist

# Switch to non-root user
USER appuser

EXPOSE 8050

ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
