# =============================================================================
# Bliv Hørt AI - Dockerfile (multi-stage build)
# =============================================================================
# Stage 1: Builder - compile native modules and install dependencies
# Stage 2: Runtime - minimal production image
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

# Install build dependencies for native Node.js modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY analysis-pipeline/package*.json ./analysis-pipeline/

# Force rebuild of native modules and skip Puppeteer download
ENV npm_config_build_from_source=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Node.js dependencies
RUN npm ci --no-audit --no-fund
RUN cd analysis-pipeline && npm ci --no-audit --no-fund

# Install Python dependencies for PDF conversion
COPY requirements.txt ./
RUN mkdir -p python_packages && \
    python3 -m pip install --no-cache-dir --break-system-packages setuptools==70.0.0 packaging wheel && \
    python3 -m pip install --no-cache-dir --break-system-packages --prefer-binary --target python_packages -r requirements.txt

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    libatomic1 \
    pandoc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/analysis-pipeline/node_modules ./analysis-pipeline/node_modules
COPY --from=builder /app/python_packages ./python_packages

# Copy application source
COPY . .

# Create necessary directories
RUN mkdir -p data uploads tmp analysis-pipeline/output/runs

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/hearings.db
ENV PYTHONPATH=/app/python_packages
ENV PYTHON_BIN=python3

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "server.js"]
