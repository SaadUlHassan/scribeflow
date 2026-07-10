# ScribeFlow — Project Specification

> **Instructions for Claude Code:** This document is the single source of truth for this project. Read it fully before writing any code. We will build this in **milestones** — implement ONLY the milestone I ask for in each session, nothing beyond it. Each milestone must end in a working, committable state that passes its acceptance criteria. Ask me before deviating from any decision in this spec.

---

## 1. What we are building

**ScribeFlow** is an event-driven audio transcription platform. A client uploads an audio file via a REST API, receives a job ID immediately, and polls for the result: a full transcription with **per-segment timestamps**, exportable as JSON or SRT/VTT.

Core design principle: **the API never does heavy work.** Upload handling and transcription are decoupled through a message broker so each side can fail, retry, and scale independently.

```
Client ──► NestJS API (TypeScript)
             │  1. API-key auth, validate upload (type/size)
             │  2. Save audio to shared volume
             │  3. Insert Job row (status: queued) in Postgres
             │  4. Publish {jobId, filePath} → RabbitMQ
             │  5. Return 202 + jobId
             ▼
        RabbitMQ  (manual ack, prefetch=1, retry queue + DLQ)
             ▼
        Python Worker
             │  1. Mark job processing
             │  2. ffmpeg → normalize to 16kHz mono 16-bit WAV
             │  3. faster-whisper (VAD on) → segments with timestamps
             │  4. Long files: chunked processing + global timestamp offsetting
             │  5. Write transcript JSONB + status=completed to Postgres
             │  6. ack  (failure → retry w/ backoff ×3 → dead-letter queue)
             ▼
Client ──► GET /v1/transcriptions/:id   (API reads Postgres only, never the queue)
```

**Job state lives in Postgres, not RabbitMQ.** Messages are transient work signals; the `jobs` table is the source of truth.

---

## 2. Tech stack (fixed — do not substitute)

| Layer | Technology | Notes |
|---|---|---|
| API | **NestJS** (TypeScript, Node 20) | REST, class-validator DTOs, Swagger/OpenAPI enabled |
| Queue | **RabbitMQ 3 (management image)** | amqplib on the Nest side; topology in §5 |
| Worker | **Python 3.11** | `aio-pika` consumer |
| STT | **faster-whisper** | model `small`, CPU, `compute_type="int8"`, `vad_filter=True` |
| Audio | **ffmpeg** (subprocess) | normalize everything to 16kHz mono 16-bit PCM WAV |
| Database | **PostgreSQL 16** | jobs table; transcript stored as JSONB |
| DB access | API: **TypeORM**; Worker: **asyncpg** (raw SQL, no ORM) | keep the worker thin |
| Files | Shared Docker volume `/data/audio` | pass file **paths** in messages, never binary |
| Infra | **Docker Compose** (api, worker, rabbitmq, postgres) | healthchecks + `depends_on: service_healthy` |
| CI | **GitHub Actions** | lint + tests for both services on push/PR |
| Auth | Static API key via `X-API-Key` header | key from env var |
| Tests | API: Jest; Worker: pytest | |

**Do NOT use:** BullMQ, Celery, Redis, Kubernetes, Terraform, cloud SDKs, or the OpenAI hosted API. Local + Compose only. Production-scale concerns go in the README, not the code.

---

## 3. Repository layout

```
scribeflow/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .github/workflows/ci.yml
├── shared/
│   └── message-schema.md          # queue contract documentation
├── samples/                        # 1–2 short sample audio files (mp3 + wav)
├── api/                            # NestJS service
│   ├── src/
│   │   ├── main.ts                 # bootstrap, Swagger, global validation pipe
│   │   ├── app.module.ts
│   │   ├── config/                 # typed env config
│   │   ├── auth/                   # ApiKeyGuard
│   │   ├── transcriptions/
│   │   │   ├── transcriptions.controller.ts
│   │   │   ├── transcriptions.service.ts
│   │   │   ├── dto/
│   │   │   ├── entities/job.entity.ts
│   │   │   └── srt.util.ts         # segments → SRT/VTT
│   │   ├── queue/publisher.service.ts
│   │   └── storage/storage.service.ts   # save/validate uploads
│   ├── test/
│   ├── Dockerfile
│   └── package.json
└── worker/                         # Python service
    ├── main.py                     # aio-pika consumer, ack/retry/DLQ logic
    ├── audio.py                    # validation + ffmpeg normalization
    ├── transcriber.py              # faster-whisper wrapper, chunking, offsets
    ├── db.py                       # asyncpg job/transcript updates
    ├── settings.py                 # env config
    ├── tests/
    ├── Dockerfile                  # includes ffmpeg; pre-downloads whisper model
    └── requirements.txt
```

---

## 4. Data model (Postgres)

Single table. The API owns the schema (TypeORM migration or `synchronize` for dev); the worker only UPDATEs.

```sql
CREATE TABLE jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status         TEXT NOT NULL DEFAULT 'queued',
                 -- queued | processing | completed | failed
  original_name  TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  content_hash   TEXT,                    -- sha256 of upload, for idempotency
  language       TEXT,                    -- detected by whisper
  duration_sec   REAL,
  progress       REAL NOT NULL DEFAULT 0, -- 0..1, updated per chunk
  attempts       INT NOT NULL DEFAULT 0,
  error          TEXT,
  transcript     JSONB,                   -- see shape below
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Transcript JSONB shape:**

```json
{
  "text": "full transcription as one string",
  "language": "en",
  "duration": 143.2,
  "segments": [
    { "id": 0, "start": 0.0, "end": 4.2, "text": "Hello and welcome." },
    { "id": 1, "start": 4.2, "end": 9.87, "text": "Today we discuss..." }
  ]
}
```

Timestamps are seconds (float, 2-decimal precision) relative to the **start of the original file** — chunked processing must offset correctly (§7).

---

## 5. RabbitMQ topology & reliability design

```
Exchange: scribeflow (direct)
├── Queue: transcription.jobs      # main work queue
│     x-dead-letter-exchange: scribeflow.dlx
│     routing key: job
├── Queue: transcription.retry     # delay queue
│     x-message-ttl per publish (10s / 30s / 90s by attempt)
│     x-dead-letter-exchange: scribeflow → routes back to transcription.jobs
└── Queue: transcription.dead      # parked after max attempts, manual inspection
```

**Worker consumption rules:**
- `prefetch_count = 1` (jobs are long and CPU-bound; never hoard messages)
- **Manual ack.** Ack ONLY after transcript is committed to Postgres.
- On handled failure: read `x-retry-count` header (default 0). If `< 3`: publish copy to `transcription.retry` with TTL = `[10s, 30s, 90s][attempt]` and incremented header, then ack the original. If `>= 3`: publish to `transcription.dead`, set job `status=failed` + `error`, ack.
- On worker crash (no ack): RabbitMQ redelivers automatically — this is the crash-recovery path, no code needed beyond idempotency.
- **Idempotency:** on receiving a message, if the job's status is already `completed`, ack immediately and skip. Processing must be safe to re-run from scratch.
- Graceful shutdown: on SIGTERM, stop consuming, finish (or nack+requeue) the in-flight job, close connections.

**Message contract** (document in `shared/message-schema.md`):

```json
{ "jobId": "uuid", "filePath": "/data/audio/<uuid>.<ext>", "attempt": 0 }
```

Never put file bytes in a message. Files travel via the shared volume.

---

## 6. API specification (NestJS)

All endpoints require header `X-API-Key: <key>` (401 otherwise). Global prefix `/v1`. Swagger UI at `/docs`.

| Method & path | Behavior |
|---|---|
| `POST /v1/transcriptions` | Multipart upload, field `file`. Validate: extension ∈ {wav, mp3, m4a, flac, ogg, webm}, MIME sanity check, size ≤ 200 MB (413 if over, 415 if bad type). Compute sha256; if a **completed** job with same hash exists, return that job (dedup). Else save file as `/data/audio/<jobId>.<ext>`, insert job row, publish message, return **202** `{ id, status: "queued" }`. |
| `GET /v1/transcriptions/:id` | Job status + metadata; include `transcript` when completed, `error` when failed. 404 if unknown. |
| `GET /v1/transcriptions/:id/export?format=srt\|vtt` | Render segments as SRT (default) or VTT. 409 if job not completed. |
| `GET /v1/transcriptions?limit&offset` | Paginated list, newest first, transcript omitted. |
| `GET /health` | 200 when DB + broker connections are alive. No auth. |

Error responses use a consistent JSON envelope: `{ statusCode, error, message }` (Nest default is fine).

---

## 7. Transcription pipeline (Python worker)

**`audio.py`**
- `probe(path)` → duration + validity via `ffprobe` (reject files with no audio stream).
- `normalize(path) -> Path`: `ffmpeg -i in -ar 16000 -ac 1 -sample_fmt s16 out.wav`. Any input format, one canonical output. On ffmpeg failure, raise a typed error whose message goes to `jobs.error`. Clean up temp files in `finally`.

**`transcriber.py`**
- Load `WhisperModel("small", device="cpu", compute_type="int8")` **once per process** (module/class level, never per job).
- `transcribe(wav_path, on_progress)` → transcript dict matching §4 shape. Use `vad_filter=True`.
- **Long-file handling:** if duration > `CHUNK_THRESHOLD_SEC` (default 600), split the normalized WAV into chunks of `CHUNK_SEC` (default 300) with ffmpeg, transcribe sequentially, and **add each chunk's start offset to every segment's start/end** before merging. Re-number segment ids globally. Update `jobs.progress = chunks_done / total_chunks` after each chunk. (Cutting on fixed boundaries is acceptable; VAD inside whisper mitigates mid-word cuts — note this tradeoff in the README.)
- The timestamp-offset math MUST have a dedicated unit test (pure function, no model needed — design for that by separating offset/merge logic from inference).

**`main.py`** — connect with retry/backoff on startup (broker may not be ready), declare topology idempotently, consume per §5 rules, wire: probe → normalize → transcribe → save → ack.

---

## 8. Docker Compose requirements

Services: `postgres:16`, `rabbitmq:3-management` (ports 5672 + 15672), `api`, `worker`. Requirements:
- Healthchecks on postgres (`pg_isready`) and rabbitmq (`rabbitmq-diagnostics ping`); api and worker use `depends_on: condition: service_healthy`.
- Both api and worker ALSO implement connection retry loops on startup — healthchecks alone are not sufficient.
- Shared named volume mounted at `/data/audio` in api and worker.
- All config via env vars, `.env.example` documents every variable (API_KEY, DATABASE_URL, RABBITMQ_URL, MAX_UPLOAD_MB, CHUNK_SEC, etc.). No secrets in code.
- Worker Dockerfile: install ffmpeg, and **pre-download the whisper model at build time** (`python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"`) so first job isn't slow and demos are clean.
- Target: `docker compose up --build` → everything runs; `curl` upload works end-to-end.

---

## 9. Testing & CI

**Worker (pytest):** timestamp offset/merge math; audio validation rejects garbage input; normalization produces 16kHz mono WAV (use a tiny generated tone via ffmpeg in a fixture); retry-count/backoff decision logic (pure function). Mock the whisper model in unit tests — never load it in CI.

**API (Jest):** ApiKeyGuard (401 path); upload validation (415 on .txt, 413 on oversize); SRT/VTT formatting util; controller returns 202 and publishes (mock publisher + repo).

**CI (`.github/workflows/ci.yml`):** two jobs — `api` (npm ci, lint, test) and `worker` (pip install, ruff, pytest). Runs on push and PR. Must pass.

---

## 10. Code conventions

- TypeScript: strict mode, ESLint + Prettier defaults, DTO validation via class-validator, no `any`.
- Python: type hints everywhere, `ruff` for lint/format, small pure functions where possible.
- Structured, leveled logging in both services; every log line related to a job includes `jobId`. No `console.log`/`print` in final code.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- No dead code, no commented-out blocks, no TODOs left in final milestones.

---

## 11. Milestone plan

Build strictly in order. **Do not start a milestone until told.** Each ends with green tests, a working `docker compose up`, and a commit.

**M1 — Scaffold & plumbing.** Repo layout, Compose with all 4 services + healthchecks, NestJS skeleton with `/health` and Swagger, Python worker skeleton that connects, declares topology, and logs consumed messages. CI workflow. `.env.example`. *Accept: compose up clean; a message published via RabbitMQ management UI appears in worker logs; CI green.*

**M2 — Upload path.** Storage service (validate + save + sha256), jobs entity/table, `POST /v1/transcriptions` (with dedup), publisher, `GET /v1/transcriptions/:id`, list endpoint, ApiKeyGuard. API tests. *Accept: curl upload → 202 → row in Postgres → message visible in queue; bad file → 415; no key → 401.*

**M3 — Transcription core.** `audio.py`, `transcriber.py` (no chunking yet), `db.py`; wire consumer end-to-end with manual ack. Worker unit tests. *Accept: upload samples/sample.mp3 → poll → completed with correct segments + timestamps; ffprobe-invalid file → failed with clear error.*

**M4 — Reliability.** Retry queue with TTL backoff, retry-count header, DLQ, `attempts` tracking, idempotency skip, prefetch=1 verified, graceful shutdown, health checks include broker. Tests for retry decision logic. *Accept: force a failure (e.g. temporarily corrupt path) → message visits retry queue ×3 → lands in DLQ → job failed with error; kill worker mid-job → redelivery completes it.*

**M5 — Long files + export.** Chunked processing with offset merging and progress updates; `GET .../export?format=srt|vtt`. Offset math + SRT formatting tests. *Accept: a >10 min file (generate by looping a sample with ffmpeg) transcribes with monotonically correct global timestamps; progress advances during processing; SRT downloads and plays in VLC.*

**M6 — Polish & docs.** README (see §12), `shared/message-schema.md`, sample files, final lint/cleanup pass, verify fresh-clone → `docker compose up` → working in ≤ 3 commands. *Accept: a stranger can run it from the README alone.*

**M7 (optional, only if M1–M6 are fully done) — Minimal UI.** Single Next.js + Tailwind page in `web/`: drag-drop upload, status polling with progress bar, transcript rendered as timestamped segments, SRT download button. Added to Compose.

---

## 12. README requirements (written in M6)

Must contain: one-paragraph overview + architecture diagram (ASCII or mermaid); quickstart (≤3 commands + example curl calls with real responses); API reference table; **Design Decisions** section explaining — why event-driven API/worker split, why RabbitMQ over a Redis-backed queue (broker-level acks, DLQ, language-neutral AMQP contract), why NestJS + Python polyglot (TS for API ergonomics, Python for the ML ecosystem), why normalize all audio via ffmpeg to one canonical format, why faster-whisper (open-source, local, native segment timestamps), how chunking + timestamp offsetting works, why job state lives in Postgres not the broker, how retry/DLQ/crash-recovery works, prefetch=1 rationale; **Production Path** section (S3 instead of shared volume with presigned URLs, managed broker, autoscaled GPU workers, observability, rate limiting, webhooks instead of polling); **Limitations**; how to run tests.

Written for a human reviewer. No filler, no marketing tone.

---

## 13. Hard constraints — never violate

1. API never performs transcription or ffmpeg work. Ever.
2. Never put audio bytes in a queue message.
3. Ack only after results are durably committed.
4. Whisper model loads once per worker process, not per job.
5. Everything runs offline/local — no external API calls, no cloud credentials.
6. Every milestone must leave `docker compose up --build` working.
