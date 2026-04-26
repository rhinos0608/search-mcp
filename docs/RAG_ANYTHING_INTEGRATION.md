# RAG-Anything Integration for search-mcp

## Overview

This document describes the RAG-Anything integration for search-mcp, providing multimodal document extraction capabilities for complex documents including PDFs, Office documents, scanned documents, and content with tables, equations, and images.

## Version

**Version:** 3.1.5  
**Status:** Production Ready  
**Last Updated:** 2026-04-26

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      search-mcp TypeScript                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Web Crawl   │  │   Quality    │  │   RAGA Escalation  │  │
│  │   (Crawl4AI) │  │   Detector   │  │   Logic            │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬─────────┘  │
└─────────┼──────────────────┼─────────────────────┼────────────┘
          │                  │                      │
          └──────────────────┼──────────────────────┘
                             │ HTTP/JSON API
          ┌──────────────────▼──────────────────────┐
          │     RAG-Anything Bridge (Python)      │
          │  ┌──────────────┐  ┌──────────────┐  │
          │  │   Docling    │  │  PaddleOCR   │  │
          │  │   Parser     │  │   Parser     │  │
          │  └──────────────┘  └──────────────┘  │
          │  ┌──────────────┐  ┌──────────────┐  │
          │  │   Cache      │  │   Storage    │  │
          │  │   Manager    │  │   Manager    │  │
          │  └──────────────┘  └──────────────┘  │
          └────────────────────────────────────────┘
```

### Data Flow

1. **Crawl4AI Extraction**: Primary extraction via Crawl4AI for normal web pages
2. **Quality Detection**: Analyze extraction quality using configurable thresholds
3. **Escalation Decision**: Route to RAG-Anything based on content type and quality
4. **Parser Selection**: Auto-select optimal parser (Docling, PaddleOCR, MinerU)
5. **Content Processing**: Structure and normalize extracted content
6. **Caching**: Store results for future requests

### Python Bridge Service

The Python Bridge Service is a FastAPI/HTTP or gRPC bridge that connects Search-MCP to RAG-Anything parsers (Docling, PaddleOCR, MinerU).

#### Security and Authentication

Authentication between Search-MCP and the Python Bridge Service must be configured for all non-local deployments:

- **Mutual TLS (mTLS)**: Recommended for service-to-service communication. Terminate mTLS at the ingress/load balancer and validate client certificates.
- **JWT / API Key validation**: Pass a shared secret via the `X-API-Key` header or a Bearer JWT token. The bridge validates tokens against configured allowed keys.
- **Token Rotation**: Rotate API keys every 90 days. The bridge supports grace-period rotation by accepting multiple active keys during a transition window.

#### Network Topology

| Topology          | Transport                    | Recommended For                         |
| ----------------- | ---------------------------- | --------------------------------------- |
| Local (stdio/IPC) | stdin/stdout pipes           | Development, single-machine deployments |
| Local (HTTP)      | `http://localhost:PORT`      | Same-host, container-to-container       |
| Remote (HTTPS)    | `https://bridge.example.com` | Production, multi-host                  |
| Remote (gRPC)     | gRPC over TLS                | High-throughput, streaming extraction   |

Default: `http://localhost:8000` for local development. Production must switch to HTTPS with authentication.

#### Secure API Key Management

- Never commit `config.json`, `config.enc`, or API keys to version control.
- Inject secrets via environment variables at runtime (e.g., `RAGA_API_KEYS`, `RAGA_OAUTH_CLIENT_SECRET`).
- For production, use a secrets manager (HashiCorp Vault, AWS Secrets Manager, Kubernetes Secrets) rather than environment variables where possible.
- Log redaction: the bridge automatically redacts `authorization`, `x-api-key`, and `cookie` headers from access logs.

#### Deployment Models

| Model                 | Description                                                                          | Health Checks                                 |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| **Containerized**     | Docker/Kubernetes with health endpoints (`GET /health`). Recommended for production. | Liveness + readiness probes on `/health`      |
| **Serverless**        | AWS Lambda, Google Cloud Functions, or similar. Requires cold-start optimization.    | Cloud provider health checks                  |
| **Always-on Service** | Systemd/launchd managed process. Suitable for single-server deployments.             | Process supervisor + periodic `/health` calls |

**CI/CD best practices**:

1. Run integration tests against the bridge in CI before deployment.
2. Automate secret rotation as part of the release pipeline.
3. Use canary or blue/green deployments for zero-downtime updates.
4. Scan container images for vulnerabilities before pushing to registries.

## Configuration

### Environment Variables

| Variable              | Default                 | Description                                       |
| --------------------- | ----------------------- | ------------------------------------------------- |
| `RAGA_ENABLED`        | `false`                 | Enable RAG-Anything integration                   |
| `RAGA_BRIDGE_URL`     | `http://localhost:8000` | Bridge service URL                                |
| `RAGA_TIMEOUT_MS`     | `30000`                 | Request timeout in milliseconds                   |
| `RAGA_MAX_RETRIES`    | `2`                     | Maximum retry attempts                            |
| `RAGA_CACHE_ENABLED`  | `true`                  | Enable result caching                             |
| `RAGA_DEFAULT_PARSER` | `auto`                  | Default parser (auto, docling, paddleocr, mineru) |

### Sync Limits

| Variable                | Default | Description                       |
| ----------------------- | ------- | --------------------------------- |
| `RAGA_SYNC_MAX_PAGES`   | `30`    | Max pages for sync extraction     |
| `RAGA_SYNC_MAX_SIZE_MB` | `20`    | Max file size for sync extraction |
| `RAGA_SYNC_TIMEOUT_SEC` | `30`    | Sync timeout in seconds           |

### Async Limits

| Variable                 | Default | Description                        |
| ------------------------ | ------- | ---------------------------------- |
| `RAGA_ASYNC_MAX_PAGES`   | `200`   | Max pages for async extraction     |
| `RAGA_ASYNC_MAX_SIZE_MB` | `100`   | Max file size for async extraction |
| `RAGA_ASYNC_TIMEOUT_MIN` | `5`     | Async timeout in minutes           |

### Quality Thresholds

| Variable                       | Default | Description                |
| ------------------------------ | ------- | -------------------------- |
| `RAGA_QUALITY_MIN_TEXT`        | `500`   | Minimum text length        |
| `RAGA_QUALITY_MIN_RATIO`       | `0.1`   | Minimum text to HTML ratio |
| `RAGA_QUALITY_MAX_BOILERPLATE` | `0.7`   | Maximum boilerplate ratio  |

### Security and Authentication

> **Production deployments must secure the RAG-Anything Bridge endpoint.**

#### Supported Authentication Mechanisms

The bridge supports multiple authentication layers:

- **API Keys**: Pass a client API key via the `X-API-Key` header. Configure allowed keys via the `RAGA_API_KEYS` environment variable (comma-separated list).
- **OAuth 2.0 / OIDC**: Enable via `RAGA_OAUTH_ISSUER` and `RAGA_OAUTH_AUDIENCE`. The bridge validates JWT `access_token` Bearer headers against the configured issuer.
- **mTLS (Mutual TLS)**: For internal/service-to-service communication, terminate mTLS at the ingress/load balancer and forward a trusted client certificate header (e.g., `X-Client-Cert-DN`) for authorization decisions.

#### Authorization and Access Control

- **Role-Based Access Control (RBAC)**: API keys can be prefixed with roles (`admin:<key>`, `read:<key>`). Admins can trigger `/extract`, `/parse`, and health endpoints. Read-only keys can access `/extract/{id}/result` and `/health`.
- **CORS**: In production, set `RAGA_CORS_ORIGINS` to an explicit allow-list (e.g., `https://app.example.com`) instead of `*`.
- **Network Controls**: Place the bridge behind an ingress (NGINX, Traefik, AWS ALB, Cloudflare) that enforces IP allow-lists, rate-limiting, and DDoS protection.

#### TLS / HTTPS

- **Require TLS in production.** `RAGA_BRIDGE_URL` must be an `https://` URL (e.g., `https://raga.example.com`).
- Do not send credentials over plain HTTP outside of local development.
- Rotate TLS certificates automatically via your ingress or cert-manager.

#### Security Best Practices

1. **Secure Storage of Keys**: Store `RAGA_API_KEYS`, `RAGA_OAUTH_CLIENT_SECRET`, and any database credentials in a secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager, Kubernetes Secrets) — never commit them to version control.
2. **Key Rotation**: Rotate API keys every 90 days. The bridge supports graceful rotation by accepting multiple active keys during a transition window.
3. **Minimal Privilege**: Run the bridge container as a non-root user (already configured in the `runtime` Dockerfile stage). Drop all Linux capabilities except those required.
4. **Request Limits**: Enforce `max_sync_size_mb`, `max_sync_pages`, and request timeouts to prevent resource exhaustion.
5. **Logging**: The bridge logs to stderr with structured JSON. Redact sensitive headers (`authorization`, `x-api-key`, `cookie`) from access logs.
6. **Ingress Hardening**: Use a Web Application Firewall (WAF) rule set to block known attack patterns, restrict uploaded file types, and scan uploads for malware when possible.

> **Quick-start for local development**: set `RAGA_ENABLED=true` and `RAGA_BRIDGE_URL=http://localhost:8000`. For production, switch to `RAGA_BRIDGE_URL=https://...` and configure authentication as described above.

## Resilience

### Retry Logic

Retried extraction operations must be **idempotent** — design extractors so re-running the same extraction produces the same result. This prevents data duplication and inconsistent state on retry.

- **Unique Request ID**: Attach a unique request ID (UUID) to every extraction request via the `X-Request-Id` header. The bridge uses this ID for request deduplication — if a retry arrives with the same ID, it returns the cached result instead of reprocessing.
- **State Tracking**: Record extraction attempts with timestamps and status in the bridge's state store. Abort after `RAGA_MAX_RETRIES` (default: 2) consecutive failures to avoid infinite retry loops.
- **Retry Policy**: Use exponential backoff with jitter for transient failures (network errors, 429 rate limits). Base delay: 1s, max delay: 30s. Non-idempotent or 4xx client errors should not be retried.

### Rate Limiting

- **Python Bridge**: Enforce a per-tenant request rate limit at the bridge ingress (NGINX `limit_req`, Traefik rate limiting middleware, or cloud WAF rate limit rules). Recommended: 100 requests/minute per tenant for sync, 10 requests/minute for async.
- **External APIs**: All outbound calls from the bridge (Document AI parsers, OCR services) must respect the target service's rate limits. Use a token-bucket or leaky-bucket strategy to throttle outgoing calls.
- **Quota Management**: Track usage per user/tenant and enforce configurable quotas. Return `429 Too Many Requests` with a `Retry-After` header when quotas are exhausted.

### Circuit Breakers

Prevent cascade failures by wrapping bridge calls with a circuit breaker pattern:

- **Closed**: Normal operation. Requests pass through.
- **Open**: After `RAGA_MAX_RETRIES` consecutive failures, the circuit opens and all requests fail fast for a cooldown period (default: 30s).
- **Half-Open**: After the cooldown, a single probe request is allowed. If it succeeds, the circuit closes; if it fails, it opens again.

### Timeouts and Cancellation

- All HTTP requests between Search-MCP and the Python Bridge must respect a configurable timeout (`RAGA_TIMEOUT_MS`, default: 30s).
- The bridge must cancel in-flight extraction work when the client disconnects or the timeout fires, releasing parser resources.
- Use `AbortController` in the TypeScript client and `asyncio.timeout` / `asyncio.CancelledError` in the Python bridge to propagate cancellation.

## API Reference

### TypeScript Client

```typescript
import {
  ragaClient,
  extractWithRAGA,
  type ExtractionOptions,
  type ExtractionResult,
  type ImageAsset,
  type TableAsset,
} from './utils/ragAnythingClient';

const EXTRACTION_TIMEOUT_MS = 30_000;
const MAX_HTML_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

class RAGAnythingAdapter {
  /**
   * Extract structured content from HTML with error handling, input validation,
   * and a configurable timeout for the Python bridge call.
   */
  async extractFromHTML(
    html: string,
    url: string,
    options?: ExtractionOptions,
  ): Promise<ExtractionResult> {
    // Input validation
    if (!html || html.trim().length === 0) {
      throw new Error('extractFromHTML: html input is empty');
    }
    if (!url || url.trim().length === 0) {
      throw new Error('extractFromHTML: url input is empty');
    }
    if (html.length > MAX_HTML_SIZE_BYTES) {
      throw new Error(
        `extractFromHTML: html payload exceeds maximum size (${String(html.length)} > ${String(MAX_HTML_SIZE_BYTES)} bytes)`,
      );
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      throw new Error(`extractFromHTML: invalid url "${url}"`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, options?.timeoutMs ?? EXTRACTION_TIMEOUT_MS);

    try {
      // 1. Save HTML to temp file
      // 2. Call RAG-Anything parser via Python bridge
      const result = await ragaClient.extract(
        {
          url,
          parser: options?.parser ?? 'auto',
          extractTables: options?.extractTables ?? true,
          extractImages: options?.extractImages ?? false,
          extractEquations: options?.extractEquations ?? true,
          maxPages: options?.maxPages ?? 50,
        },
        { signal: controller.signal },
      );

      // Validate/normalize the result before returning
      return {
        markdown: result.markdown ?? '',
        metadata: result.metadata ?? {},
        images: (result.images ?? []) as ImageAsset[],
        tables: (result.tables ?? []) as TableAsset[],
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `extractFromHTML: extraction timed out after ${String(options?.timeoutMs ?? EXTRACTION_TIMEOUT_MS)}ms`,
        );
      }
      throw new Error(
        `extractFromHTML: extraction failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

### Convenience Functions

```typescript
import { extractWithRAGA } from './utils/ragAnythingClient';

// Quick extraction with defaults
const result = await extractWithRAGA('https://example.com/document.pdf', {
  parser: 'docling',
  extractTables: true,
});
```

### Python Bridge API

#### POST /extract

Extract content from a URL.

**Request Body:**

```json
{
  "url": "https://example.com/document.pdf",
  "content_type": "application/pdf",
  "parser": "auto",
  "extract_tables": true,
  "extract_images": false,
  "extract_equations": true,
  "ocr_language": "eng",
  "max_pages": 50,
  "sync_timeout": 30
}
```

**Response:**

```json
{
  "document_id": "abc123...",
  "source_url": "https://example.com/document.pdf",
  "source_type": "application/pdf",
  "parser_used": "docling",
  "parser_version": "1.0.0",
  "markdown": "# Document Title\n\nContent...",
  "title": "Document Title",
  "content_items": [
    {
      "item_id": "item-001",
      "type": "heading",
      "text": "Introduction",
      "markdown": "# Introduction",
      "page_number": 1,
      "metadata": { "level": 1 }
    }
  ],
  "assets": [],
  "processing_time_ms": 2500,
  "cached": false,
  "created_at": "2026-04-26T12:00:00Z"
}
```

## Deployment

### Local Development

```bash
# Start the bridge service
cd services/rag-anything-bridge
docker-compose up -d

# View logs
docker-compose logs -f rag-anything-bridge

# Run tests
docker-compose exec rag-anything-bridge pytest
```

### Production Deployment

```bash
# Build production image
docker build -t rag-anything-bridge:latest .

# Deploy with docker stack
docker stack deploy -c docker-compose.yml rag-anything

# Or with Kubernetes
kubectl apply -f k8s/
```

## Monitoring

### Metrics

The bridge service exposes Prometheus metrics at `/metrics`:

- `raga_extractions_total` - Total extractions by parser and status
- `raga_extraction_duration_seconds` - Extraction duration histogram
- `raga_cache_hits_total` - Cache hit/miss counters

### Health Checks

Health endpoint: `GET /health`

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-04-26T12:00:00Z",
  "config": {
    "default_parser": "auto",
    "max_sync_pages": 30
  }
}
```

## Troubleshooting

### Common Issues

**Issue: Parser not available**

```
Error: Parser docling not available
```

**Solution:** Install parser dependencies in Dockerfile or check parser initialization logs.

**Issue: Extraction timeout**

```
Error: Extraction exceeded sync timeout
```

**Solution:** Increase `RAGA_SYNC_TIMEOUT_SEC` or use async extraction for large documents.

**Issue: Out of memory**

```
Error: Container killed (OOM)
```

**Solution:** Increase container memory limits or reduce `RAGA_SYNC_MAX_PAGES`.

### Debug Mode

Enable debug logging:

```bash
docker-compose exec rag-anything-bridge \
  python -m uvicorn src.main:app --reload --log-level debug
```

## License

This integration follows the same license as search-mcp. Parser dependencies (Docling, PaddleOCR, MinerU) have their own licenses - review before production use.

## Support

- Issues: [GitHub Issues](https://github.com/rhinos0608/search-mcp/issues)
- Documentation: [docs/RAG_ANYTHING_INTEGRATION.md](./RAG_ANYTHING_INTEGRATION.md)
- API Reference: See `/docs` endpoint on running bridge service
