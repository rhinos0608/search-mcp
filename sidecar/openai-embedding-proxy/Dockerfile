# OpenAI-compatible Embedding Proxy

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

COPY requirements.txt .
# Cache mount persists pip download cache across builds (faster rebuilds)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY main.py .

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import sys,urllib.request as u; r=u.urlopen('http://localhost:8003/health'); sys.exit(0 if r.getcode()==200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]

LABEL org.opencontainers.image.title="search-mcp-openai-embedding-proxy" \
      org.opencontainers.image.description="OpenAI-compatible embedding API proxy" \
      org.opencontainers.image.source="https://github.com/rhinesharar/search-mcp" \
      org.opencontainers.image.vendor="search-mcp" \
      org.opencontainers.image.ref.name="production"
