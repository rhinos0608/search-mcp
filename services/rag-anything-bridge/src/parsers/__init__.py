"""
Parsers package for RAG-Anything Bridge.

Provides document parsing backends:
- Docling: Born-digital PDFs and Office documents
- PaddleOCR: Image-heavy and scanned documents
- MinerU: Complex PDFs with equations and tables
"""

from .parser_router import (
    ParserRouter,
    ParserType,
    BaseParser,
    ParseResult,
    DoclingParser,
    PaddleOCRParser,
)

__all__ = [
    "ParserRouter",
    "ParserType",
    "BaseParser",
    "ParseResult",
    "DoclingParser",
    "PaddleOCRParser",
]
