# Multi-stage Node.js build for search-mcp
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# Stage 2: Production
FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install production dependencies only in a separate step
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --omit=dev

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Strip source maps and declarations from production image (saves ~30% on dist size)
RUN rm -f dist/*.map dist/*.d.ts dist/*.d.ts.map

# Switch to non-root user
USER appuser

EXPOSE 8050

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="search-mcp" \
      org.opencontainers.image.description="MCP server for web search, crawl, semantic RAG, and research" \
      org.opencontainers.image.source="https://github.com/rhinesharar/search-mcp" \
      org.opencontainers.image.vendor="search-mcp" \
      org.opencontainers.image.ref.name="production"
