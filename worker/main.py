"""Worker entrypoint: consume transcription jobs from RabbitMQ.

Pipeline per message: probe -> normalize -> transcribe -> save -> ack.
Ack happens only after the result is durably committed to Postgres.
M3 failure handling marks the job failed; retry/backoff lands in M4.
"""

import asyncio
import functools
import json
import tempfile
from pathlib import Path

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

import audio
import transcriber
from db import Database
from log import configure_logging, get_logger
from queue_topology import declare_topology
from settings import Settings, load_settings

logger = get_logger("worker")

PROGRESS_REPORT_STEP = 0.1


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

    def report(fraction: float) -> None:
        nonlocal last_reported
        if fraction - last_reported >= PROGRESS_REPORT_STEP:
            last_reported = fraction
            asyncio.run_coroutine_threadsafe(
                db.update_progress(job_id, round(fraction, 2)), loop
            )

    return report


async def handle_message(
    message: AbstractIncomingMessage, db: Database, settings: Settings
) -> None:
    try:
        payload = json.loads(message.body)
        job_id: str = payload["jobId"]
        file_path: str = payload["filePath"]
    except (json.JSONDecodeError, KeyError, TypeError):
        logger.error("malformed message, parking in DLQ body=%r", message.body[:200])
        await message.nack(requeue=False)
        return

    try:
        status = await db.get_status(job_id)
    except Exception as exc:
        logger.error("could not read job status jobId=%s: %s", job_id, exc)
        await message.nack(requeue=False)
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
        try:
            await db.fail(job_id, str(exc))
            await message.ack()
        except Exception:
            logger.exception("could not persist failure jobId=%s", job_id)
            await message.nack(requeue=True)  # let redelivery retry the whole job


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
            logger.info("topology declared, consuming queue=%s", settings.jobs_queue)

            handler = functools.partial(handle_message, db=db, settings=settings)
            await topology.jobs_queue.consume(handler)
            await asyncio.Future()  # run until cancelled
    finally:
        await db.close()


def main() -> None:
    configure_logging()
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("shutdown requested, exiting")


if __name__ == "__main__":
    main()
