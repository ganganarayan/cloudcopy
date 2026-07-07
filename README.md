# Cloud Copy

A cloud data movement platform. Streams files **directly between cloud providers** (MEGA → Google Drive first) through a server on Railway — data never touches disk and never routes through your PC. Close the browser, log out, turn off your machine: transfers keep running and survive server restarts via PostgreSQL checkpoints. Multi-terabyte capable.

## Architecture

```
API Layer (Fastify REST + OpenAPI + WebSockets + /metrics)
Business Layer (services)
Scanner → Inventory → Planner → Execution Plan (versioned)
Transfer Engine (stateless workers: SourceReader → OrderedChunkBuffer → DestinationWriter)
Storage Engine (chunks, checkpoints, integrity, upload sessions, verification, recovery)
Provider SDK → Provider Adapters (mega/, gdrive/, ...)
PostgreSQL (metadata, checkpoints, events) + Redis (queue, heartbeats, pub/sub)
```

- **Never restarts from zero**: destination-committed offsets are checkpointed in Postgres; on boot, open upload sessions are probed and resumed.
- **Provider-agnostic**: adapters declare versioned capabilities; the engine negotiates chunking/upload strategy from a compatibility matrix, never provider names.
- **Event-sourced**: every state change is an immutable row in `events` — audit log, notifications, and daily summaries derive from it.

## Monorepo

| Path | Package | Purpose |
| --- | --- | --- |
| `packages/shared` | `@cloudcopy/shared` | Enums, DTOs, WS event types |
| `packages/provider-sdk` | `@cloudcopy/provider-sdk` | `CloudProvider` contract, `CloudObject`, capabilities, errors, conformance suite |
| `apps/server` | `@cloudcopy/server` | Fastify API, engine, storage, planner, adapters |
| `apps/web` | `@cloudcopy/web` | React + Vite + Tailwind UI (Phase 8) |

## Development

```bash
npm install
docker compose up -d          # postgres + redis (or point DATABASE_URL elsewhere)
cp .env.example .env          # fill CREDENTIALS_KEY: openssl rand -base64 32
npm run db:migrate            # apply migrations + seed provider catalog
npm run dev                   # server on :8080 — /healthz, /metrics, /api/docs
npm test                      # vitest (uses embedded PostgreSQL — no Docker needed)
```

## Build phases (gated)

1. ✅ Foundation — workspaces, schema (17 tables), Fastify skeleton, crypto, logs, events, flags
2. Auth + accounts (Google OAuth, MEGA session-only)
3. Provider adapters + browse + conformance suite
4. 4A Storage Engine · 4B Transfer Engine
5. Planner + resilience (recovery, simulation)
6. Realtime + REST completion
7. Frontend
8. Power features (templates, schedules, sync modes, dedup)
9. Deploy (Docker + Railway)
