# Embedding Sidecar

Lightweight Python FastAPI service that loads Google's EmbeddingGemma-300M and exposes a single `/embed` endpoint for batched asymmetric embedding.

## Prerequisites

1. **HuggingFace account and token**
   - Create an account at https://huggingface.co/join
   - Accept the Gemma license at https://huggingface.co/google/embedding-gemma-300m
   - Generate a token at https://huggingface.co/settings/tokens

2. **Authenticate locally**
   ```bash
   pip install huggingface-hub
   huggingface-cli login
   # Paste your token when prompted
   ```

## Quick Start (local)

```bash
cd sidecar/embedding
pip install -r requirements.txt
python main.py
```

Verify:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/embed \
  -H "Content-Type: application/json" \
  -d '{"texts":["hello world"],"mode":"document","dimensions":256}'
```

## Docker

```bash
export HF_TOKEN=hf_your_token_here
docker build --build-arg HF_TOKEN=$HF_TOKEN -t search-mcp-embedding-sidecar .
docker run -d -p 8000:8000 -e HF_TOKEN=$HF_TOKEN search-mcp-embedding-sidecar
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `google/embedding-gemma-300m` | Model ID on HuggingFace |
| `EMBEDDING_DEFAULT_DIMENSIONS` | `256` | Default MRL output dimension |
| `EMBEDDING_MAX_BATCH` | `512` | Max texts per request |
| `HF_TOKEN` | — | HuggingFace token for downloading weights |

## API Endpoints

- `POST /embed` — Embed batched texts with asymmetric prompt formatting
- `GET /health` — Model load status and dtype validation
- `GET /metrics` — Prometheus-style metrics

## Important: Float16 Is Forbidden

EmbeddingGemma activations do not support `float16`. The sidecar loads with `torch_dtype=torch.bfloat16`. If your hardware or framework defaults to `float16`, the sidecar fails fast at startup with a clear error.

## Integration with search-mcp

Configure the MCP server:

```bash
export EMBEDDING_SIDECAR_BASE_URL=http://localhost:8000
export EMBEDDING_SIDECAR_API_TOKEN=""  # optional, if sidecar requires auth
export EMBEDDING_DIMENSIONS=256
```
