"""
Parsers package for RAG-Anything Bridge.

Provides document parsing backends:
- Docling: Born-digital PDFs and Office documents
- PaddleOCR: Image-heavy and scanned documents
- MinerU: Complex PDFs with equations, tables, academic layouts
"""

from .parser_router import (
    ParserRouter,
    ParserType,
    BaseParser,
    ParseResult,
    DoclingParser,
    PaddleOCRParser,
    MinerUParser,
)

__all__ = [
    "ParserRouter",
    "ParserType",
    "BaseParser",
    "ParseResult",
    "DoclingParser",
    "PaddleOCRParser",
    "MinerUParser",
]
