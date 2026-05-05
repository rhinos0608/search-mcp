# Sidecar Embedding Service
# Multi-stage build to minimize final image

# Stage 1: Builder with build dependencies
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build
COPY requirements.txt .
# Cache mount persists pip download cache across builds (faster rebuilds)
# Install CPU-only torch to avoid downloading 850MB of CUDA/cuDNN libs
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --user torch --index-url https://download.pytorch.org/whl/cpu && \
    grep -v "^torch" requirements.txt > req-nocuda.txt && \
    pip install --user -r req-nocuda.txt

# Stage 2: Runtime
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

COPY --from=builder /root/.local /app/.local
ENV PATH=/app/.local/bin:$PATH

ARG HF_TOKEN=""
ENV HF_TOKEN=${HF_TOKEN}
RUN if [ -n "$HF_TOKEN" ]; then \
        python -c "from transformers import AutoModel, AutoTokenizer; \
        AutoModel.from_pretrained('google/embedding-gemma-300m', token='$HF_TOKEN'); \
        AutoTokenizer.from_pretrained('google/embedding-gemma-300m', token='$HF_TOKEN')"; \
    fi

COPY main.py .

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

LABEL org.opencontainers.image.title="search-mcp-embedding-sidecar" \
      org.opencontainers.image.description="Text embedding inference service (EmbeddingGemma 300M)" \
      org.opencontainers.image.source="https://github.com/rhinesharar/search-mcp" \
      org.opencontainers.image.vendor="search-mcp" \
      org.opencontainers.image.ref.name="production"
