# FS Challenge Design Log

This document is the working design record for the challenge. It should stay honest about what exists, why it exists, and what should happen next.

## Product Goal

Build a collaborative task management system that demonstrates scalable real-time synchronization without relying on a managed real-time database.

The important signal is not a large feature checklist. The important signal is that the system has a clear sync model, avoids resending large project payloads, keeps clients consistent, and has a credible path from local demo to production scale.

## Challenge Constraints To Preserve

These constraints should stay visible throughout the implementation:

- Project payloads may eventually be large, including 2MB+ project-level data.
- Updates must be transmitted efficiently. The system should avoid resending entire projects after every change.
- Real-time transport can use WebSockets, server-sent events, polling, or a combination, but the reasoning must be clear.
- Framework and language choices are flexible, but the architecture must be explainable and defensible.

Design implications:

- Treat full project snapshots as initial load or recovery mechanisms, not as the normal update path.
- Use project-scoped domain events for live updates, with payloads limited to the changed entity or patch.
- Add cursor pagination for task lists before treating large projects as solved.
- Load comments by task or in bounded batches so a large project does not force every thread into memory.
- Track project-level `version` so clients can replay missed events instead of refetching everything.
- Prefer WebSocket for the final build because it supports future collaboration features such as presence, cursors, acknowledgements, and bidirectional client messages.

## Design Principles

- Build production-shaped pieces from the start. Avoid temporary in-memory implementations that would later need to be replaced.
- Keep Postgres as the durable source of truth.
- Treat mutations as transactional domain operations, not direct table edits from handlers.
- Emit small domain events after successful writes so clients receive deltas instead of full project snapshots.
- Keep real-time infrastructure owned by the Go backend rather than by Firebase, Supabase, or another managed real-time database.
- Make scale-up paths explicit: connection fanout, event replay, pagination, indexing, rate limiting, and multi-instance delivery.
- Validate continuously. After each meaningful backend slice, run formatting, unit tests, and at least one smoke test when the local toolchain is available.

## Testing Cadence

During implementation, testing should happen throughout the work, not only at the end of a milestone.

Backend checks:

- Run `gofmt` after each code-editing slice.
- Run `go test ./...` after each store, HTTP, or realtime change.
- Run focused tests first when iterating on a small package, such as `go test ./internal/store`.
- Run an API smoke test after backend routes compile: health check, create project, create task, update task, add comment, replay events.
- Before moving to frontend work, verify the backend against a real Postgres instance from Docker Compose.

Frontend checks, once added:

- Run typecheck and lint after each substantial UI/API integration slice.
- Run a two-client local demo after WebSocket integration.
- Verify reconnect replay by disconnecting one client, making changes, then reconnecting with `lastSeenVersion`.

Current environment caveat:

This Codex environment currently does not have `go` or `gofmt`, and Docker daemon is not running. Until that is fixed, testing commands must be treated as pending verification rather than completed verification.

## Recommended High-Level Architecture

```text
Next.js frontend
  |
  | REST: snapshots, CRUD, pagination
  | WebSocket: project-scoped real-time events
  v
Go backend
  |
  | transactional writes
  | domain validation
  | event append
  v
Postgres
  |
  | project_events replay
  v
Go real-time hub
```

## Backend Stack

- Language: Go
- HTTP router: Go standard library initially, with room to move to Chi if route complexity grows.
- Database driver: `pgx`
- Database: Postgres
- Real-time transport: WebSocket for final implementation
- Local development: Docker Compose for Postgres

## Why Go Backend

Go is a strong fit for this challenge because it lets us show backend engineering directly:

- Long-lived real-time connections are natural to model with goroutines and channels.
- Transaction boundaries are explicit.
- The domain model can stay compact and readable.
- Scaling the WebSocket layer can be discussed concretely: one process, then Redis Pub/Sub or NATS for multiple instances.

## Data Model

The external domain model should follow the challenge prompt directly:

```text
Projects (
  id,
  name,
  description,
  metadata
)

Tasks (
  id,
  projectId,
  title,
  status,
  assignedTo[],
  configuration: {
    priority,
    description,
    tags[],
    customFields
  },
  dependencies[]
)

Comments (
  id,
  taskId,
  content,
  author,
  timestamp
)
```

Internally, the database can expand this model slightly to support validation, synchronization, and scale:

- `projects`: project metadata and project-level version.
- `tasks`: task content, status, assignees, configuration, and version.
- `task_dependencies`: normalized dependency edges between tasks.
- `comments`: task comment threads.
- `project_events`: append-only event log used for replay and synchronization.

Proposed database mapping:

```text
projects
- id
- name
- description
- metadata jsonb
- version
- created_at
- updated_at

tasks
- id
- project_id
- title
- status
- assigned_to jsonb
- configuration jsonb
- version
- created_at
- updated_at

task_dependencies
- task_id
- dependency_id

comments
- id
- task_id
- content
- author
- timestamp

project_events
- id
- project_id
- event_type
- entity_id
- version
- payload jsonb
- created_at
```

Important modeling choices:

Task dependencies should be normalized in `task_dependencies`, not stored only as an array on `tasks`. This makes dependency validation, reverse lookup, and deletion checks cleaner.

The API should still return `dependencies[]` on each task, so the external model stays faithful to the prompt. The normalization is an implementation detail that gives us better constraints and future graph queries.

`metadata` and `configuration` should use `jsonb`. These fields are intentionally flexible in the prompt, and `configuration.customFields` especially needs room for arbitrary product-specific data without requiring a migration for every new field.

`version` is not part of the prompt, but it is central to the sync design. The project-level version gives every project-scoped mutation a monotonic ordering. Clients can use this to apply events safely, detect missed updates, and replay from `project_events` after reconnecting.

README-ready explanation:

```text
The external domain model follows the challenge prompt directly: Projects, Tasks, and Comments. Internally, task dependencies are normalized into task_dependencies for validation and efficient graph queries, while flexible fields like project metadata and task configuration are stored as JSONB. A project-level version and append-only project_events table are added to support real-time synchronization and reconnect recovery.
```

## Sync Model

Clients use a two-step sync process:

1. Load initial state:

```text
GET /api/projects/{projectId}
```

This returns a snapshot with project metadata, tasks, dependencies, and comments.

2. Subscribe to live updates:

```text
GET /api/projects/{projectId}/ws?lastSeenVersion=123
```

The server sends project-scoped events:

```json
{
  "type": "task.updated",
  "projectId": "project_123",
  "entityId": "task_456",
  "version": 124,
  "payload": {
    "id": "task_456",
    "status": "done"
  },
  "createdAt": "2026-07-09T12:00:00Z"
}
```

The frontend applies events to a normalized local cache. It updates only the affected task or comment instead of refetching the full project.

## Progress Metrics

The progress dashboard is intentionally computed on the backend:

```text
GET /api/metrics/projects
```

It returns aggregate counts for active projects, total tasks, comments, status distribution, completion percentage, and blocked percentage. The frontend uses this summary to render the dashboard without loading every task from every project.

This matters for the same reason cursor pagination matters: if projects become large, a dashboard should not secretly become a full-project export. Postgres is already optimized for grouped counts with indexes, so the backend can compute metrics close to the data and send one bounded response to the UI.

## Consistency Strategy

Every mutating request should follow this pattern:

```text
BEGIN
  lock project row
  validate domain invariants
  write entity changes
  increment project version
  insert project_events row
COMMIT
publish event to connected clients
```

This gives us:

- Atomic persistence of state and event log.
- Monotonic project-level versions.
- A recovery path for clients that disconnect.
- A clear answer to "how do clients stay consistent?"

If event publish fails after commit, the data is still durable. Clients can recover by reconnecting with `lastSeenVersion` and replaying events from `project_events`.

## Real-Time Transport

Final target: WebSocket.

Reasoning:

- The challenge explicitly mentions real-time collaborative behavior.
- WebSocket supports bidirectional extension later, such as presence, cursors, typing indicators, and client acknowledgements.
- It is more impressive for this backend challenge than polling.

SSE is acceptable for simple server-to-client updates, but WebSocket is the stronger final choice for this submission.

## API Shape

Projects:

- `GET /api/projects?includeArchived=true`
- `POST /api/projects`
- `GET /api/projects/{projectId}`
- `PATCH /api/projects/{projectId}`
- `POST /api/projects/{projectId}/archive`
- `POST /api/projects/{projectId}/unarchive`
- `DELETE /api/projects/{projectId}`

Tasks:

- `GET /api/projects/{projectId}/tasks?cursor=&limit=&status=`
- `POST /api/projects/{projectId}/tasks`
- `PATCH /api/projects/{projectId}/tasks/{taskId}`
- `DELETE /api/projects/{projectId}/tasks/{taskId}`

Comments:

- `GET /api/projects/{projectId}/tasks/{taskId}/comments`
- `POST /api/projects/{projectId}/tasks/{taskId}/comments`

Events:

- `GET /api/projects/{projectId}/events?afterVersion=`
- `GET /api/projects/{projectId}/ws?lastSeenVersion=`

## Frontend Strategy

Frontend should be a focused operational tool, not a marketing page.

Core view:

- Project switcher.
- Task list or board with status columns.
- Task detail panel.
- Comments thread.
- Connection state indicator.
- Optimistic update state for edits.

State shape:

- Store tasks by `id`.
- Store comments by `taskId`.
- Apply incoming events by `type` and `entityId`.
- Track `lastSeenVersion` per project.

## Scale Strategy

Large project payloads:

- Snapshot endpoint should be paginated for tasks.
- Comments should load per task or with recent-comment limits.
- Real-time events should be small deltas.

10,000+ tasks:

- Cursor pagination on backend and frontend `Load more` flow.
- Index on `(project_id, status, created_at)` or `(project_id, updated_at)`.
- Frontend virtual scrolling so each status column renders only the visible task cards.

Multiple backend instances:

- Each instance owns local WebSocket connections.
- Committed events are published to Redis Pub/Sub or NATS.
- Every instance receives the event and forwards it to relevant local subscribers.

Backpressure:

- Per-client outbound buffer.
- Drop or disconnect slow clients after bounded queue overflow.
- Clients recover through event replay.

## Bonus Features Worth Doing

Highest ROI:

- Optimistic UI with rollback.
- Event replay after reconnect.
- Cursor pagination.
- Dockerized local setup.
- Integration tests for mutation + event creation.

Lower ROI unless time remains:

- CRDT text editing.
- Live cursors.
- Full undo/redo.
- AI task suggestions.

## Current Repository State

Current files added:

- `backend/go.mod`
- `backend/cmd/api/main.go`
- `backend/internal/domain/models.go`
- `backend/internal/store/postgres.go`
- `backend/internal/httpapi/server.go`
- `backend/internal/realtime/hub.go`
- `backend/migrations/001_init.sql`
- `docker-compose.yml`
- `README.md`
- `docs/design.md`

Important note:

The implementation has been moved away from the quick in-memory/SSE skeleton and toward the production-shaped Postgres/event-log/WebSocket design. The HTTP layer now targets a store interface, the Postgres repository owns transactional mutations and event creation, and the real-time hub uses WebSocket project rooms.

Local caveat:

This Codex environment does not currently have the Go toolchain installed, so `gofmt` and `go test ./...` could not be run here. Before treating Milestone 1 as complete, run those locally and fix any compile or formatting issues.

## Milestone Plan

### Milestone 1: Backend Foundation

Goal:

Have a compiling Go backend with Postgres-backed CRUD, transactional event creation, and WebSocket project subscriptions.

Deliverables:

- Fix migration schema to match the repository design.
- Define a store interface used by HTTP handlers.
- Complete Postgres CRUD for projects, tasks, dependencies, comments, and events.
- Use WebSocket project rooms for live event fanout.
- Add `GET /events?afterVersion=` replay endpoint.
- Add focused backend tests for status validation, dependencies, and event creation.
- Run `go test ./...`.

Current progress:

- Added Postgres-backed store using `pgx`.
- Added transactional mutation flow that writes state changes and appends `project_events`.
- Added normalized `task_dependencies` schema.
- Added project-level `version` to the API model.
- Added HTTP handlers against a store interface rather than an in-memory implementation.
- Added WebSocket project room hub with bounded outbound queues.
- Added event replay endpoint via `GET /api/projects/{projectId}/events?afterVersion=`.
- Added starter unit tests for Kanban status movement, known status validation, and route path parsing.
- Updated README and demo reasoning docs to reflect the Postgres/WebSocket design.
- Moved Docker Postgres host port to `55432` to avoid collisions with local Postgres on `5432`.

Verification status:

- `go mod tidy` completed.
- `gofmt` completed for backend Go files.
- `GOCACHE=/private/tmp/happyrobot-go-cache go build ./...` passed.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed.
- Docker Postgres started from `docker-compose.yml`.
- Host database connection to `postgres://happyrobot:happyrobot@localhost:55432/happyrobot?sslmode=disable` passed.
- API smoke test passed: health, create project, create task, update task, add comment, event replay, and project snapshot.
- WebSocket replay smoke test passed for `lastSeenVersion=0`, receiving `project.created`, `task.created`, `task.updated`, and `comment.created` with versions `1..4`.

Local testing note:

In this sandbox, Go tests need `GOCACHE=/private/tmp/happyrobot-go-cache` because the default Go cache under `~/Library/Caches/go-build` is not writable.

Stop condition:

Stop after the backend compiles and tests pass, then ask for review before frontend work.

### Milestone 2: Frontend MVP

Goal:

Build a usable Next.js frontend that demonstrates real-time collaboration.

Deliverables:

- Project list and project creation.
- Task list or board.
- Task detail panel.
- Task CRUD.
- Comments thread.
- WebSocket subscription and event application.
- Basic optimistic updates.

Current progress:

- Added a Next.js App Router frontend under `frontend/`.
- Added project list and project creation.
- Added task board with status columns.
- Added task creation and status update.
- Added task detail panel with comments.
- Added comment creation.
- Added WebSocket connection using `lastSeenVersion` and project-scoped event application.
- Added normalized frontend state for tasks and comments.
- Added frontend `cursor pagination` loading flow for tasks through `GET /tasks?limit=&cursor=`.
- Added visible connection state and project version.
- Upgraded to `next@16.2.10` and added a `postcss@8.5.16` override to clear production audit findings.

Verification status:

- `npm install` completed.
- `next build` passed using Node 24.14.0.
- `tsc --noEmit` passed.
- `npm audit --omit=dev` reported 0 vulnerabilities.
- Browser verification passed: page loaded at `http://localhost:3000`, showed existing project/task/comment data, and displayed WebSocket state as `connected`.
- Backend `go test ./...` was re-run and passed after frontend integration.
- Two-client `real-time sync` verification passed: two browser tabs were connected, a task was created through the API, and both tabs received the new task through WebSocket updates.

Local testing note:

- The system Node version in this environment is `19.3.0`, but Next 16 requires Node `>=20.9.0`. Use Node 20.9+ locally.

Stop condition:

Stop after two-browser real-time demo works locally.

Status:

- Complete for the current MVP checkpoint.

### Milestone 3: Scale And Polish

Goal:

Make the submission credible for large datasets and strong in review.

Deliverables:

- Cursor pagination.
- Virtualized task list.
- Better error states and connection recovery.
- README architecture write-up.
- Dockerized setup.
- Demo script for the 5-minute walkthrough.

Current progress:

- Added backend `cursor pagination` for `GET /api/projects/{projectId}/tasks?limit=&cursor=`.
- Added `TaskPage` response with `items` and `nextCursor`.
- Added opaque base64 cursor encoding using `(created_at, id)` as the stable ordering key.
- Added frontend `Load more` support wired to the paginated tasks endpoint.
- Added dependency-free frontend `virtualized rendering` for each task status column.
- Added WebSocket reconnect with capped exponential backoff.
- Moved WebSocket replay cursor tracking into a ref so incoming events do not recreate the socket.
- Added user-facing optimistic status update indicators with explicit rollback messaging.
- Added pure unit tests for task cursor encoding/decoding and task page limit bounds.
- Added GitHub Actions CI for backend tests, frontend typecheck/build, and production dependency audit.
- Changed project snapshots to stay lightweight instead of returning all tasks/comments.
- Added frontend per-task comment loading through `GET /tasks/{taskId}/comments`.

Verification status:

- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after pagination changes.
- Frontend `tsc --noEmit` passed after pagination changes.
- Frontend `next build` passed after pagination changes.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after virtualization changes.
- Frontend `tsc --noEmit` passed after virtualization changes.
- Frontend `next build` passed after virtualization changes.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after reconnect changes.
- Frontend `tsc --noEmit` passed after reconnect changes.
- Frontend `next build` passed after reconnect changes.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after optimistic-status UI changes.
- Frontend `tsc --noEmit` passed after optimistic-status UI changes.
- Frontend `next build` passed after optimistic-status UI changes.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after cursor unit tests.
- Frontend `tsc --noEmit` passed after CI workflow changes.
- Frontend `next build` passed after CI workflow changes.
- Frontend `npm audit --omit=dev` passed with 0 vulnerabilities after CI workflow changes.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after lightweight snapshot/per-task comments changes.
- Frontend `tsc --noEmit` passed after lightweight snapshot/per-task comments changes.
- Frontend `next build` passed after lightweight snapshot/per-task comments changes.
- Runtime API smoke test passed against Docker Postgres + local Go API on 2026-07-10.
- Runtime smoke verified lightweight project snapshot, task `cursor pagination`, per-task comment loading, event replay, and WebSocket replay.
- Frontend runtime page smoke passed against local Next dev server on 2026-07-10.
- `GOCACHE=/private/tmp/happyrobot-go-cache go test ./...` passed after project/task delete UI changes.
- Frontend `tsc --noEmit` passed after project/task delete UI changes.
- Frontend `next build` passed after project/task delete UI changes.
- Runtime delete smoke passed for task delete and project delete against local Go API on 2026-07-10.
- Project delete is intentionally permanent in the MVP; the UI warns users that project tasks/comments cannot be recovered.
- Project archive smoke passed against local Go API on 2026-07-10. Archived projects are hidden from the active list, retrievable with `includeArchived=true`, and restorable with `POST /unarchive`.

Stop condition:

Stop when the project is ready for final user review before repo submission.

## Next Recommended Action

Continue Milestone 3 with transaction-boundary integration tests or final README polish.
