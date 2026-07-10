# Queue Contract

Contract between the NestJS API (producer) and the Python worker (consumer). Both services declare the topology below idempotently on startup; declarations must stay identical on both sides.

## Message: transcription job

Published by the API to exchange `scribeflow` with routing key `job` after the upload is stored and the job row is inserted.

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "filePath": "/data/audio/550e8400-e29b-41d4-a716-446655440000.mp3",
  "attempt": 0
}
```

| Field | Type | Description |
|---|---|---|
| `jobId` | UUID string | Primary key of the `jobs` row in Postgres |
| `filePath` | string | Absolute path on the shared `/data/audio` volume |
| `attempt` | integer | Delivery attempt counter, starts at 0 |

Messages are persistent (delivery mode 2) and contain **paths only — never audio bytes**. Files travel via the shared Docker volume.

## Topology

```
Exchange: scribeflow (direct, durable)
Exchange: scribeflow.dlx (direct, durable)

Queue: transcription.jobs   ← bind scribeflow / rk "job"
  x-dead-letter-exchange:    scribeflow.dlx
  x-dead-letter-routing-key: dead

Queue: transcription.retry  ← bind scribeflow / rk "retry"
  x-dead-letter-exchange:    scribeflow
  x-dead-letter-routing-key: job        # expired messages re-enter the work queue
  (delay via per-message `expiration`, set by the worker per attempt)

Queue: transcription.dead   ← bind scribeflow.dlx / rk "dead"
  (parked messages for manual inspection; no consumer)
```

Retry semantics (header `x-retry-count`) are implemented in milestone M4 and will be documented here when they land.
