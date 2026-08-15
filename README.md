

The system uses a Go backend, Postgres source of truth, project-scoped WebSocket sync, cursor-paginated task loading, per-task comments, archived projects, task dependencies, a board-level dependency graph, and a project analytics dashboard.

## Demo Video

[Watch the demo video on Google Drive](https://drive.google.com/file/d/1zoY5TJNwym9ZJQq5NP2Sav28UWgy-wck/view?usp=sharing)

Fallback: [download demo.mp4](./demo.mp4)

## Deliverables Checklist

- Working Go backend API.
- Working Next.js frontend.
- Local Postgres via Docker Compose.
- CI configured with backend tests, frontend typecheck/build, and dependency audit.
- Architecture, synchronization, scaling, tradeoffs, technology choices, and data flow documented below.

## Requirements

- Go 1.22+
- Node 20.9+
- Docker Desktop for local Postgres

## Quick Start

Start Postgres:

```bash
docker compose up -d postgres
```

Run the backend:

```bash
cd backend
go run ./cmd/api
```

Run the frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Backend health check:

```bash
curl http://localhost:8080/healthz
```

## Environment

Backend defaults:

```text
HTTP_ADDR=:8080
DATABASE_URL=postgres://happyrobot:happyrobot@localhost:55432/happyrobot?sslmode=disable
```

Frontend defaults:

```text
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8080
```

Example files are included:

- `backend/.env.example`
- `frontend/.env.example`

## Verification

Backend:

```bash
cd backend
GOCACHE=/private/tmp/happyrobot-go-cache go test ./...
```

Frontend:

```bash
cd frontend
npm run typecheck
npm run build
npm audit --omit=dev
```

CI runs the same core checks in `.github/workflows/ci.yml`.

Current coverage status:

- Unit tests: backend status rules, cursor encode/decode, pagination options, and selected HTTP handler behavior.
- Integration tests: not complete; Postgres transaction/event integration tests are a next step.
- E2E tests: not complete; Playwright/Cypress user journey tests are a next step.

## High-Level Design

The core design goal is to support large project payloads without resending entire project documents after every small update. The app treats Postgres as the source of truth, stores every syncable mutation in an append-only project event log, and broadcasts small project-scoped delta events over WebSocket.

Detailed architecture notes are in [docs/architecture.md](docs/architecture.md), and endpoint examples are in [docs/api.md](docs/api.md). The README keeps the review-ready summary, while the docs files provide deeper implementation details.

```text
                HTTP requests                         SQL transactions
Next.js UI  ---------------------->  Go API  ---------------------------->  Postgres
   |                                  |                                      |
   |                                  | writes domain rows                   |
   |                                  | writes project_events                |
   |                                  | commits atomically                   |
   |                                  v                                      |
   |                           WebSocket Hub                                 |
   |                                  |                                      |
   +<--------- project-scoped delta events ---------------------------------+
```

Summary:

- **Backend**: Go API handles validation, transactions, event creation, and WebSocket fanout.
- **Database**: Postgres stores projects, tasks, comments, normalized task dependencies, and `project_events`.
- **Sync**: Mutations write state and event records atomically, then publish small delta events to connected clients.
- **Scale basics**: Cursor pagination for tasks, per-task comments, virtualized board columns, and project-version replay.
- **No managed realtime DB**: realtime behavior is implemented in the Go backend using Postgres-backed events and WebSocket rooms.

## Main Features

- Project create/edit/archive/restore/delete.
- Permanent delete warning for destructive project deletion.
- Task create modal with title, summary, status, priority, and initial dependencies.
- Task edit for title, summary, status, dependencies, and comments.
- Drag-and-drop task status changes.
- Per-task comments with editable content while preserving author/timestamp.
- Board-level dependency graph with topology-aware default layout and draggable nodes.
- Project analytics dashboard for progress, blockers, and status distribution.
- Virtualized task columns so only visible task cards render.
- WebSocket delta sync and event replay by project version.

## Technology Choices

- **Go** for a simple, fast API/WebSocket backend with clear concurrency behavior.
- **Postgres** for durable relational state, transactions, JSONB metadata/configuration, and normalized dependency edges.
- **Next.js/React** for the interactive board, task modal, dependency graph, and analytics dashboard.
- **Docker Compose** for a minimal local Postgres setup.

## Scaling And Tradeoffs

Already reflected in the implementation:

- Keep project snapshots lightweight.
- Load tasks with cursor pagination.
- Load comments by task.
- Send project-scoped delta events instead of full project payloads.
- Virtualize task columns in the browser.
- Use project version for replay and reconnect recovery.

Known tradeoffs and next steps:

- The current WebSocket hub is in-memory and single-instance. Multi-instance deployment should use Redis Pub/Sub, NATS, or Kafka for fanout.
- The dependency graph is client-side and bounded to loaded tasks. Large projects should add a bounded graph endpoint.
- CI exists, but comprehensive Postgres integration tests and E2E tests are still future work.
- CI is configured; CD/deployment automation is not included yet.
