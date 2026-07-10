import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Job, JobStatus, Transcript } from '../entities/job.entity';

export class CreatedJobDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['queued', 'processing', 'completed', 'failed'] })
  status!: JobStatus;
}

export class JobSummaryDto extends CreatedJobDto {
  @ApiProperty()
  originalName!: string;

  @ApiPropertyOptional({ nullable: true })
  language!: string | null;

  @ApiPropertyOptional({ nullable: true })
  durationSec!: number | null;

  @ApiProperty({ minimum: 0, maximum: 1 })
  progress!: number;

  @ApiProperty()
  attempts!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class JobDetailDto extends JobSummaryDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Present only when status is failed',
  })
  error?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Present only when status is completed',
  })
  transcript?: Transcript | null;
}

export function toJobSummary(job: Job): JobSummaryDto {
  return {
    id: job.id,
    status: job.status,
    originalName: job.originalName,
    language: job.language,
    durationSec: job.durationSec,
    progress: job.progress,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function toJobDetail(job: Job): JobDetailDto {
  return {
    ...toJobSummary(job),
    ...(job.status === 'failed' ? { error: job.error } : {}),
    ...(job.status === 'completed' ? { transcript: job.transcript } : {}),
  };
}
