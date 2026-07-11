'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface Job {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  originalName: string;
  progress: number;
  durationSec: number | null;
  language: string | null;
  error?: string | null;
  transcript?: { text: string; segments: Segment[] } | null;
}

const POLL_INTERVAL_MS = 2000;
const ACCEPTED = '.wav,.mp3,.m4a,.flac,.ogg,.webm';

function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export default function Home() {
  const [job, setJob] = useState<Job | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (file: File) => {
    setUploadError(null);
    setJob(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/transcriptions', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message ?? `Upload failed (${res.status})`);
      }
      setJob({
        id: body.id,
        status: body.status,
        originalName: file.name,
        progress: 0,
        durationSec: null,
        language: null,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  // Poll while the job is queued or processing.
  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'processing')) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/transcriptions/${job.id}`);
          if (res.ok) {
            const fresh = (await res.json()) as Job;
            setJob((current) => (current?.id === fresh.id ? fresh : current));
          }
        } catch {
          // transient poll failure: keep polling
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [job]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) void upload(file);
    },
    [upload],
  );

  const busy = uploading || job?.status === 'queued' || job?.status === 'processing';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-14">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">
          Scribe<span className="text-sky-500">Flow</span>
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Upload audio, get a timestamped transcript. Exports to SRT/VTT.
        </p>
      </header>

      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        aria-disabled={busy}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging
            ? 'border-sky-500 bg-sky-500/10'
            : 'border-neutral-300 hover:border-sky-400 dark:border-neutral-700'
        } ${busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
        <p className="text-lg font-medium">
          {uploading ? 'Uploading…' : 'Drop an audio file here'}
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          or click to browse — wav, mp3, m4a, flac, ogg, webm (max 200 MB)
        </p>
      </section>

      {uploadError && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {uploadError}
        </div>
      )}

      {job && (
        <section className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{job.originalName}</p>
              <p className="text-xs text-neutral-500">{job.id}</p>
            </div>
            <StatusChip status={job.status} />
          </div>

          {(job.status === 'queued' || job.status === 'processing') && (
            <div className="mt-5">
              <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all duration-700"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {job.status === 'queued'
                  ? 'Waiting for a worker…'
                  : `Transcribing — ${Math.round(job.progress * 100)}%`}
              </p>
            </div>
          )}

          {job.status === 'failed' && (
            <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
              {job.error ?? 'Transcription failed'}
            </p>
          )}

          {job.status === 'completed' && job.transcript && (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                <a
                  href={`/api/transcriptions/${job.id}/export?format=srt`}
                  className="rounded-lg bg-sky-500 px-4 py-2 font-medium text-white hover:bg-sky-600"
                  download
                >
                  Download SRT
                </a>
                <a
                  href={`/api/transcriptions/${job.id}/export?format=vtt`}
                  className="rounded-lg border border-neutral-300 px-4 py-2 font-medium hover:border-sky-400 dark:border-neutral-700"
                  download
                >
                  Download VTT
                </a>
                <span className="text-neutral-500">
                  {job.language && `language: ${job.language}`}
                  {job.durationSec ? ` · ${formatClock(job.durationSec)}` : ''}
                  {` · ${job.transcript.segments.length} segments`}
                </span>
              </div>

              <ol className="mt-5 max-h-96 space-y-2 overflow-y-auto pr-2">
                {job.transcript.segments.map((segment) => (
                  <li key={segment.id} className="flex gap-3 text-sm">
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-sky-600 dark:text-sky-400">
                      {formatClock(segment.start)}
                    </span>
                    <span>{segment.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: Job['status'] }) {
  const styles: Record<Job['status'], string> = {
    queued: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    processing: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    completed: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  };
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}
