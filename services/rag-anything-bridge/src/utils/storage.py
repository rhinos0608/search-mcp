"""
Storage Manager

Handles storage of extracted assets (images, tables, equations).
Supports local filesystem and S3-compatible object storage.
"""

import hashlib
import json
from pathlib import Path
from typing import Optional, Dict, Any
from dataclasses import dataclass
import asyncio
import aiofiles

try:
    import structlog

    logger = structlog.get_logger()
except ImportError:
    import logging

    logger = logging.getLogger(__name__)


@dataclass
class StorageConfig:
    """Storage configuration."""

    backend: str = "local"  # "local" or "s3"
    local_path: Path = Path("/tmp/rag-anything-assets")
    ttl_seconds: int = 86400  # Default TTL: 24 hours
    # S3 configuration (future)
    s3_bucket: Optional[str] = None
    s3_prefix: str = "rag-anything/"
    s3_region: str = "us-east-1"


class StorageManager:
    """Manages storage of extracted assets."""

    def __init__(self, config: Optional[StorageConfig] = None):
        self.config = config or StorageConfig()
        self._lock = asyncio.Lock()

        # Ensure local storage directory exists
        if self.config.backend == "local":
            self.config.local_path.mkdir(parents=True, exist_ok=True)

        path_str = (
            str(self.config.local_path) if self.config.backend == "local" else None
        )
        logger.info(
            f"Storage manager initialized backend={self.config.backend} path={path_str}"
        )

    def _generate_key(self, content: bytes, extension: str = "") -> str:
        """Generate a content-addressable key."""
        hash_digest = hashlib.sha256(content).hexdigest()[:16]
        if extension:
            return f"{hash_digest}{extension}"
        return hash_digest

    def _get_local_path(self, key: str) -> Path:
        """Get local filesystem path for key."""
        if any(c in key for c in ("/", "\\", "..")):
            raise ValueError(f"Invalid storage key: {key}")
        # Use first 2 chars as subdirectory for distribution
        subdir = key[:2] if len(key) >= 2 else "xx"
        resolved = (self.config.local_path / subdir / key).resolve()
        if not str(resolved).startswith(str(self.config.local_path.resolve())):
            raise ValueError(f"Storage key escapes storage directory: {key}")
        return resolved

    async def store(
        self,
        content: bytes,
        mime_type: str,
        metadata: Optional[Dict[str, Any]] = None,
        extension: str = "",
    ) -> str:
        """
        Store an asset and return its key.

        Args:
            content: Binary content to store
            mime_type: MIME type of the content
            metadata: Optional metadata dictionary
            extension: File extension (e.g., ".png")

        Returns:
            Storage key for the asset
        """
        key = self._generate_key(content, extension)

        async with self._lock:
            if self.config.backend == "local":
                # Local filesystem storage
                file_path = self._get_local_path(key)
                file_path.parent.mkdir(parents=True, exist_ok=True)

                async with aiofiles.open(file_path, "wb") as f:
                    await f.write(content)

                # Write metadata alongside
                if metadata:
                    meta_path = file_path.with_name(file_path.name + ".json")
                    meta_content = {
                        "key": key,
                        "mime_type": mime_type,
                        "size": len(content),
                        "metadata": metadata,
                    }
                    async with aiofiles.open(meta_path, "w") as f:
                        await f.write(json.dumps(meta_content, indent=2))

                logger.debug(f"Asset stored locally key={key} path={file_path}")

            elif self.config.backend == "s3":
                # Future: S3 storage
                raise NotImplementedError("S3 storage not yet implemented")

            else:
                raise ValueError(f"Unknown backend: {self.config.backend}")

        return key

    async def retrieve(self, key: str) -> Optional[bytes]:
        """
        Retrieve an asset by key.

        Args:
            key: Asset storage key

        Returns:
            Binary content or None if not found
        """
        async with self._lock:
            if self.config.backend == "local":
                file_path = self._get_local_path(key)

                if not file_path.exists():
                    return None

                async with aiofiles.open(file_path, "rb") as f:
                    content = await f.read()

                return content

            elif self.config.backend == "s3":
                raise NotImplementedError("S3 storage not yet implemented")

            else:
                raise ValueError(f"Unknown backend: {self.config.backend}")

    async def get_metadata(self, key: str) -> Optional[Dict[str, Any]]:
        """
        Get metadata for an asset.

        Args:
            key: Asset storage key

        Returns:
            Metadata dictionary or None
        """
        async with self._lock:
            if self.config.backend == "local":
                file_path = self._get_local_path(key)
                meta_path = file_path.with_name(file_path.name + ".json")

                if not meta_path.exists():
                    return None

                try:
                    async with aiofiles.open(meta_path, "r") as f:
                        content = await f.read()
                        return json.loads(content)
                except Exception as e:
                    logger.error(f"Failed to read metadata key={key} error={e}")
                    return None

            elif self.config.backend == "s3":
                raise NotImplementedError("S3 storage not yet implemented")

            else:
                raise ValueError(f"Unknown backend: {self.config.backend}")

    async def delete(self, key: str) -> bool:
        """
        Delete an asset.

        Args:
            key: Asset storage key

        Returns:
            True if deleted, False if not found
        """
        async with self._lock:
            if self.config.backend == "local":
                file_path = self._get_local_path(key)
                meta_path = file_path.with_name(file_path.name + ".json")

                deleted = False

                if file_path.exists():
                    file_path.unlink()
                    deleted = True

                if meta_path.exists():
                    meta_path.unlink()

                return deleted

            elif self.config.backend == "s3":
                raise NotImplementedError("S3 storage not yet implemented")

            else:
                raise ValueError(f"Unknown backend: {self.config.backend}")

    async def list_keys(self, prefix: str = "") -> list:
        """List all keys with optional prefix filter."""
        if self.config.backend == "local":

            def _scan():
                keys = []
                search_path = self.config.local_path

                if prefix:
                    if any(c in prefix for c in ("/", "\\", "..")):
                        raise ValueError(f"Invalid prefix: {prefix}")
                    subdir = prefix[:2] if len(prefix) >= 2 else prefix
                    search_path = search_path / subdir

                if search_path.exists():
                    for file_path in search_path.rglob("*"):
                        if not file_path.is_file():
                            continue
                        # Skip metadata files (appended .json)
                        if file_path.name.endswith(".json"):
                            continue

                        key = file_path.name
                        if key.startswith(prefix):
                            keys.append(key)

                return keys

            return await asyncio.to_thread(_scan)

        elif self.config.backend == "s3":
            raise NotImplementedError("S3 storage not yet implemented")

        else:
            raise ValueError(f"Unknown backend: {self.config.backend}")

    def get_stats(self) -> Dict[str, Any]:
        """Get storage statistics."""
        if self.config.backend == "local":
            total_files = 0
            total_size = 0

            if self.config.local_path.exists():
                for file_path in self.config.local_path.rglob("*"):
                    if file_path.is_file():
                        total_files += 1
                        total_size += file_path.stat().st_size

            return {
                "backend": self.config.backend,
                "total_files": total_files,
                "total_size_bytes": total_size,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "path": str(self.config.local_path),
            }

        return {
            "backend": self.config.backend,
            "total_files": 0,
            "total_size_bytes": 0,
        }
