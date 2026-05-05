"""
Parser Router

Routes extraction requests to appropriate parser backends:
- Docling: Born-digital PDFs and Office documents
- PaddleOCR: Image-heavy and scanned documents
- MinerU: Complex PDFs with equations, tables, academic layouts
"""

from pathlib import Path
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from enum import Enum
import asyncio
import hashlib
import shutil
import tempfile
from urllib.parse import urlparse
import textwrap

import aiohttp
import structlog


def _is_safe_url(url: str) -> bool:
    """Basic SSRF guard: block private IPs and localhost."""
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    if not hostname:
        return False
    blocked = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
    if hostname.lower() in blocked:
        return False
    if hostname.lower().endswith(".local"):
        return False
    parts = hostname.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        first, second = int(parts[0]), int(parts[1])
        if first == 10:
            return False
        if first == 172 and 16 <= second <= 31:
            return False
        if first == 192 and second == 168:
            return False
        if first == 169 and second == 254:
            return False
    return True


logger = structlog.get_logger()


class ParserType(str, Enum):
    AUTO = "auto"
    DOCLING = "docling"
    PADDLEOCR = "paddleocr"
    MINERU = "mineru"


@dataclass
class ParseResult:
    """Result from document parsing."""

    content_type: str
    parser_type: ParserType
    parser_version: Optional[str]
    markdown: str
    title: Optional[str]
    description: Optional[str]
    page_count: Optional[int]
    word_count: Optional[int]
    language: Optional[str]
    elements: list  # Structured content elements
    assets: list  # Images, tables, equations
    citations: list
    warnings: list
    errors: list


class BaseParser:
    """Base class for document parsers."""

    def __init__(self):
        self.logger = structlog.get_logger(parser=self.__class__.__name__)

    async def parse(self, file_path: Path, options: Dict[str, Any]) -> ParseResult:
        raise NotImplementedError

    def detect_optimal(self, content_type: str, file_path: Path) -> bool:
        """Detect if this parser is optimal for the given content."""
        raise NotImplementedError


class DoclingParser(BaseParser):
    """Docling parser for born-digital PDFs and Office documents (docling v2.x)."""

    def __init__(self):
        super().__init__()
        self._converter: Any = None

    async def initialize(self):
        """Lazy initialization of Docling DocumentConverter."""
        if self._converter is None:
            try:
                from docling.document_converter import DocumentConverter

                self._converter = DocumentConverter()
                self.logger.info("Docling parser initialized")
            except ImportError:
                self.logger.error("Docling not installed, Docling parser unavailable")
                raise

    async def parse(self, file_path: Path, options: Dict[str, Any]) -> ParseResult:
        """Parse document using Docling."""
        await self.initialize()

        self.logger.info("Parsing with Docling", file=file_path)

        try:
            # Run Docling in thread pool to not block
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,  # Default executor
                lambda: self._converter.convert(str(file_path)),
            )

            doc = result.document
            markdown = doc.export_to_markdown()

            # Extract elements via iterate_items — yields (NodeItem, level) tuples
            elements = []
            for item, level in doc.iterate_items():
                label = item.label.value if hasattr(item.label, "value") else str(item.label)
                text = getattr(item, "text", None) or getattr(item, "caption_text", None) or ""
                element: Dict[str, Any] = {
                    "type": label,
                    "text": text,
                    "level": level,
                }
                # Extract page number and bounding box from provenance
                if hasattr(item, "prov") and item.prov:
                    prov = item.prov[0]
                    element["page_number"] = prov.page_no
                    if prov.bbox:
                        element["bbox"] = {
                            "l": prov.bbox.l,
                            "t": prov.bbox.t,
                            "r": prov.bbox.r,
                            "b": prov.bbox.b,
                        }
                elements.append(element)

            # Extract tables as assets
            assets = []
            for i, table in enumerate(doc.tables):
                cells = []
                if hasattr(table, "data") and table.data:
                    for cell in table.data.table_cells:
                        cells.append({
                            "text": cell.text,
                            "row_start": cell.start_row_offset_idx,
                            "row_end": cell.end_row_offset_idx,
                            "col_start": cell.start_col_offset_idx,
                            "col_end": cell.end_col_offset_idx,
                            "column_header": cell.column_header,
                            "row_header": cell.row_header,
                        })
                assets.append({
                    "asset_id": f"table_{i}",
                    "type": "table",
                    "num_rows": table.data.num_rows if hasattr(table, "data") and table.data else 0,
                    "num_cols": table.data.num_cols if hasattr(table, "data") and table.data else 0,
                    "cells": cells,
                })

            return ParseResult(
                content_type="application/pdf",
                parser_type=ParserType.DOCLING,
                parser_version="2.0",
                markdown=markdown,
                title=doc.name or None,
                description=None,
                page_count=doc.num_pages(),
                word_count=len(markdown.split()),
                language=None,
                elements=elements,
                assets=assets,
                citations=[],
                warnings=[],
                errors=[],
            )

        except Exception as e:
            self.logger.error("Docling parsing failed", error=str(e))
            raise


class PaddleOCRParser(BaseParser):
    """PaddleOCR parser for image-heavy and scanned documents.

    NOTE: PaddleOCR v3.x model init may SIGSEGV on ARM Docker
    (paddlepaddle contains x86 CUDA binaries). The probe runs in a
    subprocess to isolate the crash; if it fails the parser is
    marked unavailable by ParserRouter.
    """

    def __init__(self):
        super().__init__()
        self._ocr: Any = None

    async def initialize(self):
        """Lazy initialization of PaddleOCR (subprocess-sandboxed)."""
        if self._ocr is None:
            try:
                from paddleocr import PaddleOCR

                # Sandbox: probe model load in a child process to isolate SIGSEGV
                # from incompatible paddlepaddle binaries (x86 CUDA on ARM).
                import subprocess
                import sys as _sys
                import os as _os
                import tempfile as _tempfile

                _probe_code = textwrap.dedent("""\
                    import sys
                    try:
                        from paddleocr import PaddleOCR
                        PaddleOCR(use_angle_cls=True, lang="en")
                        sys.exit(0)
                    except Exception:
                        sys.exit(1)
                """)

                ok = False
                try:
                    fd, _probe_path = _tempfile.mkstemp(suffix=".py", prefix="paddle_probe_")
                    with _os.fdopen(fd, "w") as f:
                        f.write(_probe_code)

                    r = subprocess.run(
                        [_sys.executable, _probe_path],
                        capture_output=True,
                        timeout=90,
                    )
                    ok = r.returncode == 0
                except Exception as probe_err:
                    self.logger.warning(
                        "PaddleOCR subprocess probe failed", error=str(probe_err)
                    )
                finally:
                    try:
                        _os.unlink(_probe_path)
                    except Exception:
                        pass

                if not ok:
                    raise RuntimeError(
                        "PaddleOCR model init failed -- incompatible architecture?"
                    )

                self._ocr = PaddleOCR(use_angle_cls=True, lang="en")
                self.logger.info("PaddleOCR parser initialized")

            except (ImportError, RuntimeError, FileNotFoundError) as e:
                self.logger.error("PaddleOCR not available", error=str(e))
                raise


class MinerUParser(BaseParser):
    """MinerU parser for complex PDFs with equations, tables, and academic layouts.

    Uses raganything's Parser class which wraps the mineru CLI.
    """

    def __init__(self):
        super().__init__()

    async def initialize(self):
        """Verify raganything is importable."""
        try:
            from raganything import Parser  # noqa: F401
            self.logger.info("MinerU parser initialized")
        except ImportError:
            self.logger.error("MinerU not installed, MinerU parser unavailable")
            raise

    async def parse(self, file_path: Path, options: Dict[str, Any]) -> ParseResult:
        """Parse document using MinerU 2.0 (via raganything Parser)."""
        from raganything import Parser as MinerUBaseParser

        self.logger.info("Parsing with MinerU", file=file_path)

        # Use a temp directory for mineru output
        output_dir = tempfile.mkdtemp(prefix="mineru_")
        try:
            parser = MinerUBaseParser()
            loop = asyncio.get_running_loop()

            content_blocks = await loop.run_in_executor(
                None,
                lambda: parser.parse_pdf(
                    str(file_path),
                    output_dir=output_dir,
                    method=options.get("parse_method", "auto"),
                    lang=options.get("ocr_language"),
                ),
            )

            # Rebuild markdown and extract elements/assets from content blocks
            elements = []
            assets = []
            md_parts = []

            for block in content_blocks:
                block_type = block.get("type", "text")
                block_text = block.get("text", "")

                if block_type == "text":
                    md_parts.append(block_text)
                    elements.append({"type": "text", "text": block_text})

                elif block_type in ("heading", "section_header"):
                    level = block.get("level", 1)
                    prefix = "#" * level
                    md_parts.append(f"{prefix} {block_text}")
                    elements.append({"type": "heading", "text": block_text, "level": level})

                elif block_type == "table":
                    caption = block.get("image_caption") or block.get("img_caption", "")
                    md_parts.append(f"[Table: {caption}]" if caption else "[Table]")
                    if block.get("table_img_path"):
                        assets.append({
                            "asset_id": f"table_{len(assets)}",
                            "type": "table",
                            "path": block["table_img_path"],
                            "caption": caption,
                        })
                    elements.append({"type": "table", "text": block_text, "caption": caption})

                elif block_type == "image":
                    caption = block.get("image_caption") or block.get("img_caption", "")
                    img_path = block.get("img_path", "")
                    if img_path:
                        md_parts.append(f"![{caption}]({img_path})")
                    elif caption:
                        md_parts.append(f"[Image: {caption}]")
                    assets.append({
                        "asset_id": f"image_{len(assets)}",
                        "type": "image",
                        "path": img_path,
                        "caption": caption,
                    })
                    elements.append({"type": "image", "text": caption, "path": img_path})

                elif block_type == "equation":
                    md_parts.append(f"$${block_text}$$" if block_text else "")
                    elements.append({"type": "equation", "text": block_text})

                else:
                    if block_text:
                        md_parts.append(block_text)
                        elements.append({"type": block_type, "text": block_text})

            markdown = "\n\n".join(md_parts)

            # Determine title from first heading block
            title = None
            for block in content_blocks:
                btype = block.get("type", "")
                if btype in ("heading", "section_header") and block.get("text"):
                    title = block["text"]
                    break

            return ParseResult(
                content_type="application/pdf",
                parser_type=ParserType.MINERU,
                parser_version="2.0",
                markdown=markdown,
                title=title,
                description=None,
                page_count=None,  # mineru doesn't expose page count directly
                word_count=len(markdown.split()),
                language=None,
                elements=elements,
                assets=assets,
                citations=[],
                warnings=[],
                errors=[],
            )

        except Exception as e:
            self.logger.error("MinerU parsing failed", error=str(e))
            raise
        finally:
            shutil.rmtree(output_dir, ignore_errors=True)


class ParserRouter:
    """Routes parsing requests to appropriate parser."""

    def __init__(self, default_parser: str = "auto"):
        self.default_parser = default_parser
        self.parsers: Dict[ParserType, BaseParser] = {}
        self._initialized = False

    async def initialize(self):
        """Initialize all parsers."""
        if self._initialized:
            return
        # Initialize all available parsers with deduplication
        for parser_cls in [DoclingParser, PaddleOCRParser, MinerUParser]:
            pt = ParserType(parser_cls.__name__.lower().replace("parser", ""))
            if pt in self.parsers:
                continue
            try:
                instance = parser_cls()
                await instance.initialize()
                self.parsers[pt] = instance
                logger.info(f"{parser_cls.__name__} parser ready")
            except Exception as e:
                logger.warning(f"{parser_cls.__name__} not available", error=str(e))
        self._initialized = True

    async def cleanup(self):
        """Cleanup parser resources."""
        self.parsers.clear()
        self._initialized = False

    def select_parser(self, content_type: Optional[str]) -> ParserType:
        """Select optimal parser based on content type."""
        if not content_type:
            if ParserType.DOCLING in self.parsers:
                return ParserType.DOCLING
            if ParserType.PADDLEOCR in self.parsers:
                return ParserType.PADDLEOCR
            if ParserType.MINERU in self.parsers:
                return ParserType.MINERU
            raise RuntimeError("No parsers available")
        content_type = content_type.lower()
        if any(t in content_type for t in ["image", "png", "jpeg", "jpg"]):
            if ParserType.PADDLEOCR in self.parsers:
                return ParserType.PADDLEOCR
        if any(t in content_type for t in ["pdf"]):
            if ParserType.MINERU in self.parsers:
                return ParserType.MINERU
            if ParserType.DOCLING in self.parsers:
                return ParserType.DOCLING
        if any(
            t in content_type
            for t in ["word", "doc", "excel", "xls", "powerpoint", "ppt"]
        ):
            if ParserType.DOCLING in self.parsers:
                return ParserType.DOCLING
        if ParserType.DOCLING in self.parsers:
            return ParserType.DOCLING
        if ParserType.PADDLEOCR in self.parsers:
            return ParserType.PADDLEOCR
        raise RuntimeError("No parsers available")

    async def parse(
        self, url: str, parser_type: ParserType, options: Dict[str, Any]
    ) -> Any:
        """Route parse request to appropriate parser."""
        if parser_type == ParserType.AUTO:
            parser_type = self.select_parser(options.get("content_type"))
        if parser_type not in self.parsers:
            raise ValueError(f"Parser {parser_type} not available")
        parser = self.parsers[parser_type]
        downloaded = False
        if url.startswith("http://") or url.startswith("https://"):
            if not _is_safe_url(url):
                raise ValueError(f"URL not allowed: {url}")
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url, timeout=aiohttp.ClientTimeout(total=60)
                ) as resp:
                    resp.raise_for_status()
                    content = await resp.read()
            max_size = options.get("max_size_bytes", 100 * 1024 * 1024)
            if len(content) > max_size:
                raise ValueError(f"Download exceeds maximum size of {max_size} bytes")
            content_hash = hashlib.sha256(content).hexdigest()
            cache_dir = Path(tempfile.gettempdir()) / "raga-downloads"
            cache_dir.mkdir(parents=True, exist_ok=True)
            temp_path = cache_dir / content_hash
            temp_path.write_bytes(content)
            downloaded = True
        else:
            temp_path = Path(url)
        try:
            return await parser.parse(temp_path, options)
        finally:
            if downloaded and temp_path.exists():
                temp_path.unlink(missing_ok=True)
