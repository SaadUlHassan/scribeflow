import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { PublisherService } from '../queue/publisher.service';
import { StorageService } from '../storage/storage.service';
import { extensionOf, validateUpload } from '../storage/upload-validation';
import { Job } from './entities/job.entity';

export interface CreateResult {
  job: Job;
  deduplicated: boolean;
}

@Injectable()
export class TranscriptionsService {
  private readonly logger = new Logger(TranscriptionsService.name);

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    private readonly storage: StorageService,
    private readonly publisher: PublisherService,
  ) {}

  async create(file: Express.Multer.File): Promise<CreateResult> {
    const rejection = validateUpload(file.originalname, file.mimetype);
    if (rejection) {
      await this.storage.remove(file.path);
      throw new UnsupportedMediaTypeException(rejection.reason);
    }

    const contentHash = await this.storage.sha256(file.path);

    const existing = await this.jobs.findOne({
      where: { contentHash, status: 'completed' },
    });
    if (existing) {
      await this.storage.remove(file.path);
      this.logger.log(
        `deduplicated upload jobId=${existing.id} hash=${contentHash.slice(0, 12)}`,
      );
      return { job: existing, deduplicated: true };
    }

    const jobId = randomUUID();
    const filePath = await this.storage.promote(
      file.path,
      jobId,
      extensionOf(file.originalname),
    );

    // Row before message: the worker looks the job up as soon as it consumes.
    const job = this.jobs.create({
      id: jobId,
      status: 'queued',
      originalName: file.originalname,
      filePath,
      contentHash,
    });
    await this.jobs.save(job);

    try {
      await this.publisher.publishJob({ jobId, filePath, attempt: 0 });
    } catch (err) {
      // Nothing consumed yet — undo so the client can safely retry the upload.
      await this.jobs.delete(jobId);
      await this.storage.remove(filePath);
      this.logger.error(`enqueue failed jobId=${jobId}: ${String(err)}`);
      throw new ServiceUnavailableException('Transcription queue unavailable');
    }

    this.logger.log(`accepted upload jobId=${jobId} name=${file.originalname}`);
    return { job, deduplicated: false };
  }

  async findById(id: string): Promise<Job> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) {
      throw new NotFoundException(`No transcription job with id ${id}`);
    }
    return job;
  }

  /** Newest first; transcript column intentionally not selected. */
  async list(limit: number, offset: number): Promise<Job[]> {
    return this.jobs.find({
      select: {
        id: true,
        status: true,
        originalName: true,
        language: true,
        durationSec: true,
        progress: true,
        attempts: true,
        createdAt: true,
        updatedAt: true,
      },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }
}
