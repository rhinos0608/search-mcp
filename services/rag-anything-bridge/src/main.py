#!/usr/bin/env python3
"""
RAG-Anything Bridge Service

FastAPI service providing document extraction capabilities via RAG-Anything.
Supports multiple parser backends: Docling, PaddleOCR, MinerU.
"""

import os
import sys
import hashlib
import uuid
import asyncio
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Literal, cast
from contextlib import asynccontextmanager
from dataclasses import is_dataclass, asdict

from fastapi import FastAPI, HTTPException, BackgroundTasks, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import structlog  # type: ignore[import-untyped]
from prometheus_client import Counter, Histogram, generate_latest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from parsers.parser_router import ParserRouter, ParserType
from processors.content_processor import ContentProcessor
from utils.cache import CacheManager
from utils.storage import StorageManager, StorageConfig

# Configure logging
structlog.configure(
   processors=[
      structlog.processors.TimeStamper(fmt="iso"),
      structlog.processors.format_exc_info,
      structlog.processors.JSONRenderer(),
   ]
)
logger = structlog.get_logger()

# Configuration
CONFIG = {
    "cache_dir": Path(os.getenv("RAGA_CACHE_DIR", "/cache/rag-anything")),
    "max_sync_pages": int(os.getenv("RAGA_MAX_SYNC_PAGES", "30")),
    "max_sync_size_mb": int(os.getenv("RAGA_MAX_SYNC_SIZE_MB", "20")),
    "default_parser": os.getenv("RAGA_DEFAULT_PARSER", "auto"),
    "request_timeout": int(os.getenv("RAGA_REQUEST_TIMEOUT", "30")),
    "async_job_timeout": int(os.getenv("RAGA_ASYNC_TIMEOUT", "300")),
    "gpu_enabled": os.getenv("RAGA_GPU_ENABLED", "false").lower() == "true",
}

# Metrics
EXTRACTION_COUNTER = Counter(
    "raga_extractions_total",
    "Total extractions by parser and status",
    ["parser", "status"],
)

EXTRACTION_DURATION = Histogram(
    "raga_extraction_duration_seconds", "Extraction duration in seconds", ["parser"]
)

CACHE_HIT_COUNTER = Counter(
    "raga_cache_hits_total", "Total cache hits and misses", ["result"]
)


# Pydantic models
class ExtractionRequest(BaseModel):
    url: str = Field(..., description="URL to extract content from")
    content_type: Optional[str] = Field(
        None, description="Content type hint (pdf, html, etc.)"
    )
    parser: Optional[Literal["auto", "docling", "paddleocr", "mineru"]] = Field(
        None, description="Parser to use"
    )
    extract_tables: bool = Field(True, description="Extract and structure tables")
    extract_images: bool = Field(
        False, description="Extract image captions/descriptions (v1: not embeddings)"
    )
    extract_equations: bool = Field(
        True, description="Extract and parse equations/formulas"
    )
    ocr_language: Optional[str] = Field(
        None, description="OCR language code (e.g., 'eng', 'chi_sim')"
    )
    max_pages: Optional[int] = Field(None, description="Maximum pages to process")
    sync_timeout: int = Field(30, description="Synchronous timeout in seconds")


class Asset(BaseModel):
    asset_id: str
    type: Literal["image", "table", "equation", "chart"]
    mime_type: Optional[str] = None
    source_url: Optional[str] = None
    caption: Optional[str] = None
    alt_text: Optional[str] = None
    page_number: Optional[int] = None
    bounding_box: Optional[Dict[str, float]] = None
    storage_path: Optional[str] = None


class ContentItem(BaseModel):
    item_id: str
    type: Literal["text", "image", "table", "equation", "heading", "list", "generic"]
    text: Optional[str] = None
    markdown: Optional[str] = None
    page_number: Optional[int] = None
    section_heading: Optional[str] = None
    caption: Optional[str] = None
    asset_ref: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ExtractionResult(BaseModel):
    # Identification
    document_id: str
    source_url: str
    source_type: str

    # Parser info
    parser_used: str
    parser_version: Optional[str] = None
    extraction_config: Dict[str, Any]

    # Content
    markdown: str
    title: Optional[str] = None
    description: Optional[str] = None
    content_items: List[ContentItem]

    # Assets
    assets: List[Asset]

    # Metadata
    page_count: Optional[int] = None
    word_count: Optional[int] = None
    language: Optional[str] = None

    # Citations
    citations: List[Dict[str, Any]]

    # Status
    warnings: List[str]
    errors: List[str]
    processing_time_ms: int
    cached: bool

    # Timing
    created_at: str
    expires_at: Optional[str] = None


class JobStatus(BaseModel):
    document_id: str
    status: Literal[
        "pending", "processing", "completed", "failed", "not_found", "expired"
    ]
    progress: Optional[float] = None  # 0-100
    message: Optional[str] = None
    created_at: str
    updated_at: str
    completed_at: Optional[str] = None
    result: Optional[ExtractionResult] = None


parser_router: ParserRouter = None  # type: ignore[assignment]
content_processor: ContentProcessor = None  # type: ignore[assignment]
cache_manager: CacheManager = None  # type: ignore[assignment]
storage_manager: StorageManager = None  # type: ignore[assignment]

# Async job store: {document_id: {status, progress, message, result, error}}
async_jobs: Dict[str, Dict[str, Any]] = {}
async_jobs_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    global parser_router, content_processor, cache_manager, storage_manager

    logger.info("Starting RAG-Anything Bridge", config=CONFIG)

    # Log GPU status
    if CONFIG["gpu_enabled"]:
        logger.info("GPU acceleration enabled via RAGA_GPU_ENABLED")
        try:
            import torch
            if torch.cuda.is_available():
                logger.info("CUDA GPU detected and available", device=torch.cuda.get_device_name(0))
            elif torch.backends.mps.is_available():
                logger.info("Apple Silicon MPS detected and available")
            else:
                logger.warn("RAGA_GPU_ENABLED is true but no GPU device was detected by PyTorch")
        except ImportError:
            logger.warn("RAGA_GPU_ENABLED is true but torch is not installed; GPU acceleration may be limited")
    else:
        logger.info("GPU acceleration disabled (CPU-only mode)")

    # Initialize components
    cache_manager = CacheManager(CONFIG["cache_dir"])
    storage_manager = StorageManager(StorageConfig(local_path=CONFIG["cache_dir"] / "assets"))
    parser_router = ParserRouter(default_parser=CONFIG["default_parser"])
    content_processor = ContentProcessor()

    # Warm up parsers
    await parser_router.initialize()

    yield

    # Shutdown
    logger.info("Shutting down RAG-Anything Bridge")
    await parser_router.cleanup()


app = FastAPI(
    title="RAG-Anything Bridge",
    description="Document extraction service for search-mcp",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "1.0.0",
        "timestamp": datetime.utcnow().isoformat(),
        "config": {
            "default_parser": CONFIG["default_parser"],
            "max_sync_pages": CONFIG["max_sync_pages"],
        },
    }


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    return generate_latest()


async def _run_extraction(
    doc_id: str,
    request: ExtractionRequest,
    parser_type: str,
    start_time: datetime,
):
    """Run extraction in background, updating job store with progress."""
    global parser_router, content_processor, cache_manager
    global EXTRACTION_DURATION, EXTRACTION_COUNTER

    async def set_job(status: str, progress: float, message: str):
        async with async_jobs_lock:
            if doc_id in async_jobs:
                async_jobs[doc_id].update({
                    "status": status,
                    "progress": progress,
                    "message": message,
                    "updated_at": datetime.utcnow().isoformat(),
                    "completed_at": datetime.utcnow().isoformat() if status in ("completed", "failed") else async_jobs[doc_id].get("completed_at"),
                })

    try:
        await set_job("processing", 5.0, "Initializing parser")

        # Perform extraction
        with EXTRACTION_DURATION.labels(parser=parser_type).time():
            assert parser_router is not None
            parse_result = await parser_router.parse(
                url=request.url,
                parser_type=cast(ParserType, parser_type),
                options={
                    "extract_tables": request.extract_tables,
                    "extract_images": request.extract_images,
                    "extract_equations": request.extract_equations,
                    "ocr_language": request.ocr_language,
                    "max_pages": request.max_pages,
                },
            )

        await set_job("processing", 70.0, "Processing content")

        # Process and structure content
        assert content_processor is not None
        raw_items = await content_processor.process(parse_result)

        # Convert dataclass ContentItems (from content_processor) to dicts
        # for Pydantic BaseModel ContentItem (defined in main.py)
        content_items = [
            asdict(item) if is_dataclass(item) and not isinstance(item, dict) else item
            for item in raw_items
        ]

        await set_job("processing", 90.0, "Building result")

        # Build result
        processing_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        result = ExtractionResult(  # type: ignore[arg-type]
            document_id=doc_id,
            source_url=request.url,
            source_type=request.content_type or parse_result.content_type,
            parser_used=parser_type,
            parser_version=parse_result.parser_version,
            extraction_config={
                "extract_tables": request.extract_tables,
                "extract_images": request.extract_images,
                "extract_equations": request.extract_equations,
            },
            markdown=parse_result.markdown,
            title=parse_result.title,
            description=parse_result.description,
            content_items=content_items,  # type: ignore[arg-type]
            assets=parse_result.assets,
            page_count=parse_result.page_count,
            word_count=parse_result.word_count,
            language=parse_result.language,
            citations=parse_result.citations,
            warnings=parse_result.warnings,
            errors=parse_result.errors,
            processing_time_ms=int(processing_time),
            cached=False,
            created_at=start_time.isoformat(),
            expires_at=(start_time + timedelta(days=7)).isoformat(),
        )

        # Cache result
        assert cache_manager is not None
        await cache_manager.set(doc_id, result.model_dump(), ttl=86400 * 7)  # 7 days

        # Store result in job store
        async with async_jobs_lock:
            if doc_id in async_jobs:
                async_jobs[doc_id].update({
                    "status": "completed",
                    "progress": 100.0,
                    "message": "Extraction completed",
                    "result": result.model_dump(),
                    "updated_at": datetime.utcnow().isoformat(),
                    "completed_at": datetime.utcnow().isoformat(),
                })

        EXTRACTION_COUNTER.labels(parser=parser_type, status="success").inc()

    except Exception as e:
        logger.error("Background extraction failed", url=request.url, doc_id=doc_id, error=str(e))
        EXTRACTION_COUNTER.labels(parser=parser_type or "unknown", status="error").inc()
        async with async_jobs_lock:
            if doc_id in async_jobs:
                async_jobs[doc_id].update({
                    "status": "failed",
                    "progress": None,
                    "message": f"Extraction failed: {str(e)}",
                    "error": str(e),
                    "updated_at": datetime.utcnow().isoformat(),
                    "completed_at": datetime.utcnow().isoformat(),
                })


@app.post("/extract")
async def extract(request: ExtractionRequest, background_tasks: BackgroundTasks):
    """
    Extract content from a URL.

    Submits extraction as an async job and returns a JobStatus for polling.
    Use the returned document_id to poll /extract/{document_id}/status
    and fetch the result from /extract/{document_id}/result.
    """
    start_time = datetime.utcnow()
    now_ts = start_time.isoformat()

    try:
        # Generate document ID
        doc_id = hashlib.sha256(request.url.encode()).hexdigest()[:16]

        # Check cache first
        cached_result = await cache_manager.get(doc_id)
        if cached_result:
            CACHE_HIT_COUNTER.labels(result="hit").inc()
            return JobStatus(
                document_id=doc_id,
                status="completed",
                progress=100.0,
                message="Served from cache",
                created_at=now_ts,
                updated_at=now_ts,
                completed_at=now_ts,
                result=ExtractionResult(**cached_result),
            )

        CACHE_HIT_COUNTER.labels(result="miss").inc()

        # Determine parser
        parser_type = request.parser or CONFIG["default_parser"]
        if parser_type == "auto":
            parser_type = parser_router.select_parser(request.content_type)

        # Check sync limits
        if request.max_pages and request.max_pages > CONFIG["max_sync_pages"]:
            return JobStatus(
                document_id=doc_id,
                status="failed",
                progress=None,
                message=f"Document exceeds sync page limit ({CONFIG['max_sync_pages']})",
                created_at=now_ts,
                updated_at=now_ts,
                completed_at=now_ts,
            )

        # Register async job
        async with async_jobs_lock:
            async_jobs[doc_id] = {
                "status": "pending",
                "progress": 0.0,
                "message": "Queued",
                "created_at": now_ts,
                "updated_at": now_ts,
                "completed_at": None,
                "result": None,
                "error": None,
            }

        # Start background extraction
        background_tasks.add_task(
            _run_extraction,
            doc_id=doc_id,
            request=request,
            parser_type=parser_type,
            start_time=start_time,
        )

        return JobStatus(
            document_id=doc_id,
            status="pending",
            progress=0.0,
            message="Extraction queued",
            created_at=now_ts,
            updated_at=now_ts,
            completed_at=None,
            result=None,
        )

    except Exception:
        logger.exception("Extraction submission failed", url=request.url)
        EXTRACTION_COUNTER.labels(
            parser=request.parser or "unknown", status="error"
        ).inc()
        raise HTTPException(
            status_code=500, detail="Internal server error during extraction"
        )


@app.get("/extract/{document_id}/status", response_model=JobStatus)
async def extraction_status(document_id: str):
    """Check status of async extraction job."""
    # Check job store first (live extraction)
    async with async_jobs_lock:
        job = async_jobs.get(document_id)
        if job:
            return JobStatus(
                document_id=document_id,
                status=job.get("status", "not_found"),
                progress=job.get("progress"),
                message=job.get("message"),
                created_at=job.get("created_at", datetime.utcnow().isoformat()),
                updated_at=job.get("updated_at", datetime.utcnow().isoformat()),
                completed_at=job.get("completed_at"),
            )

    # Fall back to cache (completed extractions)
    assert cache_manager is not None
    cached = await cache_manager.get(document_id)

    if cached:
        return JobStatus(
            document_id=document_id,
            status="completed",
            progress=100,
            message="Extraction completed",
            created_at=datetime.utcnow().isoformat(),
            updated_at=datetime.utcnow().isoformat(),
            completed_at=datetime.utcnow().isoformat(),
        )

    return JobStatus(
        document_id=document_id,
        status="not_found",
        progress=None,
        message="Document not found or extraction not started",
        created_at=datetime.utcnow().isoformat(),
        updated_at=datetime.utcnow().isoformat(),
    )


@app.get("/extract/{document_id}/result")
async def extraction_result(document_id: str):
    """Get extraction result by document ID."""
    # Check job store first (live extraction)
    async with async_jobs_lock:
        job = async_jobs.get(document_id)
        if job:
            status = job.get("status")
            if status == "completed":
                result_data = job.get("result")
                if result_data:
                    return result_data
            elif status in ("pending", "processing"):
                raise HTTPException(
                    status_code=409,
                    detail=f"Extraction still in progress (status: {status}). Poll /extract/{document_id}/status",
                )
            elif status == "failed":
                raise HTTPException(
                    status_code=422,
                    detail=f"Extraction failed: {job.get('message', 'Unknown error')}",
                )
            # fall through to cache for completed jobs without stored result

    # Fall back to cache
    assert cache_manager is not None
    cached = await cache_manager.get(document_id)
    if not cached:
        raise HTTPException(status_code=404, detail="Document not found or expired")

    return cached

@app.post("/parse/file")
async def parse_file(
    file: UploadFile = File(...),
    parser: ParserType = ParserType.AUTO,
    extract_tables: bool = True,
    extract_images: bool = False,
    extract_equations: bool = True,
):
    """Parse an uploaded file directly."""
    # Save uploaded file
    temp_dir = CONFIG["cache_dir"] / "uploads"
    temp_dir.mkdir(parents=True, exist_ok=True)

    file_path = temp_dir / f"{uuid.uuid4().hex}_{file.filename}"
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    assert parser_router is not None
    assert content_processor is not None
    try:
        # Parse file
        result = await parser_router.parse(
            url=str(file_path),
            parser_type=parser,
            options={
                "extract_tables": extract_tables,
                "extract_images": extract_images,
                "extract_equations": extract_equations,
            },
        )

        return result

    finally:
        # Cleanup
        if file_path.exists():
            file_path.unlink()


if __name__ == "__main__":
    import uvicorn

    # Ensure cache directory exists
    CONFIG["cache_dir"].mkdir(parents=True, exist_ok=True)

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=os.getenv("RAGA_DEBUG") == "true",
        log_level="info",
    )
