"""Job row updates via asyncpg. The API owns the schema; the worker only reads/updates."""

import asyncio
import json
from typing import Any

import asyncpg

from log import get_logger
from settings import Settings

logger = get_logger("db")


class Database:
    def __init__(self, settings: Settings) -> None:
        self._dsn = settings.database_url
        self._retry_max = settings.startup_retry_max
        self._retry_delay = settings.startup_retry_delay_sec
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        """Postgres may not be ready at startup; healthchecks alone are not enough."""
        last_error: Exception | None = None
        for attempt in range(1, self._retry_max + 1):
            try:
                self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=2)
                logger.info("connected to postgres attempt=%d", attempt)
                return
            except Exception as exc:  # retry any connection failure
                last_error = exc
                logger.warning(
                    "postgres not ready attempt=%d/%d: %s", attempt, self._retry_max, exc
                )
                await asyncio.sleep(self._retry_delay)
        raise RuntimeError(f"could not connect to postgres: {last_error}")

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("database not connected")
        return self._pool

    async def get_status(self, job_id: str) -> str | None:
        return await self.pool.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)

    async def mark_processing(self, job_id: str) -> None:
        await self.pool.execute(
            "UPDATE jobs SET status = 'processing', updated_at = now() WHERE id = $1",
            job_id,
        )

    async def update_progress(self, job_id: str, progress: float) -> None:
        # Guarded by status: progress writes are fire-and-forget from the
        # pipeline thread and must never clobber a completed/failed row.
        await self.pool.execute(
            """
            UPDATE jobs SET progress = $2, updated_at = now()
            WHERE id = $1 AND status = 'processing'
            """,
            job_id,
            progress,
        )

    async def complete(self, job_id: str, transcript: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            UPDATE jobs
            SET status = 'completed',
                transcript = $2::jsonb,
                language = $3,
                duration_sec = $4,
                progress = 1,
                error = NULL,
                updated_at = now()
            WHERE id = $1
            """,
            job_id,
            json.dumps(transcript),
            transcript["language"],
            transcript["duration"],
        )

    async def fail(self, job_id: str, error: str) -> None:
        await self.pool.execute(
            "UPDATE jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
            job_id,
            error,
        )
