# ScribeFlow Web

Minimal Next.js UI for ScribeFlow: drag-drop upload, live status polling with a
progress bar, timestamped transcript view, and SRT/VTT download.

The browser never talks to the ScribeFlow API directly — Next.js route handlers
under `app/api/` proxy every call server-side, so the `API_KEY` never leaves the
server. Env vars: `API_URL` (ScribeFlow API base) and `API_KEY`.

Runs at http://localhost:3001 via `docker compose up` from the repo root, or
`npm run dev` here for local development.
