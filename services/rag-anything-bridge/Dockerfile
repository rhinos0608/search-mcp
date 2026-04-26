# RAG-Anything Bridge Service
# Multi-stage build for optimized production image

# Stage 1: Builder with build dependencies
FROM python:3.11-slim as builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

# Stage 2: Runtime — minimal image without build tools
FROM python:3.11-slim as runtime

# Install runtime system dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Document processing
    libreoffice \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-chi-sim \
    tesseract-ocr-chi-tra \
    tesseract-ocr-jpn \
    tesseract-ocr-kor \
    tesseract-ocr-fra \
    tesseract-ocr-deu \
    tesseract-ocr-spa \
    # Image processing
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    # Utilities (curl for health check)
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

# Copy Python packages from builder
COPY --from=builder /root/.local /home/appuser/.local

# Ensure local bin is in PATH for the non-root user
ENV PATH=/home/appuser/.local/bin:$PATH

# Copy application code
COPY src/ ./src/

# Create necessary directories and set ownership
RUN mkdir -p /cache/rag-anything /tmp/rag-anything && \
    chown -R appuser:appuser /app /cache/rag-anything /tmp/rag-anything /home/appuser/.local

# Expose port
EXPOSE 8000

# Run as non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the application
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

# Labels
LABEL maintainer="search-mcp-team" \
      version="1.0.0" \
      description="RAG-Anything Bridge Service for search-mcp"