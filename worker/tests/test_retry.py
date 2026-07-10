import pytest

from retry import Dead, Retry, decide


@pytest.mark.parametrize(
    ("retry_count", "expected_ttl_ms"),
    [(0, 10_000), (1, 30_000), (2, 90_000)],
)
def test_decide_returns_backoff_ttls(retry_count, expected_ttl_ms):
    assert decide(retry_count) == Retry(ttl_ms=expected_ttl_ms)


@pytest.mark.parametrize("retry_count", [3, 4, 100])
def test_decide_dead_letters_after_max_retries(retry_count):
    assert decide(retry_count) == Dead()
