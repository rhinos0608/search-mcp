# OpenAI-Compatible Embedding Proxy

Lightweight FastAPI proxy that translates `/embed` requests into calls against an OpenAI-compatible embedding server (e.g. LM Studio).

**Drop-in replacement** for the torch-based `sidecar/embedding/` — same `/embed` request/response contract, so the MCP server needs no changes.

## Architecture

```
search-mcp (TypeScript)  ──POST /embed──▶  Proxy (Python/FastAPI)
                                            │  formats asymmetric prompts
                                            │  ──POST /v1/embeddings──▶  LM Studio
                                            ◀── {data: [{embedding: [...]}]} ──
                         ◀── JSON ────────  │  MRL truncation + L2 norm
```

## Prerequisites

1. **LM Studio** (or any OpenAI-compatible embedding server)
   - Download from https://lmstudio.ai
   - Load the embedding model (e.g. `unsloth/embeddinggemma-300m-GGUF`)
   - Start the local server (default: `http://localhost:1234`)

2. **Python 3.11+**

## Quick Start

```bash
cd sidecar/openai-embedding-proxy
pip install -r requirements.txt

export OPENAI_BASE_URL=http://localhost:1234
export EMBEDDING_MODEL=embeddinggemma-300m

python main.py
```

Verify:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/embed \
  -H "Content-Type: application/json" \
  -d '{"texts":["hello world"],"mode":"document","dimensions":256}'
```

`/health` checks both LM Studio's OpenAI-compatible `/v1/models` endpoint and its REST `/api/v1/models` listing, so it will recognize LM Studio embedding model aliases like `text-embedding-embeddinggemma-300m`.

## Docker

```bash
docker build -t search-mcp-openai-embedding-proxy .
docker run -d -p 8000:8000 \
  -e OPENAI_BASE_URL=http://host.docker.internal:1234 \
  -e EMBEDDING_MODEL=embeddinggemma-300m \
  search-mcp-openai-embedding-proxy
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BASE_URL` | `http://localhost:1234` | Base URL of the OpenAI-compatible server |
| `EMBEDDING_MODEL` | `embeddinggemma-300m` | Model name as registered in the upstream server |
| `EMBEDDING_DEFAULT_DIMENSIONS` | `256` | Default MRL output dimension |
| `EMBEDDING_MAX_BATCH` | `512` | Max texts per request |
| `EMBEDDING_REQUEST_TIMEOUT` | `120` | Timeout in seconds for upstream calls |

## Integration with search-mcp

Same config as the original sidecar — just point at this proxy instead:

```bash
export EMBEDDING_SIDECAR_BASE_URL=http://localhost:8000
export EMBEDDING_SIDECAR_API_TOKEN=""
export EMBEDDING_DIMENSIONS=256
```

## When to use this vs. the torch sidecar

| | `sidecar/embedding/` | `sidecar/openai-embedding-proxy/` |
|---|---|---|
| Loads model directly | Yes (PyTorch + transformers) | No — proxies to LM Studio |
| GPU required | Recommended | Handled by LM Studio |
| Model format | HuggingFace safetensors | GGUF (quantized) |
| Dependencies | ~5 GB (torch) | ~50 MB (fastapi + httpx) |
| Setup | Needs HF token + Gemma license | Load model in LM Studio UI |
