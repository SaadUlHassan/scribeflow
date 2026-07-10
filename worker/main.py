"""Worker entrypoint: consume transcription jobs from RabbitMQ.

Pipeline per message: probe -> normalize -> transcribe -> save -> ack.
Ack happens only after the result is durably committed to Postgres.

Failure handling (see shared/message-schema.md): handled errors are retried
via the TTL retry queue with an incrementing x-retry-count header, then
parked in the dead-letter queue once retries are exhausted. Crash recovery
needs no code: an unacked message is redelivered by the broker.
"""

import asyncio
import concurrent.futures
import functools
import json
import signal
import tempfile
import uuid
from pathlib import Path

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

import audio
import transcriber
from db import Database
from log import configure_logging, get_logger
from queue_topology import ROUTING_KEY_DEAD, ROUTING_KEY_RETRY, Topology, declare_topology
from retry import MAX_RETRIES, Retry, decide
from settings import Settings, load_settings

logger = get_logger("worker")

PROGRESS_REPORT_STEP = 0.1
RETRY_COUNT_HEADER = "x-retry-count"
# Throttles nack(requeue=True) cycles so a persistent infra failure cannot
# spin the prefetch-1 worker in a hot redelivery loop.
TRANSIENT_NACK_DELAY_SEC = 5.0


async def connect_with_retry(settings: Settings) -> AbstractRobustConnection:
    """The broker may not be ready at startup; healthchecks alone are not enough."""
    last_error: Exception | None = None
    for attempt in range(1, settings.startup_retry_max + 1):
        try:
            connection = await aio_pika.connect_robust(settings.rabbitmq_url)
            logger.info("connected to rabbitmq attempt=%d", attempt)
            return connection
        except Exception as exc:  # retry any connection failure
            last_error = exc
            logger.warning(
                "rabbitmq not ready attempt=%d/%d: %s",
                attempt,
                settings.startup_retry_max,
                exc,
            )
            await asyncio.sleep(settings.startup_retry_delay_sec)
    raise RuntimeError(f"could not connect to rabbitmq: {last_error}")


def run_pipeline(
    file_path: str, settings: Settings, on_progress: transcriber.OnProgress
) -> dict:
    """Blocking CPU/subprocess work; runs in a thread so AMQP heartbeats stay alive."""
    audio.probe(file_path)  # reject files without a decodable audio stream early
    with tempfile.TemporaryDirectory(prefix="scribeflow-") as tmp_dir:
        wav_path = audio.normalize(file_path, Path(tmp_dir))
        return transcriber.transcribe(wav_path, settings, on_progress=on_progress)


def make_progress_reporter(
    db: Database, job_id: str, loop: asyncio.AbstractEventLoop
) -> transcriber.OnProgress:
    """Throttled, fire-and-forget progress writes, callable from the pipeline thread."""
    last_reported = 0.0

    def log_failure(future: "concurrent.futures.Future[None]") -> None:
        exc = future.exception()
        if exc is not None:
            logger.warning("progress update failed jobId=%s: %s", job_id, exc)

    def report(fraction: float) -> None:
        nonlocal last_reported
        if fraction - last_reported >= PROGRESS_REPORT_STEP:
            last_reported = fraction
            future = asyncio.run_coroutine_threadsafe(
                db.update_progress(job_id, round(fraction, 2)), loop
            )
            future.add_done_callback(log_failure)

    return report


async def handle_failure(
    message: AbstractIncomingMessage,
    topology: Topology,
    db: Database,
    job_id: str,
    error: str,
) -> None:
    """Route a handled failure: TTL retry queue while attempts remain, DLQ after."""
    headers = dict(message.headers or {})
    try:
        retry_count = int(headers.get(RETRY_COUNT_HEADER, 0))
    except (TypeError, ValueError):
        # Corrupted header: dead-letter rather than risk endless retries.
        retry_count = MAX_RETRIES
    decision = decide(retry_count)

    try:
        if isinstance(decision, Retry):
            retry_message = aio_pika.Message(
                body=message.body,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type="application/json",
                expiration=decision.ttl_ms / 1000,  # aio-pika takes seconds
                headers={**headers, RETRY_COUNT_HEADER: retry_count + 1},
            )
            await topology.exchange.publish(retry_message, routing_key=ROUTING_KEY_RETRY)
            await db.record_retry(job_id, error)
            logger.warning(
                "scheduled retry %d/3 in %dms jobId=%s",
                retry_count + 1,
                decision.ttl_ms,
                job_id,
            )
        else:
            dead_message = aio_pika.Message(
                body=message.body,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type="application/json",
                headers=headers,
            )
            await topology.dlx_exchange.publish(dead_message, routing_key=ROUTING_KEY_DEAD)
            await db.fail(job_id, error)
            logger.error("retries exhausted, parked in DLQ jobId=%s", job_id)
        await message.ack()
    except Exception:
        logger.exception("could not handle failure jobId=%s", job_id)
        await asyncio.sleep(TRANSIENT_NACK_DELAY_SEC)
        await message.nack(requeue=True)  # let redelivery retry the whole job


async def handle_message(
    message: AbstractIncomingMessage,
    db: Database,
    settings: Settings,
    topology: Topology,
) -> None:
    try:
        payload = json.loads(message.body)
        job_id = str(payload["jobId"])
        uuid.UUID(job_id)  # poison guard: DB lookups need a valid uuid
        file_path = str(payload["filePath"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        logger.error("malformed message, parking in DLQ body=%r", message.body[:200])
        await message.nack(requeue=False)
        return

    try:
        status = await db.get_status(job_id)
    except Exception as exc:
        # Transient infra failure (jobId is a valid uuid, so not poison):
        # throttled requeue self-heals once the database is back.
        logger.warning("could not read job status jobId=%s, requeueing: %s", job_id, exc)
        await asyncio.sleep(TRANSIENT_NACK_DELAY_SEC)
        await message.nack(requeue=True)
        return

    if status is None:
        logger.error("unknown job jobId=%s, parking message in DLQ", job_id)
        await message.nack(requeue=False)
        return
    if status == "completed":
        logger.info("job already completed jobId=%s, skipping", job_id)
        await message.ack()
        return

    logger.info("processing jobId=%s file=%s", job_id, file_path)
    try:
        await db.mark_processing(job_id)
        on_progress = make_progress_reporter(db, job_id, asyncio.get_running_loop())
        transcript = await asyncio.to_thread(
            run_pipeline, file_path, settings, on_progress
        )
        await db.complete(job_id, transcript)
        await message.ack()  # only after the transcript is durably committed
        logger.info(
            "completed jobId=%s segments=%d", job_id, len(transcript["segments"])
        )
    except Exception as exc:
        logger.error("job failed jobId=%s: %s", job_id, exc)
        await handle_failure(message, topology, db, job_id, str(exc))


async def run() -> None:
    settings = load_settings()
    db = Database(settings)
    await db.connect()
    try:
        connection = await connect_with_retry(settings)
        async with connection:
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=1)
            topology = await declare_topology(channel, settings)

            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, stop.set)

            # Held while a job is in flight so shutdown can wait for it.
            in_flight = asyncio.Lock()
            base_handler = functools.partial(
                handle_message, db=db, settings=settings, topology=topology
            )

            async def guarded_handler(message: AbstractIncomingMessage) -> None:
                async with in_flight:
                    await base_handler(message)

            consumer_tag = await topology.jobs_queue.consume(guarded_handler)
            logger.info("topology declared, consuming queue=%s", settings.jobs_queue)
            await stop.wait()

            logger.info("shutdown requested, cancelling consumer")
            await topology.jobs_queue.cancel(consumer_tag)
            try:
                await asyncio.wait_for(
                    in_flight.acquire(), timeout=settings.shutdown_grace_sec
                )
                logger.info("in-flight job finished, exiting cleanly")
            except TimeoutError:
                logger.warning(
                    "in-flight job exceeded %.0fs grace; broker will redeliver",
                    settings.shutdown_grace_sec,
                )
    finally:
        await db.close()


def main() -> None:
    configure_logging()
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        # Only reachable before the loop's signal handlers are installed
        # (e.g. Ctrl-C during a startup retry loop).
        logger.info("interrupted during startup, exiting")


if __name__ == "__main__":
    main()
