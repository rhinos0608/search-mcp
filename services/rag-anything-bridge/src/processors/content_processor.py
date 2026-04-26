"""
Content Processor

Transforms raw parser output into structured content items suitable
for indexing and retrieval in search-mcp.
"""

from typing import List, Dict, Any, Optional
from dataclasses import dataclass

# Handle structlog import
try:
    import structlog

    logger = structlog.get_logger()
except ImportError:
    import logging

    logger = logging.getLogger(__name__)


@dataclass
class ContentItem:
    """Structured content item for search-mcp integration."""

    item_id: str
    type: str  # text, heading, table, image, equation, list, code
    text: Optional[str] = None
    markdown: Optional[str] = None
    page_number: Optional[int] = None
    section_heading: Optional[str] = None
    caption: Optional[str] = None
    asset_ref: Optional[str] = None  # Reference to extracted asset
    metadata: Optional[Dict[str, Any]] = None


class ContentProcessor:
    """Process and structure content from various parsers."""

    def __init__(self):
        self.logger = logger
        self._item_counter = 0

    def _generate_item_id(self) -> str:
        """Generate unique item ID."""
        self._item_counter += 1
        return f"item-{self._item_counter:06d}"

    async def process(self, parse_result: Any) -> List[ContentItem]:
        """
        Process parse result into structured content items.

        Args:
            parse_result: Result from parser (Docling, PaddleOCR, etc.)

        Returns:
            List of structured content items
        """
        items = []

        try:
            # Handle different parser output formats
            if hasattr(parse_result, "elements"):
                # Docling-style output
                items = await self._process_docling_elements(parse_result.elements)
            elif hasattr(parse_result, "pages"):
                # OCR-style output with pages
                items = await self._process_ocr_pages(parse_result.pages)
            else:
                # Generic text processing
                items = await self._process_generic(parse_result)

            self.logger.info(
                "Content processing complete",
                item_count=len(items),
                types=self._count_types(items),
            )

        except Exception as e:
            self.logger.error("Content processing failed", error=str(e))
            # Return minimal text item on failure
            items = [
                ContentItem(
                    item_id=self._generate_item_id(),
                    type="text",
                    text="Content processing failed",
                    markdown="Error processing document content",
                )
            ]

        return items

    async def _process_docling_elements(self, elements: List[Any]) -> List[ContentItem]:
        """Process Docling elements into content items."""
        items = []
        current_section = None

        for element in elements:
            try:
                item = await self._convert_docling_element(element, current_section)
                if item:
                    items.append(item)

                    # Track section headings
                    if item.type == "heading":
                        current_section = item.text

            except Exception as e:
                self.logger.warning(
                    "Failed to process element",
                    element_type=getattr(element, "type", "unknown"),
                    error=str(e),
                )

        return items

    async def _convert_docling_element(
        self, element: Any, section_heading: Optional[str]
    ) -> Optional[ContentItem]:
        """Convert single Docling element to ContentItem."""
        element_type = getattr(element, "type", "text")
        element_text = getattr(element, "text", "")

        if element_type == "heading":
            level = getattr(element, "level", 1)
            return ContentItem(
                item_id=self._generate_item_id(),
                type="heading",
                text=element_text,
                markdown=f"{'#' * level} {element_text}",
                metadata={"level": level},
            )

        elif element_type == "paragraph":
            return ContentItem(
                item_id=self._generate_item_id(),
                type="text",
                text=element_text,
                markdown=element_text,
                section_heading=section_heading,
            )

        elif element_type == "table":
            # Convert table to markdown
            table_data = getattr(element, "data", [])
            markdown = self._table_to_markdown(table_data)

            return ContentItem(
                item_id=self._generate_item_id(),
                type="table",
                text=element_text,  # Caption or summary
                markdown=markdown,
                section_heading=section_heading,
                caption=getattr(element, "caption", None),
                metadata={
                    "rows": len(table_data),
                    "cols": len(table_data[0]) if table_data else 0,
                },
            )

        elif element_type == "image":
            return ContentItem(
                item_id=self._generate_item_id(),
                type="image",
                text=getattr(element, "caption", ""),
                markdown=f"![{getattr(element, 'caption', '')}]({getattr(element, 'path', '')})",
                caption=getattr(element, "caption", None),
                asset_ref=getattr(element, "path", None),
                metadata={
                    "width": getattr(element, "width", None),
                    "height": getattr(element, "height", None),
                },
            )

        elif element_type == "equation":
            latex = getattr(element, "latex", element_text)
            return ContentItem(
                item_id=self._generate_item_id(),
                type="equation",
                text=element_text,
                markdown=f"$${latex}$$",
                metadata={"latex": latex},
            )

        # Generic fallback
        return ContentItem(
            item_id=self._generate_item_id(),
            type="text",
            text=element_text,
            markdown=element_text,
            section_heading=section_heading,
        )

    def _table_to_markdown(self, table_data: list) -> str:
        """Convert table data to markdown format."""
        if not table_data:
            return ""

        lines = []

        # Header row
        header = table_data[0]
        lines.append("| " + " | ".join(str(cell) for cell in header) + " |")

        # Separator
        lines.append("|" + "|".join(" --- " for _ in header) + "|")

        # Data rows
        for row in table_data[1:]:
            lines.append("| " + " | ".join(str(cell) for cell in row) + " |")

        return "\n".join(lines)

    async def _process_ocr_pages(self, pages: list) -> list:
        """Process OCR output pages into content items."""
        items = []

        for page_idx, page in enumerate(pages, 1):
            # Add page as heading
            items.append(
                ContentItem(
                    item_id=self._generate_item_id(),
                    type="heading",
                    text=f"Page {page_idx}",
                    markdown=f"## Page {page_idx}",
                    page_number=page_idx,
                    metadata={"level": 2},
                )
            )

            # Process OCR text blocks
            for block in page.get("blocks", []):
                text = block.get("text", "").strip()
                if not text:
                    continue

                items.append(
                    ContentItem(
                        item_id=self._generate_item_id(),
                        type="text",
                        text=text,
                        markdown=text,
                        page_number=page_idx,
                        metadata={
                            "bbox": block.get("bbox"),
                            "confidence": block.get("confidence"),
                        },
                    )
                )

        return items

    async def _process_generic(self, parse_result: Any) -> list:
        """Process generic parser output."""
        # Extract text content
        text = ""
        if hasattr(parse_result, "text"):
            text = parse_result.text
        elif hasattr(parse_result, "markdown"):
            text = parse_result.markdown
        elif hasattr(parse_result, "content"):
            text = parse_result.content

        return [
            ContentItem(
                item_id=self._generate_item_id(),
                type="text",
                text=text,
                markdown=text,
            )
        ]

    def _count_types(self, items: list) -> Dict[str, int]:
        """Count content items by type."""
        counts = {}
        for item in items:
            item_type = item.type if hasattr(item, "type") else "unknown"
            counts[item_type] = counts.get(item_type, 0) + 1
        return counts
