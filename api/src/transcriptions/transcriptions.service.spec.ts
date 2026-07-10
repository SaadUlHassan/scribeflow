import {
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { PublisherService } from '../queue/publisher.service';
import { StorageService } from '../storage/storage.service';
import { Job } from './entities/job.entity';
import { TranscriptionsService } from './transcriptions.service';

const HASH = 'a'.repeat(64);

function multerFile(overrides: Partial<Express.Multer.File> = {}) {
  return {
    originalname: 'sample.mp3',
    mimetype: 'audio/mpeg',
    path: '/data/audio/tmp/temp.upload',
    ...overrides,
  } as Express.Multer.File;
}

describe('TranscriptionsService', () => {
  const jobs = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    create: jest.fn((input: Partial<Job>) => input as Job),
    save: jest.fn(),
    delete: jest.fn(),
    find: jest.fn(),
  };
  const storage = {
    sha256: jest.fn().mockResolvedValue(HASH),
    promote: jest.fn(),
    remove: jest.fn(),
  };
  const publisher = { publishJob: jest.fn() };
  let service: TranscriptionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    storage.sha256.mockResolvedValue(HASH);
    storage.promote.mockImplementation(
      (_tmp: string, id: string, ext: string) =>
        Promise.resolve(`/data/audio/${id}.${ext}`),
    );
    service = new TranscriptionsService(
      jobs as unknown as Repository<Job>,
      storage as unknown as StorageService,
      publisher as unknown as PublisherService,
    );
  });

  describe('create', () => {
    it('rejects unsupported files with 415 and removes the temp file', async () => {
      const file = multerFile({
        originalname: 'notes.txt',
        mimetype: 'text/plain',
      });

      await expect(service.create(file)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
      expect(storage.remove).toHaveBeenCalledWith(file.path);
      expect(jobs.save).not.toHaveBeenCalled();
      expect(publisher.publishJob).not.toHaveBeenCalled();
    });

    it('saves a job row and publishes a message for a new upload', async () => {
      jobs.findOne.mockResolvedValue(null);

      const { job, deduplicated } = await service.create(multerFile());

      expect(deduplicated).toBe(false);
      expect(job.status).toBe('queued');
      expect(job.contentHash).toBe(HASH);
      expect(job.filePath).toBe(`/data/audio/${job.id}.mp3`);
      expect(jobs.save).toHaveBeenCalledWith(job);
      expect(publisher.publishJob).toHaveBeenCalledWith({
        jobId: job.id,
        filePath: job.filePath,
        attempt: 0,
      });
      // Row must exist before the message is published.
      expect(jobs.save.mock.invocationCallOrder[0]).toBeLessThan(
        publisher.publishJob.mock.invocationCallOrder[0],
      );
    });

    it('returns the existing job without publishing when hash matches a completed job', async () => {
      const existing = { id: 'existing-id', status: 'completed' } as Job;
      jobs.findOne.mockResolvedValue(existing);
      const file = multerFile();

      const { job, deduplicated } = await service.create(file);

      expect(deduplicated).toBe(true);
      expect(job).toBe(existing);
      expect(storage.remove).toHaveBeenCalledWith(file.path);
      expect(jobs.save).not.toHaveBeenCalled();
      expect(publisher.publishJob).not.toHaveBeenCalled();
    });

    it('rolls back the job row and file when publishing fails', async () => {
      jobs.findOne.mockResolvedValue(null);
      publisher.publishJob.mockRejectedValue(new Error('broker down'));

      await expect(service.create(multerFile())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(jobs.delete).toHaveBeenCalled();
      expect(storage.remove).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('throws 404 for unknown ids', async () => {
      jobs.findOneBy.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the job when found', async () => {
      const job = { id: 'some-id' } as Job;
      jobs.findOneBy.mockResolvedValue(job);
      await expect(service.findById('some-id')).resolves.toBe(job);
    });
  });
});
