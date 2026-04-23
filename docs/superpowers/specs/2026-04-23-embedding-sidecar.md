# Design: Embedding Sidecar (Python)

**Date:** 2026-04-23
**Status:** Approved
**Model:** google/embedding-gemma-300m

## Overview

A lightweight Python FastAPI sidecar that loads Google's EmbeddingGemma-300M and exposes a single `/embed` endpoint for batched text embedding. It is consumed exclusively by the `semantic_crawl` MCP tool in the TypeScript search-mcp server.

The sidecar handles **asymmetric prompt formatting internally** — callers pass `mode: "document" | "query"` and the sidecar maps it to the correct prefix template before tokenization. This keeps the TypeScript client agnostic of the model's specific prompt schema.

## Why a Separate Sidecar?

- EmbeddingGemma is a PyTorch model; running it in-process in Node.js would require ONNX conversion and lose bfloat16 support.
- The model weights are ~600MB; loading once at startup and serving via HTTP amortizes the cost across many requests.
- Isolation: a crash in the embedding model does not take down the MCP server.

## Architecture

```
┌─────────────────┐     HTTP POST /embed     ┌─────────────────────┐
│  search-mcp     │ ────────────────────────▶│  Python sidecar     │
│  (TypeScript)   │◀─────────────────────────│  (FastAPI + Gemma)  │
└─────────────────┘   JSON {embeddings: [...]}└─────────────────────┘
```

## Model Details

| Property           | Value                             |
| ------------------ | --------------------------------- |
| Model ID           | `google/embedding-gemma-300m`     |
| Parameters         | 300M                              |
| Context window     | 2048 tokens                       |
| Hidden size        | 768                               |
| MRL dimensions     | 128, 256, 512, 768                |
| Default output dim | **256**                           |
| License            | Gemma (requires HF click-through) |

### MRL Dimension Trade-offs (English MTEB)

| Dimension | MTEB Score | Relative Size |
| --------- | ---------- | ------------- |
| 768       | ~69.7      | 1x            |
| 512       | ~69.4      | 0.67x         |
| 256       | ~69.2      | 0.33x         |
| 128       | ~68.1      | 0.17x         |

256d is the recommended default: the quality loss vs. 768d is ~0.5 points, but vectors are 3x smaller and cosine similarity is meaningfully faster.

## Prompt Formatting (Internal)

The sidecar applies prefixes **before tokenization** based on `mode`. The TypeScript client does NOT send prefixed strings; it sends raw text and the sidecar handles formatting.

### Query mode

```
task: search result | query: {content}
```

**Optional enhancement:** if the query looks code-like (contains `{`, `}`, `;`, `(`, `)`, `=`, or matches `def |class |function |const |let |var |import |from |#include`), use:

```
task: code retrieval | query: {content}
```

### Document mode

```
title: {title | "none"} | text: {content}
```

The `title` field comes from the optional `titles` array in the request body. If a title is not provided for a given text, it defaults to `"none"`.

### Why this matters

EmbeddingGemma is asymmetrically fine-tuned: the model learns different representations for queries vs. documents. If the sidecar does not apply these prefixes, retrieval quality drops significantly (MTEB English can degrade by 5+ points).

## HTTP API Contract

### `POST /embed`

**Request body:**

```json
{
  "texts": ["chunk1 text", "chunk2 text", "..."],
  "titles": ["Section One", "Section Two"],
  "mode": "document",
  "dimensions": 256
}
```

- `texts` (required): Array of strings to embed. Max 512 per request.
- `titles` (optional): Array of strings, same length as `texts`. Used for document-mode prefixing. If omitted or shorter than `texts`, missing entries default to `"none"`.
- `mode` (required): `"document"` or `"query"`.
- `dimensions` (optional): One of `128`, `256`, `512`, `768`. Defaults to `256`.

**Response body:**

```json
{
  "embeddings": [[0.023, -0.041, 0.012, "..."]],
  "model": "google/embedding-gemma-300m",
  "modelRevision": "abc1234",
  "dimensions": 256,
  "mode": "document",
  "truncatedIndices": [2, 5]
}
```

- `embeddings`: **L2-normalized float32 vectors**. Callers can use dot product directly for cosine similarity.
- `truncatedIndices`: indices of texts that exceeded the 2048-token context window and were silently truncated.

**Error contract:**

| Status | Meaning                                               |
| ------ | ----------------------------------------------------- |
| `400`  | Invalid `mode`, `dimensions`, or non-array `texts`    |
| `503`  | Model not loaded yet. `Retry-After: <seconds>` header |
| `500`  | Internal error                                        |

### `GET /health`

```json
{
  "status": "ok",
  "modelLoaded": true,
  "model": "google/embedding-gemma-300m",
  "dimensions": 256,
  "torchDtype": "bfloat16"
}
```

Returns `503` with `"modelLoaded": false` while weights are loading.

**Float dtype validation:** The health response MUST include `torchDtype`. Valid values: `bfloat16`, `float32`. If the loaded model is in `float16`, the sidecar MUST fail fast at startup with a clear error:

```
CRITICAL: EmbeddingGemma activations do not support float16.
Set torch_dtype=torch.bfloat16 or torch_dtype=torch.float32.
```

### `GET /metrics`

Prometheus-style text for:

- `embedding_latency_seconds` (p50, p99)
- `embedding_requests_total`
- `embedding_truncated_total`

## Implementation Requirements

### 1. torch_dtype MUST be bfloat16 or float32

```python
# CORRECT
torch_dtype = torch.bfloat16

# WRONG — silently produces garbage embeddings
torch_dtype = torch.float16
```

Enforce at model load time:

```python
assert model.config.torch_dtype in (torch.float32, torch.bfloat16), (
    "CRITICAL: EmbeddingGemma activations do not support float16. "
    "Set torch_dtype=torch.bfloat16 or torch_dtype=torch.float32."
)
```

### 2. Authentication (HuggingFace)

The Gemma license requires accepting terms on HuggingFace before downloading weights. The sidecar CANNOT auto-download without authentication.

**Setup steps for operators:**

1. Create a HuggingFace account: https://huggingface.co/join
2. Accept the Gemma license: https://huggingface.co/google/embedding-gemma-300m
3. Generate a HuggingFace token: https://huggingface.co/settings/tokens
4. Run `huggingface-cli login` and paste the token
5. The sidecar will download weights on first start, or you can pre-download:
   ```bash
   huggingface-cli download google/embedding-gemma-300m
   ```

The sidecar uses `transformers.AutoModel.from_pretrained(...)` which respects the `HF_HOME` / `HF_TOKEN` environment variables.

### 3. Batching Strategy

- Max batch size: 512 texts per request (enforced at API layer).
- Internal batching: if the GPU memory cannot hold 512 at once, split into smaller sub-batches internally.
- No streaming: the entire response is materialized before sending.

### 4. MRL Truncation

The model outputs 768d by default. To return fewer dimensions, slice the output vector:

```python
if dimensions < 768:
    embeddings = embeddings[:, :dimensions]
```

Then L2-normalize the truncated vectors:

```python
embeddings = embeddings / embeddings.norm(dim=1, keepdim=True)
```

### 5. Startup Behavior

1. On container start, load the model and tokenizer.
2. While loading, `/health` returns `503` with `Retry-After: 10`.
3. Once loaded, `/health` returns `200` with `"modelLoaded": true`.
4. First embedding request may be slightly slower (CUDA warm-up).

## Docker Reference

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download model weights during build (requires HF_TOKEN build arg)
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN python -c "from transformers import AutoModel, AutoTokenizer; AutoModel.from_pretrained('google/embedding-gemma-300m'); AutoTokenizer.from_pretrained('google/embedding-gemma-300m')"

COPY main.py .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Build & run:**

```bash
export HF_TOKEN=hf_xxx
docker build --build-arg HF_TOKEN=$HF_TOKEN -t search-mcp-embedding-sidecar .
docker run -d -p 8000:8000 -e HF_TOKEN=$HF_TOKEN search-mcp-embedding-sidecar
```

**Verify:**

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/embed \
  -H "Content-Type: application/json" \
  -d '{"texts":["hello world"],"mode":"document","dimensions":256}'
```

## Future Work (out of scope for v1)

- Quantization: Q8_0 and Q4_0 support for CPU inference (EmbeddingGemma Q8_0 scores 69.49 MTEB English at 768d vs. 69.67 full precision — a 0.18 point loss for ~50% memory reduction).
- GPU memory-based dynamic batch sizing.
- Model caching / warm pool for multi-tenant deployments.
- Support for additional asymmetric models (e.g., E5-mistral, GTE-large).
