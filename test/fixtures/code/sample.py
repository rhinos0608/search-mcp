"""Sample Python fixture for code search."""

from dataclasses import dataclass


@dataclass
class SampleConfig:
    name: str

    def label(self) -> str:
        return format_name(self.name)


def format_name(value: str) -> str:
    """Normalize a name for search."""

    def trim_inner(text: str) -> str:
        return text.strip()

    return trim_inner(value).lower()


async def async_format(value: str) -> str:
    return format_name(value)
