# Embedding Sidecar for search-mcp
# Loads google/embedding-gemma-300m and exposes /embed for batched asymmetric embedding.

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator
from transformers import AutoModel, AutoTokenizer

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("embedding-sidecar")

# ── Config ───────────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "google/embedding-gemma-300m")
DEFAULT_DIMS = int(os.getenv("EMBEDDING_DEFAULT_DIMENSIONS", "256"))
MAX_BATCH = int(os.getenv("EMBEDDING_MAX_BATCH", "512"))
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# ── Global state (populated during lifespan) ─────────────────────────────────

model: AutoModel | None = None
tokenizer: AutoTokenizer | None = None
model_revision: str = "unknown"
loaded_dtype: str = "unknown"

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
    code_indicators = ["{", "}", ";", "(", ")", "=", "def ", "class ", "function ",
                       "const ", "let ", "var ", "import ", "from ", "#include"]
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
    # document mode
    if titles is None:
        titles = ["none"] * len(texts)
    return [_format_document(t, title=ti) for t, ti in zip(texts, titles)]


# ── Model loading ──────────────────────────────────────────────────────────────

def load_model() -> tuple[AutoModel, AutoTokenizer, str, str]:
    logger.info("Loading model %s on %s …", MODEL_NAME, DEVICE)
    start = time.monotonic()

    tok = AutoTokenizer.from_pretrained(MODEL_NAME)
    mdl = AutoModel.from_pretrained(
        MODEL_NAME,
        torch_dtype=torch.bfloat16,
        device_map="auto" if DEVICE.type == "cuda" else None,
    )

    # Sanity check: float16 is forbidden
    actual_dtype = str(mdl.config.torch_dtype)
    if "float16" in actual_dtype and "bfloat16" not in actual_dtype:
        raise RuntimeError(
            "CRITICAL: EmbeddingGemma activations do not support float16. "
            "Set torch_dtype=torch.bfloat16 or torch_dtype=torch.float32."
        )

    if DEVICE.type == "cpu":
        mdl = mdl.to(DEVICE)

    revision = getattr(mdl.config, "_commit_hash", "unknown")[:7]
    elapsed = time.monotonic() - start
    logger.info(
        "Model loaded in %.1fs (dtype=%s, revision=%s)", elapsed, actual_dtype, revision
    )
    return mdl, tok, revision, actual_dtype


# ── Embedding logic ──────────────────────────────────────────────────────────

@torch.inference_mode()
def embed(texts: list[str], dimensions: int) -> tuple[torch.Tensor, list[int]]:
    assert model is not None and tokenizer is not None

    inputs = tokenizer(
        texts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=2048,
    )
    inputs = {k: v.to(DEVICE) for k, v in inputs.items()}

    # Track which inputs were truncated
    truncated: list[int] = []
    for i, inp_ids in enumerate(inputs["input_ids"]):
        # Find the last non-pad token position
        seq_len = (inp_ids != tokenizer.pad_token_id).sum().item()
        if seq_len >= 2048:
            truncated.append(i)

    outputs = model(**inputs)
    # Gemma outputs last_hidden_state; pool by taking the last non-pad token
    embeddings = outputs.last_hidden_state
    mask = inputs["attention_mask"].unsqueeze(-1).expand(embeddings.size()).float()
    masked = embeddings * mask
    summed = masked.sum(dim=1)
    counts = mask.sum(dim=1).clamp(min=1)
    pooled = summed / counts

    # MRL truncation + L2 normalization
    if dimensions < 768:
        pooled = pooled[:, :dimensions]
    pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)

    return pooled.cpu(), truncated


# ── FastAPI app ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, tokenizer, model_revision, loaded_dtype
    try:
        model, tokenizer, model_revision, loaded_dtype = load_model()
    except Exception as exc:
        logger.exception("Model load failed")
        # Keep running so /health can report the failure; /embed will 503
        model = None
        tokenizer = None
        raise exc
    yield
    logger.info("Shutting down")


app = FastAPI(title="search-mcp Embedding Sidecar", lifespan=lifespan)


@app.exception_handler(ValueError)
async def _value_error_handler(_req: Request, exc: ValueError):
    raise HTTPException(status_code=400, detail=str(exc))


@app.get("/health")
def health():
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded",
            headers={"Retry-After": "10"},
        )
    return {
        "status": "ok",
        "modelLoaded": True,
        "model": MODEL_NAME,
        "dimensions": DEFAULT_DIMS,
        "torchDtype": loaded_dtype,
    }


@app.get("/metrics")
def metrics():
    # Minimal Prometheus-compatible exposition
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
def embed_endpoint(req: EmbedRequest):
    if model is None or tokenizer is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded yet",
            headers={"Retry-After": "10"},
        )

    start = time.monotonic()
    formatted = format_texts(req.texts, req.titles, req.mode)
    vecs, truncated = embed(formatted, req.dimensions)
    latency = time.monotonic() - start

    logger.info(
        "embed batch=%d mode=%s dims=%d latency=%.3fs truncated=%s",
        len(req.texts),
        req.mode,
        req.dimensions,
        latency,
        truncated,
    )

    return EmbedResponse(
        embeddings=vecs.tolist(),
        model=MODEL_NAME,
        modelRevision=model_revision,
        dimensions=req.dimensions,
        mode=req.mode,
        truncatedIndices=truncated,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
