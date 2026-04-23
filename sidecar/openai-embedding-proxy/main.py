# OpenAI-Compatible Embedding Proxy for search-mcp
# Proxies /embed requests to an OpenAI-compatible server (e.g. LM Studio).
# Same request/response contract as the torch-based sidecar — drop-in replacement.

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, field_validator

from health_utils import (
    is_embedding_model_available,
    list_lmstudio_embedding_model_ids,
)

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("openai-embedding-proxy")

# ── Config ───────────────────────────────────────────────────────────────────

OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://localhost:1234").rstrip("/")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "embeddinggemma-300m")
DEFAULT_DIMS = int(os.getenv("EMBEDDING_DEFAULT_DIMENSIONS", "256"))
MAX_BATCH = int(os.getenv("EMBEDDING_MAX_BATCH", "512"))
REQUEST_TIMEOUT = float(os.getenv("EMBEDDING_REQUEST_TIMEOUT", "120"))

# ── Global state ─────────────────────────────────────────────────────────────

http_client: httpx.AsyncClient | None = None
model_available: bool = False
model_error: str | None = None

# ── Request / Response schemas ───────────────────────────────────────────────


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_BATCH)
    titles: list[str] | None = None
    mode: Literal["document", "query"] = "document"
    dimensions: int = DEFAULT_DIMS

    @field_validator("dimensions")
    @classmethod
    def _check_dimensions(cls, v: int) -> int:
        if v not in {128, 256, 512, 768}:
            raise ValueError("dimensions must be one of 128, 256, 512, 768")
        return v

    @field_validator("titles")
    @classmethod
    def _check_titles(cls, v: list[str] | None, info) -> list[str] | None:
        texts = info.data.get("texts", [])
        if v is not None and len(v) != len(texts):
            raise ValueError("titles must have the same length as texts")
        return v


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    modelRevision: str
    dimensions: int
    mode: str
    truncatedIndices: list[int]


# ── Prompt formatting (asymmetric) ───────────────────────────────────────────


def _is_code_like(text: str) -> bool:
    """Heuristic: does the query look like code?"""
    code_indicators = [
        "{", "}", ";", "(", ")", "=", "def ", "class ", "function ",
        "const ", "let ", "var ", "import ", "from ", "#include",
    ]
    lowered = text.lower()
    return any(ind in text or lowered.startswith(ind.strip()) for ind in code_indicators)


def _format_query(text: str) -> str:
    task = "code retrieval" if _is_code_like(text) else "search result"
    return f"task: {task} | query: {text}"


def _format_document(text: str, title: str = "none") -> str:
    return f"title: {title} | text: {text}"


def format_texts(texts: list[str], titles: list[str] | None, mode: str) -> list[str]:
    if mode == "query":
        return [_format_query(t) for t in texts]
    if titles is None:
        titles = ["none"] * len(texts)
    return [_format_document(t, title=ti) for t, ti in zip(texts, titles)]


# ── OpenAI-compatible embedding call ────────────────────────────────────────


async def call_openai_embed(
    formatted_texts: list[str],
    dimensions: int,
) -> list[list[float]]:
    """Call /v1/embeddings and return L2-normalized float vectors."""
    assert http_client is not None

    payload = {
        "model": EMBEDDING_MODEL,
        "input": formatted_texts,
    }

    resp = await http_client.post(
        f"{OPENAI_BASE_URL}/v1/embeddings",
        json=payload,
        timeout=REQUEST_TIMEOUT,
    )

    if resp.status_code != 200:
        detail = resp.text[:500]
        raise HTTPException(
            status_code=502,
            detail=f"Upstream returned {resp.status_code}: {detail}",
        )

    body = resp.json()
    data = body.get("data")
    if not isinstance(data, list):
        raise HTTPException(status_code=502, detail="Upstream response missing 'data' array")

    embeddings: list[list[float]] = []
    for item in data:
        vec = item.get("embedding")
        if not isinstance(vec, list):
            raise HTTPException(status_code=502, detail="Upstream response item missing 'embedding'")
        # MRL truncation
        if dimensions < len(vec):
            vec = vec[:dimensions]
        # L2 normalization
        norm = sum(x * x for x in vec) ** 0.5
        if norm > 0:
            vec = [x / norm for x in vec]
        embeddings.append(vec)

    return embeddings


# ── Health probe ────────────────────────────────────────────────────────────


async def check_upstream() -> bool:
    """Check whether the configured embedding model is available upstream."""
    global model_available, model_error
    assert http_client is not None

    openai_model_ids: list[str] = []
    lmstudio_models: list[dict[str, object]] = []
    openai_error: str | None = None
    lmstudio_error: str | None = None

    try:
        resp = await http_client.get(
            f"{OPENAI_BASE_URL}/v1/models",
            timeout=5.0,
        )
        if resp.status_code == 200:
            body = resp.json()
            if isinstance(body, dict):
                data = body.get("data", [])
                if isinstance(data, list):
                    openai_model_ids = [
                        m.get("id", "")
                        for m in data
                        if isinstance(m, dict) and isinstance(m.get("id"), str)
                    ]
                else:
                    openai_error = "OpenAI-compatible /v1/models returned an unexpected shape"
            else:
                openai_error = "OpenAI-compatible /v1/models returned an unexpected payload"
        else:
            openai_error = f"Upstream /v1/models returned {resp.status_code}"
    except Exception as exc:
        openai_error = f"Cannot reach upstream /v1/models at {OPENAI_BASE_URL}: {exc}"

    try:
        resp = await http_client.get(
            f"{OPENAI_BASE_URL}/api/v1/models",
            timeout=5.0,
        )
        if resp.status_code == 200:
            body = resp.json()
            if isinstance(body, dict):
                models = body.get("models", [])
                if isinstance(models, list):
                    lmstudio_models = [m for m in models if isinstance(m, dict)]
                else:
                    lmstudio_error = "LM Studio /api/v1/models returned an unexpected shape"
            else:
                lmstudio_error = "LM Studio /api/v1/models returned an unexpected payload"
        else:
            lmstudio_error = f"LM Studio /api/v1/models returned {resp.status_code}"
    except Exception as exc:
        lmstudio_error = f"Cannot reach LM Studio REST API at {OPENAI_BASE_URL}: {exc}"

    if is_embedding_model_available(EMBEDDING_MODEL, openai_model_ids, lmstudio_models):
        model_available = True
        model_error = None
        return True

    model_available = False
    openai_models_text = ", ".join(openai_model_ids) if openai_model_ids else "none"
    lmstudio_embedding_model_ids = list_lmstudio_embedding_model_ids(lmstudio_models)
    lmstudio_models_text = (
        ", ".join(lmstudio_embedding_model_ids)
        if lmstudio_embedding_model_ids
        else "none"
    )
    model_error = (
        f"Model '{EMBEDDING_MODEL}' not available. "
        f"OpenAI /v1/models: {openai_models_text}. "
        f"LM Studio /api/v1/models embedding models: {lmstudio_models_text}."
    )
    if openai_error is not None or lmstudio_error is not None:
        details = "; ".join(
            part for part in [openai_error, lmstudio_error] if part is not None
        )
        if details:
            model_error = f"{model_error} Details: {details}"
    logger.warning(model_error)
    return False


# ── FastAPI app ──────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient()
    logger.info(
        "Proxy ready — forwarding to %s with model %s",
        OPENAI_BASE_URL,
        EMBEDDING_MODEL,
    )
    await check_upstream()
    yield
    await http_client.aclose()
    logger.info("Shutting down")


app = FastAPI(title="search-mcp OpenAI Embedding Proxy", lifespan=lifespan)


@app.exception_handler(ValueError)
async def _value_error_handler(_req: Request, exc: ValueError):
    raise HTTPException(status_code=400, detail=str(exc))


@app.get("/health")
async def health():
    await check_upstream()
    if not model_available:
        raise HTTPException(
            status_code=503,
            detail=model_error or "Model not available",
            headers={"Retry-After": "10"},
        )
    return {
        "status": "ok",
        "modelLoaded": True,
        "model": EMBEDDING_MODEL,
        "dimensions": DEFAULT_DIMS,
        "upstream": OPENAI_BASE_URL,
    }


@app.get("/metrics")
def metrics():
    lines = [
        "# HELP embedding_requests_total Total embedding requests",
        "# TYPE embedding_requests_total counter",
        'embedding_requests_total{status="ok"} 0',
        "",
        "# HELP embedding_latency_seconds Embedding latency",
        "# TYPE embedding_latency_seconds summary",
        'embedding_latency_seconds{quantile="0.5"} 0',
        'embedding_latency_seconds{quantile="0.99"} 0',
    ]
    return PlainTextResponse("\n".join(lines))


@app.post("/embed", response_model=EmbedResponse)
async def embed_endpoint(req: EmbedRequest):
    if http_client is None:
        raise HTTPException(status_code=503, detail="Proxy not ready")

    start = time.monotonic()
    formatted = format_texts(req.texts, req.titles, req.mode)
    embeddings = await call_openai_embed(formatted, req.dimensions)
    latency = time.monotonic() - start

    logger.info(
        "embed batch=%d mode=%s dims=%d latency=%.3fs",
        len(req.texts),
        req.mode,
        req.dimensions,
        latency,
    )

    return EmbedResponse(
        embeddings=embeddings,
        model=EMBEDDING_MODEL,
        modelRevision="openai-compat",
        dimensions=req.dimensions,
        mode=req.mode,
        truncatedIndices=[],
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)
