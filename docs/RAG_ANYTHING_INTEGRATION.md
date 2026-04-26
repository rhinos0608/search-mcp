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

## API Reference

### TypeScript Client

```typescript
import { ragaClient, extractWithRAGA } from './utils/ragAnythingClient';

// Method 1: Using the client
const result = await ragaClient.extract({
  url: 'https://example.com/document.pdf',
  parser: 'auto', // or 'docling', 'paddleocr', 'mineru'
  extractTables: true,
  extractImages: false,
  extractEquations: true,
  maxPages: 50,
});

// Method 2: Convenience function
const result2 = await extractWithRAGA('https://example.com/document.pdf', {
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

- Issues: [GitHub Issues](https://github.com/your-org/search-mcp/issues)
- Documentation: [docs/RAG_ANYTHING_INTEGRATION.md](./RAG_ANYTHING_INTEGRATION.md)
- API Reference: See `/docs` endpoint on running bridge service
