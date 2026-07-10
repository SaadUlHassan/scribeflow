import type { Channel } from 'amqplib';

/**
 * Queue contract shared with the Python worker — see shared/message-schema.md.
 * Declarations here must stay identical to worker/queue_topology.py.
 */
export const EXCHANGE = 'scribeflow';
export const DLX_EXCHANGE = 'scribeflow.dlx';
export const JOBS_QUEUE = 'transcription.jobs';
export const RETRY_QUEUE = 'transcription.retry';
export const DEAD_QUEUE = 'transcription.dead';
export const ROUTING_KEY_JOB = 'job';
export const ROUTING_KEY_RETRY = 'retry';
export const ROUTING_KEY_DEAD = 'dead';

export interface JobMessage {
  jobId: string;
  filePath: string;
  attempt: number;
}

export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });

  await channel.assertQueue(JOBS_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DLX_EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEY_DEAD,
    },
  });
  await channel.bindQueue(JOBS_QUEUE, EXCHANGE, ROUTING_KEY_JOB);

  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEY_JOB,
    },
  });
  await channel.bindQueue(RETRY_QUEUE, EXCHANGE, ROUTING_KEY_RETRY);

  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_QUEUE, DLX_EXCHANGE, ROUTING_KEY_DEAD);
}
