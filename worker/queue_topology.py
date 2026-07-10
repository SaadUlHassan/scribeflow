"""Idempotent RabbitMQ topology declaration.

Must stay in sync with the API's publisher and shared/message-schema.md.
"""

from dataclasses import dataclass

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractExchange, AbstractQueue

from settings import Settings

ROUTING_KEY_JOB = "job"
ROUTING_KEY_RETRY = "retry"
ROUTING_KEY_DEAD = "dead"


@dataclass
class Topology:
    exchange: AbstractExchange
    dlx_exchange: AbstractExchange
    jobs_queue: AbstractQueue
    retry_queue: AbstractQueue
    dead_queue: AbstractQueue


async def declare_topology(channel: AbstractChannel, settings: Settings) -> Topology:
    exchange = await channel.declare_exchange(
        settings.exchange, aio_pika.ExchangeType.DIRECT, durable=True
    )
    dlx_exchange = await channel.declare_exchange(
        settings.dlx_exchange, aio_pika.ExchangeType.DIRECT, durable=True
    )

    jobs_queue = await channel.declare_queue(
        settings.jobs_queue,
        durable=True,
        arguments={
            "x-dead-letter-exchange": settings.dlx_exchange,
            "x-dead-letter-routing-key": ROUTING_KEY_DEAD,
        },
    )
    await jobs_queue.bind(exchange, ROUTING_KEY_JOB)

    retry_queue = await channel.declare_queue(
        settings.retry_queue,
        durable=True,
        arguments={
            "x-dead-letter-exchange": settings.exchange,
            "x-dead-letter-routing-key": ROUTING_KEY_JOB,
        },
    )
    await retry_queue.bind(exchange, ROUTING_KEY_RETRY)

    dead_queue = await channel.declare_queue(settings.dead_queue, durable=True)
    await dead_queue.bind(dlx_exchange, ROUTING_KEY_DEAD)

    return Topology(
        exchange=exchange,
        dlx_exchange=dlx_exchange,
        jobs_queue=jobs_queue,
        retry_queue=retry_queue,
        dead_queue=dead_queue,
    )
