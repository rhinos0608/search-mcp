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
import tempfile
from urllib.parse import urlparse

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
    """Docling parser for born-digital PDFs and Office documents."""

    def __init__(self):
        super().__init__()
        self._docling: Any = None

    async def initialize(self):
        """Lazy initialization of Docling."""
        if self._docling is None:
            try:
                from docling import Docling

                self._docling = Docling()
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
            docling_result = await loop.run_in_executor(  # type: ignore[call-overload]
                None,  # Default executor
                lambda: self._docling.convert(str(file_path)),
            )

            # Extract structured content
            markdown = docling_result.export_to_markdown()

            # Extract elements
            elements = []
            for element in docling_result.elements:
                elements.append(
                    {
                        "type": element.type,
                        "text": element.text,
                        "level": getattr(element, "level", None),
                        "bbox": element.bbox if hasattr(element, "bbox") else None,
                    }
                )

            # Extract tables as assets
            assets = []
            for table in docling_result.tables:
                assets.append(
                    {
                        "asset_id": f"table_{table.id}",
                        "type": "table",
                        "caption": table.caption,
                        "data": table.data,
                    }
                )

            return ParseResult(
                content_type="application/pdf",  # TODO: detect actual type
                parser_type=ParserType.DOCLING,
                parser_version="1.0.0",  # TODO: get actual version
                markdown=markdown,
                title=docling_result.title,
                description=None,
                page_count=len(docling_result.pages)
                if hasattr(docling_result, "pages")
                else None,
                word_count=len(markdown.split()),
                language=docling_result.language
                if hasattr(docling_result, "language")
                else None,
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
    """PaddleOCR parser for image-heavy and scanned documents."""

    def __init__(self):
        super().__init__()
        self._ocr: Any = None

    async def initialize(self):
        """Lazy initialization of PaddleOCR."""
        if self._ocr is None:
            try:
                from paddleocr import PaddleOCR

                self._ocr = PaddleOCR(
                    use_angle_cls=True,
                    lang="en",
                    show_log=False,
                )
                self.logger.info("PaddleOCR parser initialized")
            except ImportError:
                self.logger.error("PaddleOCR not installed, OCR parser unavailable")
                raise

    async def parse(self, file_path: Path, options: Dict[str, Any]) -> ParseResult:
        """Parse image/PDF using PaddleOCR."""
        await self.initialize()

        self.logger.info("Parsing with PaddleOCR", file=file_path)

        try:
            # Convert PDF to images if needed
            images = await self._convert_to_images(file_path)

            # OCR each image
            all_text = []
            elements = []

            for i, image_path in enumerate(images):
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(  # type: ignore[call-overload]
                    None, self._ocr.ocr, str(image_path), True
                )

                page_text = []
                if not result or not result[0]:
                    continue

                for line in result[0]:
                    if not line or len(line) < 2:
                        continue
                    if not isinstance(line[1], (list, tuple)) or len(line[1]) < 2:
                        continue

                    bbox = line[0]
                    text = line[1][0]
                    conf = line[1][1]

                    page_text.append(text)
                    elements.append(
                        {
                            "type": "text",
                            "text": text,
                            "page_number": i + 1,
                            "confidence": conf,
                            "bbox": bbox,
                        }
                    )

                all_text.append("\n".join(page_text))

            # Build markdown
            markdown = "\n\n".join(all_text)

            # Detect content type from file extension
            suffix = file_path.suffix.lower()
            detected_type = {
                ".pdf": "application/pdf",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".tiff": "image/tiff",
                ".tif": "image/tiff",
                ".bmp": "image/bmp",
                ".gif": "image/gif",
                ".webp": "image/webp",
            }.get(suffix, "application/octet-stream")

            return ParseResult(
                content_type=detected_type,
                parser_type=ParserType.PADDLEOCR,
                parser_version="2.7.0",  # TODO: get actual version
                markdown=markdown,
                title=None,  # Could extract with heuristic
                description=None,
                page_count=len(images),
                word_count=len(markdown.split()),
                language=options.get("ocr_language", "en"),
                elements=elements,
                assets=[],  # Could extract images
                citations=[],
                warnings=["OCR extraction may contain errors"],
                errors=[],
            )

        except Exception as e:
            self.logger.error("PaddleOCR parsing failed", error=str(e))
            raise

    async def _convert_to_images(self, file_path: Path) -> List[Path]:
        """Convert PDF to images for OCR."""
        from pdf2image import convert_from_path

        loop = asyncio.get_running_loop()

        try:
            images = await loop.run_in_executor(
                None, convert_from_path, str(file_path), 200
            )
        except Exception as exc:
            self.logger.error("PDF to image conversion failed", error=str(exc))
            raise RuntimeError(
                f"PDF-to-image conversion failed for {file_path}; "
                "ensure pdf2image and poppler are installed"
            ) from exc

        temp_dir = file_path.parent
        image_paths: List[Path] = []

        def _save():
            paths = []
            for i, image in enumerate(images):
                image_path = temp_dir / f"{file_path.stem}_page_{i + 1}.png"
                image.save(str(image_path), "PNG")
                paths.append(image_path)
            return paths

        image_paths = await loop.run_in_executor(None, _save)
        return image_paths


class MinerUParser(BaseParser):
    """MinerU parser for complex PDFs with equations, tables, and academic layouts."""

    def __init__(self):
        super().__init__()
        self._mineru: Any = None

    async def initialize(self):
        """Lazy initialization of MinerU."""
        if self._mineru is None:
            try:
                from raganything import MinerU as MinerUClass

                self._mineru = MinerUClass()
                self.logger.info("MinerU parser initialized")
            except ImportError:
                self.logger.error("MinerU not installed, MinerU parser unavailable")
                raise

    async def parse(self, file_path: Path, options: Dict[str, Any]) -> ParseResult:
        """Parse document using MinerU."""
        await self.initialize()

        self.logger.info("Parsing with MinerU", file=file_path)

        try:
            loop = asyncio.get_running_loop()
            mineru_result = await loop.run_in_executor(  # type: ignore[call-overload]
                None,
                lambda: self._mineru.parse(str(file_path)),
            )

            elements = []
            for element in mineru_result.elements:
                elements.append(
                    {
                        "type": element.type,
                        "text": element.text,
                        "level": getattr(element, "level", None),
                        "bbox": element.bbox if hasattr(element, "bbox") else None,
                    }
                )

            return ParseResult(
                content_type="application/pdf",
                parser_type=ParserType.MINERU,
                parser_version="1.0.0",
                markdown=mineru_result.markdown,
                title=mineru_result.title,
                description=None,
                page_count=getattr(mineru_result, "page_count", None),
                word_count=len(mineru_result.markdown.split()),
                language=getattr(mineru_result, "language", None),
                elements=elements,
                assets=getattr(mineru_result, "assets", []),
                citations=getattr(mineru_result, "citations", []),
                warnings=[],
                errors=[],
            )
        except Exception as e:
            self.logger.error("MinerU parsing failed", error=str(e))
            raise


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
