# ScribeFlow

Event-driven audio transcription platform. Upload an audio file via a REST API, receive a job ID immediately, and poll for the result: a full transcription with per-segment timestamps, exportable as JSON or SRT/VTT.

```
Client ──► NestJS API ──► RabbitMQ ──► Python worker (ffmpeg + faster-whisper) ──► Postgres
Client ◄──────────────── GET /v1/transcriptions/:id ◄──────────────────────────────┘
```

> Work in progress — full documentation lands with the final milestone.

## Quickstart

```bash
cp .env.example .env
docker compose up --build
```

- API: http://localhost:3000 (Swagger at http://localhost:3000/docs)
- RabbitMQ management UI: http://localhost:15672 (credentials in `.env`)
