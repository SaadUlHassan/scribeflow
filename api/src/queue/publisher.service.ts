import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, ChannelModel, ConfirmChannel } from 'amqplib';
import { EnvironmentVariables } from '../config/env.validation';
import {
  assertTopology,
  EXCHANGE,
  JobMessage,
  ROUTING_KEY_JOB,
} from './topology';

const STARTUP_RETRY_MAX = 30;
const STARTUP_RETRY_DELAY_MS = 2_000;
const RECONNECT_DELAY_MS = 2_000;

@Injectable()
export class PublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherService.name);
  private readonly url: string;
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private shuttingDown = false;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.url = config.get('RABBITMQ_URL', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await this.connection?.close().catch(() => undefined);
  }

  get isConnected(): boolean {
    return this.channel !== null;
  }

  async publishJob(message: JobMessage): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not available');
    }
    const body = Buffer.from(JSON.stringify(message));
    const channel = this.channel;
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EXCHANGE,
        ROUTING_KEY_JOB,
        body,
        { persistent: true, contentType: 'application/json' },
        (err) =>
          err
            ? reject(err instanceof Error ? err : new Error(String(err)))
            : resolve(),
      );
    });
    this.logger.log(`published job message jobId=${message.jobId}`);
  }

  /** The broker may not be ready at startup; healthchecks alone are not enough. */
  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STARTUP_RETRY_MAX; attempt++) {
      try {
        await this.connect();
        this.logger.log(`connected to rabbitmq attempt=${attempt}`);
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `rabbitmq not ready attempt=${attempt}/${STARTUP_RETRY_MAX}: ${String(err)}`,
        );
        await sleep(STARTUP_RETRY_DELAY_MS);
      }
    }
    throw new Error(`could not connect to rabbitmq: ${String(lastError)}`);
  }

  private async connect(): Promise<void> {
    const connection = await connect(this.url);
    connection.on('close', () => {
      this.channel = null;
      this.connection = null;
      if (!this.shuttingDown) {
        this.logger.warn('rabbitmq connection closed, reconnecting');
        void this.reconnectForever();
      }
    });
    // Without listeners, EventEmitter 'error' events crash the process.
    connection.on('error', (err: Error) => {
      this.logger.error(`rabbitmq connection error: ${err.message}`);
    });

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err: Error) => {
        this.logger.error(`rabbitmq channel error: ${err.message}`);
      });
      // A channel can die while the connection stays up (e.g. broker-side
      // precondition failure). Recycle the whole connection so the close
      // handler above drives a single reconnect path.
      channel.on('close', () => {
        if (!this.shuttingDown && this.channel === channel) {
          this.channel = null;
          void connection.close().catch(() => undefined);
        }
      });
      await assertTopology(channel);
      this.connection = connection;
      this.channel = channel;
    } catch (err) {
      await connection.close().catch(() => undefined);
      throw err;
    }
  }

  private async reconnectForever(): Promise<void> {
    while (!this.shuttingDown && !this.channel) {
      try {
        await this.connect();
        this.logger.log('rabbitmq reconnected');
      } catch (err) {
        this.logger.warn(`rabbitmq reconnect failed: ${String(err)}`);
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
