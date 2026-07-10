import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { EnvironmentVariables } from '../config/env.validation';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly audioDir: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.audioDir = config.get('AUDIO_DIR', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true });
  }

  /** Uploads land here first; same volume as audioDir so promotion is an atomic rename. */
  get tempDir(): string {
    return join(this.audioDir, 'tmp');
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
}
