# HappyRobot Task Management

Collaborative project/task management app for the HappyRobot FS Challenge.

The system uses a Go backend, Postgres source of truth, project-scoped WebSocket sync, cursor-paginated task loading, per-task comments, archived projects, task dependencies, a board-level dependency graph, and a project analytics dashboard.

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

## Architecture Decisions

The core design goal is to support large project payloads without resending entire project documents after every small update.

Key decisions:

- **Go backend** owns API routing, validation, transaction boundaries, event creation, and WebSocket fanout.
- **Postgres** is the durable source of truth for projects, tasks, dependencies, comments, and project events.
- **Append-only `project_events`** records every mutation that should be replayable by clients.
- **Project-scoped WebSocket rooms** send small delta events only to clients viewing that project.
- **Cursor pagination** keeps task list loading bounded for large projects.
- **Per-task comment loading** avoids loading every comment thread with the initial project view.
- **Frontend normalized state** stores tasks/comments by ID so real-time events can be applied idempotently.

## Architecture Flow

```text
                HTTP requests                         SQL transactions
Next.js UI  ---------------------->  Go API  ---------------------------->  Postgres
   |                                  |                                      |
   |                                  | writes domain rows                  |
   |                                  | writes project_events               |
   |                                  | commits atomically                  |
   |                                  v                                      |
   |                           WebSocket Hub                                |
   |                                  |                                      |
   +<--------- project-scoped delta events ---------------------------------+
```

Read path:

```text
Projects list -> lightweight project snapshot -> cursor-paginated tasks -> comments loaded per task
```

Write path:

```text
User action -> HTTP mutation -> validation -> Postgres transaction -> project_events row -> WebSocket delta
```

Realtime sync path:

```text
Client joins project room with lastSeenVersion -> server replays missed events -> live WebSocket events continue
```

Client apply path:

```text
Event received -> inspect event type -> upsert/delete entity by ID -> update normalized local state
```

This is why the app can update a task, dependency, or comment without resending the full project payload.

## Data Model

External challenge model:

```text
Projects(id, name, description, metadata)
Tasks(id, projectId, title, status, assignedTo[], configuration, dependencies[])
Comments(id, taskId, content, author, timestamp)
```

Internal additions:

- `project_events`: append-only event log with project version.
- `task_dependencies`: normalized task dependency edges.
- `projects.archived_at`: archive/restore without deleting data.

The API still returns `dependencies[]` on tasks. Internally, dependencies are normalized so the backend can validate cycles, query reverse links, and support dependency graph features more cleanly.

## Data Flow And Synchronization Strategy

Initial load:

1. Client loads projects with `GET /api/projects?includeArchived=true`.
2. Client selects a project and loads a lightweight project snapshot.
3. Client loads tasks through `GET /api/projects/{projectId}/tasks?limit=&cursor=`.
4. Client loads comments only when a task detail panel opens.

Mutation flow:

1. User changes data through HTTP, for example `POST /tasks`, `PATCH /tasks/{taskId}`, or `POST /comments`.
2. Backend validates the mutation.
3. Backend writes entity state and a `project_events` row in the same Postgres transaction.
4. Backend publishes the event to the project WebSocket room.
5. Clients upsert/delete by entity ID instead of blindly appending.

Reconnect flow:

1. Client tracks `lastSeenVersion`.
2. On reconnect, client asks for missed events with `GET /api/projects/{projectId}/events?afterVersion=`.
3. Client then reconnects to `GET /api/projects/{projectId}/ws?lastSeenVersion=`.
4. If replay is insufficient in a future production version, the client can fall back to a fresh snapshot.

This makes updates efficient because a comment edit or task move transmits only the changed entity/event, not a 2MB+ project payload.

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

## API Sketch

- `GET /api/projects?includeArchived=true`
- `GET /api/metrics/projects`
- `POST /api/projects`
- `GET /api/projects/{projectId}`
- `PATCH /api/projects/{projectId}`
- `POST /api/projects/{projectId}/archive`
- `POST /api/projects/{projectId}/unarchive`
- `DELETE /api/projects/{projectId}`
- `GET /api/projects/{projectId}/tasks?limit=&cursor=`
- `POST /api/projects/{projectId}/tasks`
- `PATCH /api/projects/{projectId}/tasks/{taskId}`
- `DELETE /api/projects/{projectId}/tasks/{taskId}`
- `GET /api/projects/{projectId}/tasks/{taskId}/comments`
- `POST /api/projects/{projectId}/tasks/{taskId}/comments`
- `PATCH /api/projects/{projectId}/tasks/{taskId}/comments/{commentId}`
- `GET /api/projects/{projectId}/events?afterVersion=`
- `GET /api/projects/{projectId}/ws?lastSeenVersion=`

## Technology Choices And Justifications

- **Go**: strong fit for an API/WebSocket service with clear concurrency primitives, simple deployment, and fast tests.
- **Postgres**: durable relational source of truth with transactions, JSONB for flexible metadata/configuration, indexes for project/task access patterns, and normalized dependency edges.
- **Next.js/React**: fast frontend iteration and a clean component model for board state, modals, analytics, and real-time updates.
- **WebSocket**: preferred real-time layer for collaborative updates and future bidirectional features such as presence or live selections.
- **Docker Compose**: minimal local infrastructure for Postgres without requiring a managed real-time database.
- **No managed real-time DB**: sync is owned by the backend through Postgres events and WebSocket fanout.

## Scaling Over Time

Near-term scaling already reflected in the design:

- Keep project snapshots lightweight.
- Load tasks with cursor pagination.
- Load comments by task.
- Send project-scoped delta events instead of full project payloads.
- Virtualize task columns in the browser.
- Use project version for replay and reconnect recovery.

Production scaling path:

- Put the Go API behind a load balancer.
- Back WebSocket fanout with Redis Pub/Sub, NATS, or Kafka so multiple Go instances can broadcast the same project event.
- Add a dedicated bounded dependency graph endpoint, for example `GET /tasks/{taskId}/dependencies?depth=2`.
- Add Postgres read replicas for analytics-heavy reads.
- Add rate limiting and backpressure controls for WebSocket clients.
- Add integration tests with real Postgres and E2E tests for browser workflows.
- Add deployment workflow for backend image publish, frontend hosting, migrations, and environment promotion.

## Tradeoffs

- **In-memory WebSocket hub**: simple and demo-friendly, but single-instance only. Multi-instance needs Redis/NATS/Kafka fanout.
- **Client-side dependency graph**: lightweight and dependency-free, but bounded to loaded tasks. Large graphs should use a backend graph endpoint.
- **Partial test suite**: backend unit tests and CI exist, but comprehensive integration/E2E coverage is not complete yet.
- **Cursor pagination plus loaded-board graph**: good for large projects, but the graph only visualizes tasks currently loaded by the client.
- **No full CD pipeline yet**: CI is configured; production deploy/release automation remains future work.

## Demo Script

1. Start with the constraint: project payloads can become 2MB+, so the app should not resend full projects for small updates.
2. Show Go API + Postgres source of truth + append-only `project_events` + project-scoped WebSocket rooms.
3. Create a project and task. Point out that task creation captures summary and dependencies up front.
4. Open the app in two browser tabs. Move a task or add/edit a comment and show the other tab receiving a small delta event.
5. Show the dependency graph and explain that dependencies are normalized edges.
6. Show analytics and explain that metrics are server-side aggregates.
7. Explain reconnect recovery through `lastSeenVersion` and event replay.
8. Close with the scale path: cursor pagination, bounded comments, virtualized rendering, and Redis/NATS/Kafka fanout for multiple backend instances.

## Repository Submission Steps

From this local repo:

```bash
git status
git add .
git commit -m "Build HappyRobot task management challenge"
```

Create a private GitHub repo, then:

```bash
git remote add origin git@github.com:<your-user>/<private-repo-name>.git
git branch -M main
git push -u origin main
```

Invite collaborators in GitHub:

1. Open the private repo on GitHub.
2. Go to `Settings` -> `Collaborators`.
3. Invite `carlos-happyrobot`.
4. Invite `joaquinllopez00`.

GitHub CLI alternative if authenticated:

```bash
gh repo create <private-repo-name> --private --source=. --remote=origin --push
gh api -X PUT repos/<your-user>/<private-repo-name>/collaborators/carlos-happyrobot -f permission=push
gh api -X PUT repos/<your-user>/<private-repo-name>/collaborators/joaquinllopez00 -f permission=push
```
