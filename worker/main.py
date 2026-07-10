"""Worker entrypoint: consume transcription jobs from RabbitMQ.

M1 scope: connect with retry/backoff, declare topology, log consumed messages.
"""

import asyncio
import json

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

from log import configure_logging, get_logger
from queue_topology import declare_topology
from settings import Settings, load_settings

logger = get_logger("worker")


async def connect_with_retry(settings: Settings) -> AbstractRobustConnection:
    """The broker may not be ready at startup; healthchecks alone are not enough."""
    last_error: Exception | None = None
    for attempt in range(1, settings.startup_retry_max + 1):
        try:
            connection = await aio_pika.connect_robust(settings.rabbitmq_url)
            logger.info("connected to rabbitmq attempt=%d", attempt)
            return connection
        except Exception as exc:  # noqa: BLE001 - retry any connection failure
            last_error = exc
            logger.warning(
                "rabbitmq not ready attempt=%d/%d: %s",
                attempt,
                settings.startup_retry_max,
                exc,
            )
            await asyncio.sleep(settings.startup_retry_delay_sec)
    raise RuntimeError(f"could not connect to rabbitmq: {last_error}")


async def handle_message(message: AbstractIncomingMessage) -> None:
    """M1: log and ack. Transcription pipeline lands in M3."""
    try:
        payload = json.loads(message.body)
        job_id = payload.get("jobId", "<missing>")
        logger.info("received message jobId=%s payload=%s", job_id, payload)
    except json.JSONDecodeError:
        logger.error("received non-JSON message body=%r", message.body[:200])
    await message.ack()


async def run() -> None:
    settings = load_settings()
    connection = await connect_with_retry(settings)
    async with connection:
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=1)
        topology = await declare_topology(channel, settings)
        logger.info("topology declared, consuming queue=%s", settings.jobs_queue)

        await topology.jobs_queue.consume(handle_message)
        await asyncio.Future()  # run until cancelled


def main() -> None:
    configure_logging()
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("shutdown requested, exiting")


if __name__ == "__main__":
    main()
