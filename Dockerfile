# Stage 1: Build TypeScript source
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package descriptors
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci || npm install

# Copy source and config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep runtime image minimal
RUN npm prune --production

# Stage 2: Minimal, secure production runtime
FROM node:20-alpine AS runner
WORKDIR /app

# Install curl for container health checks
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=3747
ENV HOST=0.0.0.0
ENV DUOSTACK_PROJECT_PATH=/project

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create project volume mount point and assign ownership
RUN mkdir -p /project/.duostack/state && chown -R node:node /app /project

# Run as non-root user
USER node

# Expose DuoStack API & Dashboard port
EXPOSE 3747

# Container healthcheck
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3747/health || exit 1

# Default command: start DuoStack server for /project
CMD ["node", "dist/cli/index.js", "serve", "--project", "/project", "--host", "0.0.0.0"]
