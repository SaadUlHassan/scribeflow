"""Pure retry/backoff decision logic (see shared/message-schema.md)."""

from dataclasses import dataclass

RETRY_TTLS_MS = (10_000, 30_000, 90_000)
MAX_RETRIES = len(RETRY_TTLS_MS)


@dataclass(frozen=True)
class Retry:
    ttl_ms: int


@dataclass(frozen=True)
class Dead:
    pass


Decision = Retry | Dead


def decide(retry_count: int) -> Decision:
    """Map the number of failures already recorded (x-retry-count) to an action."""
    if retry_count < MAX_RETRIES:
        return Retry(ttl_ms=RETRY_TTLS_MS[retry_count])
    return Dead()
