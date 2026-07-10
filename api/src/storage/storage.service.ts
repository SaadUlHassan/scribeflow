import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readdir, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { EnvironmentVariables } from '../config/env.validation';

/** Uploads land here first; same volume as audioDir so promotion is an atomic rename. */
export function uploadTempDir(audioDir: string): string {
  return join(audioDir, 'tmp');
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly audioDir: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.audioDir = config.get('AUDIO_DIR', { infer: true });
  }

  get tempDir(): string {
    return uploadTempDir(this.audioDir);
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true });
    await this.purgeStaleTempFiles();
  }

  async sha256(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  /** Moves a validated temp upload to its final path, named after the job id. */
  async promote(tempPath: string, jobId: string, ext: string): Promise<string> {
    const finalPath = join(this.audioDir, `${jobId}.${ext}`);
    await rename(tempPath, finalPath);
    return finalPath;
  }

  async remove(filePath: string): Promise<void> {
    await unlink(filePath).catch(() => undefined); // best-effort cleanup
  }

  /** Temp files orphaned by a crash mid-request; safe to clear during init. */
  private async purgeStaleTempFiles(): Promise<void> {
    const entries = await readdir(this.tempDir).catch(() => []);
    if (entries.length > 0) {
      this.logger.warn(`purging ${entries.length} stale temp upload(s)`);
      await Promise.all(entries.map((e) => this.remove(join(this.tempDir, e))));
    }
  }
}
