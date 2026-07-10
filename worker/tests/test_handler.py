from unittest.mock import AsyncMock, MagicMock

import pytest

from main import RETRY_COUNT_HEADER, handle_message
from queue_topology import ROUTING_KEY_DEAD, ROUTING_KEY_RETRY
from settings import Settings

JOB_ID = "550e8400-e29b-41d4-a716-446655440000"
BODY = f'{{"jobId": "{JOB_ID}", "filePath": "/data/audio/f.mp3"}}'.encode()


@pytest.fixture
def settings() -> Settings:
    return Settings(database_url="postgres://x", rabbitmq_url="amqp://x")


@pytest.fixture(autouse=True)
def no_nack_delay(monkeypatch):
    monkeypatch.setattr("main.TRANSIENT_NACK_DELAY_SEC", 0)


def make_message(body=BODY, headers=None):
    message = MagicMock()
    message.body = body
    message.headers = headers or {}
    message.ack = AsyncMock()
    message.nack = AsyncMock()
    return message


def make_db(status="queued"):
    db = MagicMock()
    db.get_status = AsyncMock(return_value=status)
    db.mark_processing = AsyncMock()
    db.complete = AsyncMock()
    db.fail = AsyncMock()
    db.record_retry = AsyncMock()
    return db


def make_topology():
    topology = MagicMock()
    topology.exchange.publish = AsyncMock()
    topology.dlx_exchange.publish = AsyncMock()
    return topology


async def test_completed_job_is_skipped_and_acked(settings):
    message, db, topology = make_message(), make_db("completed"), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    message.ack.assert_awaited_once()
    db.mark_processing.assert_not_awaited()


async def test_malformed_message_parks_in_dlq(settings):
    message, db, topology = make_message(body=b"not json"), make_db(), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    message.nack.assert_awaited_once_with(requeue=False)
    db.get_status.assert_not_awaited()


async def test_unknown_job_parks_in_dlq(settings):
    message, db, topology = make_message(), make_db(status=None), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    message.nack.assert_awaited_once_with(requeue=False)
    db.mark_processing.assert_not_awaited()


async def test_non_uuid_job_id_parks_in_dlq(settings):
    message = make_message(body=b'{"jobId": "not-a-uuid", "filePath": "/f"}')
    db, topology = make_db(), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    message.nack.assert_awaited_once_with(requeue=False)
    db.get_status.assert_not_awaited()


async def test_transient_db_error_requeues(settings):
    message, topology = make_message(), make_topology()
    db = make_db()
    db.get_status = AsyncMock(side_effect=ConnectionError("db unreachable"))

    await handle_message(message, db=db, settings=settings, topology=topology)

    message.nack.assert_awaited_once_with(requeue=True)
    db.mark_processing.assert_not_awaited()


async def test_failure_schedules_retry_with_incremented_header(settings, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("pipeline exploded")

    monkeypatch.setattr("main.run_pipeline", boom)
    message, db, topology = make_message(), make_db(), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    topology.exchange.publish.assert_awaited_once()
    published, kwargs = topology.exchange.publish.await_args
    assert kwargs["routing_key"] == ROUTING_KEY_RETRY
    assert published[0].headers[RETRY_COUNT_HEADER] == 1
    db.record_retry.assert_awaited_once()
    message.ack.assert_awaited_once()
    db.fail.assert_not_awaited()


async def test_exhausted_retries_dead_letter_and_fail(settings, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("pipeline exploded")

    monkeypatch.setattr("main.run_pipeline", boom)
    message = make_message(headers={RETRY_COUNT_HEADER: 3})
    db, topology = make_db(), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    topology.dlx_exchange.publish.assert_awaited_once()
    _, kwargs = topology.dlx_exchange.publish.await_args
    assert kwargs["routing_key"] == ROUTING_KEY_DEAD
    db.fail.assert_awaited_once_with(JOB_ID, "pipeline exploded")
    message.ack.assert_awaited_once()
    topology.exchange.publish.assert_not_awaited()


async def test_corrupted_retry_header_dead_letters(settings, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("pipeline exploded")

    monkeypatch.setattr("main.run_pipeline", boom)
    message = make_message(headers={RETRY_COUNT_HEADER: "garbage"})
    db, topology = make_db(), make_topology()

    await handle_message(message, db=db, settings=settings, topology=topology)

    topology.dlx_exchange.publish.assert_awaited_once()
    db.fail.assert_awaited_once()
    message.ack.assert_awaited_once()
    topology.exchange.publish.assert_not_awaited()
