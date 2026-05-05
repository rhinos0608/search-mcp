"""
Content Processor

Transforms raw parser output into structured content items suitable
for indexing and retrieval in search-mcp.
"""

from typing import List, Dict, Any, Optional
from dataclasses import dataclass
import uuid

# Handle structlog import
try:
    import structlog  # type: ignore[import-untyped]

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


def _dict_val(element: Any, key: str, default: Any = None) -> Any:
    """Extract value from either a dict or an object."""
    if isinstance(element, dict):
        return element.get(key, default)
    return getattr(element, key, default)


class ContentProcessor:
    """Process and structure content from various parsers."""

    def __init__(self):
        self.logger = logger

    def _generate_item_id(self) -> str:
        """Generate unique item ID."""
        return f"item-{uuid.uuid4().hex}"

    async def process(self, parse_result: Any) -> List[ContentItem]:
        """
        Process parse result into structured content items.

        Args:
            parse_result: ParseResult from parser (always has .elements list)

        Returns:
            List of structured content items
        """
        items = []

        try:
            if hasattr(parse_result, "elements") and parse_result.elements:
                items = await self._process_elements(parse_result.elements)
            elif hasattr(parse_result, "markdown"):
                items = await self._process_generic(parse_result)

            self.logger.info(
                f"Content processing complete item_count={len(items)} types={self._count_types(items)}"
            )

        except Exception:
            self.logger.exception("Content processing failed")
            raise

        return items

    async def _process_elements(self, elements: List[Any]) -> List[ContentItem]:
        """Process a list of element dicts into content items."""
        items = []
        current_section = None

        for element in elements:
            try:
                item = self._convert_element(element, current_section)
                if item:
                    items.append(item)

                    # Track section headings for context
                    if item.type == "heading":
                        current_section = item.text

            except Exception as e:
                self.logger.warning(
                    f"Failed to process element type={_dict_val(element, 'type', 'unknown')} error={e}"
                )

        return items

    def _convert_element(
        self, element: Any, section_heading: Optional[str]
    ) -> Optional[ContentItem]:
        """Convert a single element (dict or object) to ContentItem."""
        element_type = _dict_val(element, "type", "text")
        element_text = _dict_val(element, "text", "") or ""

        if element_type in ("heading", "section_header"):
            level = _dict_val(element, "level", 1)
            return ContentItem(
                item_id=self._generate_item_id(),
                type="heading",
                text=element_text,
                markdown=f"{'#' * level} {element_text}",
                metadata={"level": level},
            )

        elif element_type == "text" or element_type == "paragraph":
            return ContentItem(
                item_id=self._generate_item_id(),
                type="text",
                text=element_text,
                markdown=element_text,
                section_heading=section_heading,
            )

        elif element_type == "table":
            # Extract table data from element (can be dict or object form)
            table_data = _dict_val(element, "data", [])
            if isinstance(table_data, dict):
                # Structured table data (Docling: {"cells": [...], "num_rows": N, "num_cols": N})
                cells = table_data.get("cells", [])
                md = self._structured_table_to_markdown(cells)
            elif isinstance(table_data, list):
                # Legacy flat table data
                md = self._table_to_markdown(table_data)
            else:
                md = f"[Table: {element_text}]"

            return ContentItem(
                item_id=self._generate_item_id(),
                type="table",
                text=element_text,
                markdown=md,
                section_heading=section_heading,
                caption=_dict_val(element, "caption", None),
                metadata={
                    "rows": _dict_val(element, "num_rows", 0),
                    "cols": _dict_val(element, "num_cols", 0),
                },
            )

        elif element_type == "image":
            path = _dict_val(element, "path", "")
            caption = _dict_val(element, "caption", "") or ""
            markdown = f"![{caption}]({path})" if path else (f"[Image: {caption}]" if caption else "")
            return ContentItem(
                item_id=self._generate_item_id(),
                type="image",
                text=caption or element_text,
                markdown=markdown,
                caption=caption or None,
                asset_ref=path or None,
                metadata={
                    "width": _dict_val(element, "width", None),
                    "height": _dict_val(element, "height", None),
                    "page_number": _dict_val(element, "page_number", None),
                },
            )

        elif element_type == "equation":
            latex = _dict_val(element, "latex", element_text)
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

    def _structured_table_to_markdown(self, cells: list) -> str:
        """Convert structured table cells (from Docling) to markdown."""
        if not cells:
            return ""

        # Discover dimensions
        max_row = 0
        max_col = 0
        for cell in cells:
            end_row = _dict_val(cell, "row_end", 0) if isinstance(cell, dict) else getattr(cell, "end_row_offset_idx", 0)
            end_col = _dict_val(cell, "col_end", 0) if isinstance(cell, dict) else getattr(cell, "end_col_offset_idx", 0)
            max_row = max(max_row, end_row)
            max_col = max(max_col, end_col)

        if max_row == 0 or max_col == 0:
            return ""

        # Build grid
        grid = [["" for _ in range(max_col)] for _ in range(max_row)]
        for cell in cells:
            if isinstance(cell, dict):
                text = cell.get("text", "")
                row_start = cell.get("row_start", 0)
                col_start = cell.get("col_start", 0)
                row_end = cell.get("row_end", row_start + 1)
                col_end = cell.get("col_end", col_start + 1)
            else:
                text = getattr(cell, "text", "")
                row_start = getattr(cell, "start_row_offset_idx", 0)
                col_start = getattr(cell, "start_col_offset_idx", 0)
                row_end = getattr(cell, "end_row_offset_idx", row_start + 1)
                col_end = getattr(cell, "end_col_offset_idx", col_start + 1)

            for r in range(min(row_start, max_row), min(row_end, max_row)):
                for c in range(min(col_start, max_col), min(col_end, max_col)):
                    if text and not grid[r][c]:
                        grid[r][c] = text

        lines = []
        for r, row in enumerate(grid):
            cells_str = " | ".join(cell if cell else "" for cell in row)
            lines.append(f"| {cells_str} |")
            if r == 0 and max_row > 1:
                lines.append("|" + "|".join(" --- " for _ in row) + "|")

        return "\n".join(lines)

    def _table_to_markdown(self, table_data: list) -> str:
        """Convert flat table data to markdown format."""
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

    async def _process_generic(self, parse_result: Any) -> list:
        """Process generic parser output (fallback)."""
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
