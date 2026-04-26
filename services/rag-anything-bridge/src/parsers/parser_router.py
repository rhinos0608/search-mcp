"""
Parser Router

Routes extraction requests to appropriate parser backends:
- Docling: Born-digital PDFs and Office documents
- PaddleOCR: Image-heavy and scanned documents
- MinerU: Complex PDFs with equations, tables, academic layouts
"""

from pathlib import Path
from typing import Optional, Dict, Any
from dataclasses import dataclass
from enum import Enum
import asyncio

import structlog

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
        self._docling = None

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
            loop = asyncio.get_event_loop()
            docling_result = await loop.run_in_executor(
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
        self._ocr = None

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
                result = self._ocr.ocr(str(image_path), cls=True)

                page_text = []
                for line in result[0]:
                    if line:
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

            return ParseResult(
                content_type="image/pdf",  # TODO: detect actual type
                parser_type=ParserType.PADDLEOCR,
                parser_version="2.7.0",  # TODO: get actual version
                markdown=markdown,
                title=None,  # Could extract with heuristic
                description=None,
                page_count=len(images),
                word_count=len(markdown.split()),
                language=options.get("ocr_language", "eng"),
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
        # TODO: implement PDF to image conversion
        # For now, assume single image
        return [file_path]


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

        # Initialize Docling
        try:
            docling = DoclingParser()
            await docling.initialize()
            self.parsers[ParserType.DOCLING] = docling
            logger.info("Docling parser ready")
        except Exception as e:
            logger.warning("Docling parser not available", error=str(e))

        # Initialize PaddleOCR
        try:
            paddle = PaddleOCRParser()
            await paddle.initialize()
            self.parsers[ParserType.PADDLEOCR] = paddle
            logger.info("PaddleOCR parser ready")
        except Exception as e:
            logger.warning("PaddleOCR parser not available", error=str(e))

        self._initialized = True

    async def cleanup(self):
        """Cleanup parser resources."""
        self.parsers.clear()
        self._initialized = False

    def select_parser(self, content_type: Optional[str]) -> ParserType:
        """Select optimal parser based on content type."""
        if not content_type:
            return ParserType.DOCLING  # Default

        content_type = content_type.lower()

        # Images need OCR
        if any(t in content_type for t in ["image", "png", "jpeg", "jpg"]):
            if ParserType.PADDLEOCR in self.parsers:
                return ParserType.PADDLEOCR

        # Scanned PDFs need OCR
        if "pdf" in content_type:
            # TODO: detect if scanned vs born-digital
            # For now, default to Docling for PDFs
            if ParserType.DOCLING in self.parsers:
                return ParserType.DOCLING

        # Office documents
        if any(
            t in content_type
            for t in ["word", "doc", "excel", "xls", "powerpoint", "ppt"]
        ):
            if ParserType.DOCLING in self.parsers:
                return ParserType.DOCLING

        # Default fallback
        return (
            ParserType.DOCLING
            if ParserType.DOCLING in self.parsers
            else ParserType.PADDLEOCR
        )

    async def parse(
        self, url: str, parser_type: ParserType, options: Dict[str, Any]
    ) -> Any:
        """Route parse request to appropriate parser."""
        if parser_type not in self.parsers:
            raise ValueError(f"Parser {parser_type} not available")

        parser = self.parsers[parser_type]

        # Download file if URL provided
        # TODO: implement file download/caching
        temp_path = Path(url)  # Placeholder

        return await parser.parse(temp_path, options)
