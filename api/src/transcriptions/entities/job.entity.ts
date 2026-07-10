import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language: string;
  duration: number;
  segments: TranscriptSegment[];
}

/**
 * Source of truth for job state. The API owns this schema; the worker
 * only UPDATEs rows via raw SQL (snake_case column names are the contract).
 */
@Entity('jobs')
export class Job {
  /** Generated in the API before insert so the stored file can be named <id>.<ext>. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text', { default: 'queued' })
  status!: JobStatus;

  @Column('text', { name: 'original_name' })
  originalName!: string;

  @Column('text', { name: 'file_path' })
  filePath!: string;

  /** sha256 of the uploaded bytes, used to dedup completed jobs. */
  @Index()
  @Column('text', { name: 'content_hash', nullable: true })
  contentHash!: string | null;

  @Column('text', { nullable: true })
  language!: string | null;

  @Column('real', { name: 'duration_sec', nullable: true })
  durationSec!: number | null;

  /** 0..1, updated by the worker per processed chunk. */
  @Column('real', { default: 0 })
  progress!: number;

  @Column('int', { default: 0 })
  attempts!: number;

  @Column('text', { nullable: true })
  error!: string | null;

  @Column('jsonb', { nullable: true })
  transcript!: Transcript | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
