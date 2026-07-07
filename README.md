# Cloud Copy

Streams files **directly between cloud providers** (MEGA → Google Drive) through a server — data never touches your disk and never routes through your PC. Close the browser or shut off your machine and transfers keep running; they survive server restarts by checkpointing to PostgreSQL. Chunked, resumable, multi-terabyte capable.

## Run it locally (no Docker needed)

```bash
npm install
npm run dev          # server on http://localhost:8080 (auto-starts an embedded PostgreSQL)
npm run dev:web      # in a second terminal → Vite UI on http://localhost:5173
```

`npm run dev` needs no configuration: it spins up a persistent embedded PostgreSQL under `.dev/` and generates a local credentials key. Open **http://localhost:5173**.

- **MEGA**: enter email + password in the Accounts panel → browse and select files/folders on the left.
- **Google Drive**: needs a Google OAuth client (below). Once configured, click **Connect**, pick a destination folder on the right, hit **Transfer**, and watch live progress.

Prefer your own Postgres? Set `DATABASE_URL` and `CREDENTIALS_KEY` (see `.env.example`) and use `npm run dev:external`.

### Google OAuth setup (for Drive)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project → enable **Google Drive API**.
2. OAuth consent screen: External, add your email as a test user.
3. Create an **OAuth client ID** (Web application) with redirect URI
   `http://localhost:8080/api/v1/accounts/gdrive/callback`.
4. Put the id/secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and restart `npm run dev`.

## What works today

- MEGA (session-only auth — password never stored) and Google Drive (OAuth, resumable uploads) provider adapters.
- Streaming transfer engine: bounded chunks, per-chunk checkpoints, **resume after restart** from `committed_offset`, exponential-backoff retries, MEGA→Drive md5 verification.
- Dual-pane browser UI, live progress over WebSocket, pause/resume/cancel/retry, notification bell.
- REST API + OpenAPI at `/api/docs`, Prometheus `/metrics`, `/healthz`.

Verified by 24 automated tests, including an end-to-end engine test that transfers a multi-chunk file, **kills mid-transfer and resumes without re-uploading committed bytes**, and recovers from an injected 429.

## Architecture

```
API (Fastify REST + OpenAPI + WebSocket + /metrics)
Services  →  Scan → job_files
Transfer Engine (Postgres SKIP LOCKED queue → streaming workers with checkpoints)
Provider SDK  →  MEGA / Google Drive adapters
PostgreSQL (metadata, checkpoints, events)
```

The full 17-table schema (inventories, execution plans, upload sessions, events, feature flags, templates, schedules) is in place. Redis-backed queueing, the planner/simulation, sync modes, and templates/schedules are scaffolded in the schema and slot in without migration changes — see [the plan](../../.claude/plans) for the production roadmap.

## Deploy (Railway)

`Dockerfile` + `railway.toml` build a single service that serves the API and the built web app on one origin. Add a Railway **PostgreSQL** plugin (injects `DATABASE_URL`) and set `CREDENTIALS_KEY`, `PUBLIC_URL`, `GOOGLE_CLIENT_ID/SECRET`. For "runs while my PC is off", use a paid always-on service.

## Monorepo

| Path | Package | Purpose |
| --- | --- | --- |
| `packages/shared` | `@cloudcopy/shared` | Enums, DTOs, WS event types |
| `packages/provider-sdk` | `@cloudcopy/provider-sdk` | `CloudProvider` contract, `CloudObject`, capabilities, errors |
| `apps/server` | `@cloudcopy/server` | Fastify API, engine, adapters |
| `apps/web` | `@cloudcopy/web` | React + Vite + Tailwind UI |

## Known limits (pragmatic first pass)

- Single-user (no login wall); every request is the local owner.
- Folder structure at the destination is flattened (files land in the chosen folder); nested re-creation is a follow-up.
- Chunk prefetch is sequential (correct + resumable); parallel MEGA prefetch is a throughput optimization for later.
- MEGA free-tier transfer quotas and Drive's 750 GB/day cap apply — large transfers back off and retry.
