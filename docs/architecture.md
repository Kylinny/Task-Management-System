# Architecture Notes

This document provides the deeper architecture details behind the high-level README summary.

## Design Goal

Project payloads may eventually become large, including 2MB+ project documents. The system should avoid resending entire project payloads when a user changes one task, comment, dependency, or project field.

The architecture uses:

- Go API for domain validation, transaction boundaries, and realtime fanout.
- Postgres as durable source of truth.
- Append-only `project_events` for replayable synchronization.
- Project-scoped WebSocket rooms for delta delivery.
- Cursor pagination and bounded loading for large task/comment sets.

## System Flow

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

## Read Path

```text
Projects list
  -> lightweight project snapshot
  -> cursor-paginated task pages
  -> comments loaded per selected task
  -> WebSocket subscription for live deltas
```

The client does not need to fetch every task and every comment before the board becomes usable.

## Write Path

```text
User action
  -> HTTP mutation
  -> backend validation
  -> Postgres transaction
  -> entity row update/insert/delete
  -> project_events insert
  -> commit
  -> WebSocket delta publish
```

The entity change and the event record are written in the same transaction. This keeps realtime sync tied to durable state.

## Reconnect And Replay

Clients track `lastSeenVersion` for the selected project.

```text
Client reconnects
  -> GET /api/projects/{projectId}/events?afterVersion=<lastSeenVersion>
  -> apply missed events by ID
  -> connect to /ws?lastSeenVersion=<latestVersion>
  -> continue receiving live events
```

If replay is insufficient in a future production version, the client can fall back to reloading the lightweight snapshot and current task pages.

## Idempotent Client Updates

The same logical mutation may reach the client through more than one path:

- HTTP mutation response.
- WebSocket event echo.
- Reconnect replay.
- Another browser tab.

The client therefore applies events idempotently:

```text
task.created / task.updated      -> upsert task by ID
task.deleted                     -> delete task by ID
comment.created / comment.updated -> upsert comment by ID
project.updated                  -> replace project fields by ID
```

This prevents duplicate comments/tasks and makes replay safe.

## Data Model Notes

External challenge model:

```text
Projects(id, name, description, metadata)
Tasks(id, projectId, title, status, assignedTo[], configuration, dependencies[])
Comments(id, taskId, content, author, timestamp)
```

Internal additions:

- `project_events`: append-only event log with project version.
- `task_dependencies`: normalized dependency edges.
- `projects.archived_at`: archive/restore support without destructive deletion.

The API still returns `dependencies[]` on each task. Internally, dependencies are normalized so the backend can validate cycles, query reverse links, and support dependency graph features more cleanly.

## Task Loading

Task lists use cursor pagination:

```text
GET /api/projects/{projectId}/tasks?limit=50&cursor=<opaqueCursor>
```

The cursor is opaque to the client and encodes the stable ordering boundary. This avoids offset pagination issues on large or actively changing lists.

The frontend also virtualizes task columns, so the browser renders only visible task cards plus a small overscan buffer instead of rendering thousands of DOM nodes.

## Comment Loading

Comments are loaded per task:

```text
GET /api/projects/{projectId}/tasks/{taskId}/comments
```

This keeps initial project load small and avoids fetching every task discussion thread upfront.

## Dependency Graph

Task dependencies are stored as normalized edges and returned as `dependencies[]`.

The board-level dependency graph is client-side and bounded to loaded tasks. It is dependency-free in the frontend and uses:

- Rank-based topology-aware initial placement.
- Deterministic jitter to avoid a rigid grid.
- Small force-style cleanup to prevent overlap.
- Rectangle-boundary edge routing so arrows connect to card edges instead of card centers.

For very large projects, a production version should add a bounded backend graph endpoint, for example:

```text
GET /api/projects/{projectId}/tasks/{taskId}/dependencies?depth=2
```

## Scaling Path

The current implementation is suitable for a single Go API instance. To scale horizontally:

1. Put the Go API behind a load balancer.
2. Keep Postgres as source of truth.
3. Replace or back the in-memory WebSocket hub with Redis Pub/Sub, NATS, or Kafka.
4. Broadcast committed `project_events` across API instances.
5. Add rate limiting and WebSocket backpressure controls.
6. Add read replicas or materialized views for heavier analytics workloads.

## Tradeoffs

- In-memory WebSocket fanout is simple for the MVP but single-instance.
- Client-side dependency graph is lightweight but only sees loaded tasks.
- Cursor pagination improves scale but means some board-level features operate on the loaded task window.
- CI exists, but full Postgres integration tests and browser E2E tests remain future work.
- CD/deployment automation is not included yet.
