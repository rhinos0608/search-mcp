"""
Cache Manager

Handles caching of extraction results using filesystem-based storage.
Future: Can be extended to use Redis or other distributed cache.
"""

import json
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any
import asyncio
import aiofiles

import structlog

logger = structlog.get_logger()


class CacheManager:
    """Manages caching of extraction results."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()

        logger.info("Cache manager initialized", cache_dir=str(cache_dir))

    def _get_cache_path(self, key: str) -> Path:
        """Get filesystem path for cache key."""
        import re

        if not re.fullmatch(r"[0-9a-fA-F]+", key):
            raise ValueError(f"Invalid cache key: {key}")
        if len(key) > 128:
            raise ValueError(f"Cache key too long: {key}")
        subdir = key[:2] if len(key) >= 2 else "xx"
        resolved = (self.cache_dir / subdir / f"{key}.json").resolve()
        if not str(resolved).startswith(str(self.cache_dir.resolve())):
            raise ValueError(f"Cache key escapes cache directory: {key}")
        return resolved

    async def _delete_unlocked(self, key: str) -> bool:
        cache_path = self._get_cache_path(key)
        if not cache_path.exists():
            return False
        try:
            cache_path.unlink()
            return True
        except Exception as e:
            logger.error("Cache delete error", key=key, error=str(e))
            return False

    async def get(self, key: str) -> Optional[Dict[str, Any]]:
        """Get cached result by key."""
        async with self._lock:
            cache_path = self._get_cache_path(key)

            if not cache_path.exists():
                return None

            try:
                async with aiofiles.open(cache_path, "r") as f:
                    content = await f.read()
                    data = json.loads(content)

                expires_at = data.get("expires_at")
                if expires_at:
                    expires = datetime.fromisoformat(expires_at)
                    if expires.tzinfo is None:
                        expires = expires.replace(tzinfo=timezone.utc)
                    if datetime.now(timezone.utc) > expires:
                        await self._delete_unlocked(key)
                        return None

                logger.debug("Cache hit", key=key)
                return data.get("result")

            except Exception as e:
                logger.error("Cache read error", key=key, error=str(e))
                return None

    async def set(
        self,
        key: str,
        result: Dict[str, Any],
        ttl: int = 604800,
    ) -> None:
        """Cache result with TTL."""
        async with self._lock:
            cache_path = self._get_cache_path(key)
            cache_path.parent.mkdir(parents=True, exist_ok=True)

            expires_at = (
                datetime.now(timezone.utc) + timedelta(seconds=ttl)
            ).isoformat()

            data = {
                "key": key,
                "result": result,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": expires_at,
                "ttl": ttl,
            }

            try:
                async with aiofiles.open(cache_path, "w") as f:
                    await f.write(json.dumps(data, indent=2, default=str))
                logger.debug("Cache set", key=key, ttl=ttl)
            except Exception as e:
                logger.error("Cache write error", key=key, error=str(e))

    async def delete(self, key: str) -> bool:
        """Delete cached result."""
        async with self._lock:
            return await self._delete_unlocked(key)

    async def clear(self, older_than: Optional[int] = None) -> int:
        """Clear all cached results, optionally only those older than specified seconds."""
        async with self._lock:
            cleared = 0
            cutoff = (
                datetime.now(timezone.utc) - timedelta(seconds=older_than)
                if older_than
                else None
            )

            cache_files = await asyncio.to_thread(
                lambda: list(self.cache_dir.rglob("*.json"))
            )

            for cache_file in cache_files:
                try:
                    if cutoff:
                        stat = await asyncio.to_thread(cache_file.stat)
                        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
                        if mtime > cutoff:
                            continue

                    await asyncio.to_thread(cache_file.unlink)
                    cleared += 1

                except Exception as e:
                    logger.error(
                        "Cache clear error", file=str(cache_file), error=str(e)
                    )

            logger.info("Cache cleared", cleared=cleared, older_than=older_than)
            return cleared

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total_files = 0
        total_size = 0

        for cache_file in self.cache_dir.rglob("*.json"):
            total_files += 1
            try:
                stat = cache_file.stat()
                total_size += stat.st_size
            except Exception:
                pass

        return {
            "total_files": total_files,
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "cache_dir": str(self.cache_dir),
        }
