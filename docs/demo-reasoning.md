# Demo Reasoning Notes

This document captures the reasoning behind the architecture in a form that can be reused for the README, final write-up, and 5-minute demo.

## Core Framing

This system is designed around one central constraint: projects may eventually become large, so real-time collaboration cannot depend on repeatedly sending full project payloads.

The backend treats Postgres as the source of truth and uses the Go service to own synchronization. Every meaningful change becomes a small project-scoped domain event. Clients load a snapshot once, then stay updated by applying events.

Short version:

```text
Postgres stores durable state. Go owns transactions, validation, and real-time fanout. Clients receive small project-scoped events instead of full project payloads.
```

## Why Not A Managed Real-Time Database

The prompt explicitly says not to rely on Firebase, Supabase, or another managed real-time database. That does not mean avoiding real-time behavior. It means the application should own the real-time synchronization layer.

In this design:

- Postgres is a regular durable database.
- The Go backend handles writes, transactions, and domain validation.
- The Go backend appends sync events.
- The Go backend broadcasts those events over WebSocket.

That gives us a clear architecture and avoids hiding the most important part of the challenge inside a managed service.

## Why Project-Scoped Delta Events

Project payloads may eventually exceed 2MB. If every small change caused the server to resend the full project, the system would waste bandwidth and create unnecessary latency.

Example:

```text
A user adds one comment to one task.
```

Bad update path:

```text
Send the entire project again, including every task and every comment.
```

Better update path:

```json
{
  "type": "comment.created",
  "projectId": "project_123",
  "entityId": "comment_456",
  "version": 42,
  "payload": {
    "id": "comment_456",
    "taskId": "task_789",
    "content": "Looks good",
    "author": "Amy",
    "timestamp": "2026-07-09T12:00:00Z"
  }
}
```

The client applies the event to only the affected task's comment thread.

Project scope is the right subscription level because users usually collaborate inside one project at a time. A global stream would send unrelated updates. A per-task stream would make subscription management more complex. Project-level rooms are simple, natural, and scalable enough for this challenge.

The project snapshot is intentionally lightweight. It carries project metadata and version information, but large collections are loaded through dedicated endpoints:

- Tasks use `GET /api/projects/{projectId}/tasks?limit=&cursor=`.
- Comments use `GET /api/projects/{projectId}/tasks/{taskId}/comments`.

That keeps the snapshot from quietly becoming the same 2MB+ full project payload the design is trying to avoid.

## Why Cursor Pagination For Tasks

The prompt says project payloads will become large. One likely reason is task count. A project may eventually have thousands or tens of thousands of tasks.

Returning every task from a project endpoint would make initial load slow, memory-heavy, and unnecessary. Most users only need the first screen of tasks immediately. The rest can be fetched as the user scrolls or clicks `Load more`.

The API supports cursor pagination:

```text
GET /api/projects/{projectId}/tasks?cursor=...&limit=50
```

The response is:

```json
{
  "items": [],
  "nextCursor": "opaque-cursor"
}
```

Cursor pagination is preferred over offset pagination for two reasons.

First, offset pagination gets slower as the user moves deeper into a large list. A query like `OFFSET 5000 LIMIT 50` still asks the database to walk past thousands of rows before returning the next page. With cursor pagination, the query can resume from the last seen sort key.

Second, offset pagination can become unstable while data changes. If another user inserts or deletes tasks while the current user is paging, `OFFSET` can skip rows or return duplicates because the list shifted underneath the user. A cursor based on stable fields like `(created_at, id)` gives the backend a deterministic resume point:

```text
Give me the next 50 tasks after this exact task position.
```

In this implementation, the cursor is opaque to the client. The frontend does not need to understand it; it just passes `nextCursor` back to the backend. Internally, the cursor encodes the last task's `created_at` and `id`, which matches the backend ordering:

```sql
ORDER BY created_at ASC, id ASC
```

This pairs naturally with `delta events`. Pagination controls how much initial and historical data we load. `delta events` control how small live updates stay after the page is loaded. Together they avoid both big initial payloads and big real-time payloads.

This also supports the extended performance challenge:

- Backend cursor pagination.
- Database indexes on project and sort keys.
- Frontend virtual scrolling for 10,000+ tasks.

## Why Virtualized Rendering For Large Task Lists

`Cursor pagination` and `virtualized rendering` solve two different scaling problems.

`Cursor pagination` keeps API responses bounded. It makes sure the backend does not send thousands of tasks in one response.

`Virtualized rendering` keeps browser work bounded. Even after the user has loaded many pages of tasks, the frontend should not create thousands of DOM nodes at once. A browser can hold a large JavaScript array, but rendering thousands of cards creates layout, paint, memory, and event-handling cost.

The current frontend uses a dependency-free virtual list per status column. "Dependency-free" means the behavior is implemented directly in React instead of pulling in a package like `react-window` or `react-virtualized`. For this challenge, the custom version is intentionally small:

- Keep a fixed estimated card height.
- Track the column scroll position.
- Compute the visible index range.
- Render only the cards inside that range, plus a small overscan buffer.
- Use spacer height so the scrollbar still represents the full loaded list.

The user experience still feels like one long list, and the UI can still show the full loaded task count. Internally, the browser only renders the cards in and near the visible scroll window.

This matters because large projects create pressure at multiple layers:

- Network/API pressure is handled by `cursor pagination`.
- Real-time update pressure is handled by project-scoped `delta events`.
- Browser rendering pressure is handled by `virtualized rendering`.

Demo wording:

```text
Cursor pagination keeps the API payload bounded.
Virtualized rendering keeps the browser DOM bounded.
Delta events keep live updates bounded.
```

## Why Comments Load By Task Or Bounded Batch

Comments can grow faster than task metadata. A project with hundreds of tasks and long discussion threads could easily make a project snapshot too large.

The initial project view does not load every comment thread in full. Better options:

- Load comments when a task detail panel opens.
- Include only the latest few comments per task.
- Add cursor pagination for long comment threads.

This implementation loads comments when a task detail panel opens. That keeps initial project load fast while still supporting real-time comments for the currently viewed task.

## Why Comment Edits Preserve Author

Comments support editing the content after posting, but the author is immutable. That gives users room to correct wording or add context without rewriting who said it.

The edit path is intentionally narrow:

```text
PATCH /api/projects/{projectId}/tasks/{taskId}/comments/{commentId}
```

The request accepts only:

```json
{
  "content": "updated comment text"
}
```

The backend reloads and returns the original `author` and original `timestamp`, then emits a `comment.updated` project event. Clients apply that event by upserting the comment by ID, the same idempotent pattern used for created comments.

Demo wording:

```text
Comment content is editable.
Comment author is historical identity, so it is not editable.
Edits sync as small comment.updated delta events.
```

## Why Dashboard Metrics Are Server-Side Aggregated

A progress dashboard is useful for monitoring, but it can accidentally violate the large-project constraint if the frontend loads every project, every task, and every comment just to count them.

The dashboard endpoint avoids that:

```text
GET /api/metrics/projects
```

The Go backend asks Postgres for grouped counts and percentages, then returns a compact summary:

- Active project count.
- Archived project count.
- Total tasks and comments.
- Status distribution.
- Per-project completion and blocked percentages.

This keeps the UI fast and keeps the network response bounded. The frontend renders monitoring data, but Postgres does the counting close to the source of truth.

Demo wording:

```text
The dashboard does not load all tasks into the browser.
It asks the backend for aggregate metrics, so monitoring stays cheap even as project data grows.
```

## Why Analytics Is A Separate Page

The task board and monitoring dashboard have different jobs.

The board is an operational workspace for one selected project: create tasks, move cards, comment, archive, and delete. The analytics view is a higher-level monitoring surface across all active projects.

Keeping analytics on its own route has a few benefits:

- The board stays focused and less visually crowded.
- The analytics page can grow into charts, filters, historical trends, team workload, SLA signals, or export controls without making task editing harder.
- The UI hierarchy is clearer: sidebar navigation selects a product area, then each page owns its own layout.
- Metrics can refresh on the analytics page without coupling that behavior to every board mutation.

Demo wording:

```text
The board is for operating one project.
Analytics is for monitoring all projects.
They share the same backend aggregate endpoint, but they are separate product surfaces.
```

## Why Future Realtime Metrics Should Be Coalesced

Some user actions can reach the client through two paths:

- The direct HTTP mutation response, such as `POST /tasks` or `POST /comments`.
- The project-scoped WebSocket event that broadcasts the same committed change.

That is expected in a real-time app. The HTTP response confirms the user's own request. The WebSocket event keeps every connected client, including other tabs, updated from the same event stream.

For local entity state, the client applies updates idempotently with `upsert by ID`, so seeing the same logical task or comment twice does not duplicate it.

For dashboard metrics, the client does not apply the event directly. It refetches the compact aggregate endpoint:

```text
GET /api/metrics/projects
```

If the client refreshed metrics immediately from both the HTTP success path and the WebSocket echo, the data would still be correct, but it could make two nearly identical metrics requests for one user action.

The current analytics page avoids this problem by being a separate monitoring route that loads metrics on page entry and through explicit refresh. It is not subscribed to every board mutation yet.

If we later make analytics live-updating, we should use a tiny coalescing delay. Instead of calling the metrics endpoint immediately every time, the UI would schedule one refresh and reset the timer if another refresh request arrives right away. The result would be:

- The dashboard stays fresh.
- Duplicate HTTP/WebSocket triggers collapse into one aggregate request.
- The realtime model remains simple because every client can still react to WebSocket events.

Demo wording:

```text
HTTP confirms the local write.
WebSocket broadcasts the committed event.
If analytics becomes realtime, coalesce refresh triggers so one logical change usually produces one metrics refetch, not two.
```

## Why Project Version Exists

WebSocket delivers messages while the connection is alive. It does not automatically solve missed updates during disconnects, tab sleep, mobile network changes, or server restarts.

The project-level `version` gives every project mutation a monotonic ordering:

```text
version 41: task.updated
version 42: comment.created
version 43: task.deleted
```

The client tracks `lastSeenVersion`. On reconnect, it can ask:

```text
GET /api/projects/{projectId}/events?afterVersion=41
```

The server replies with events `42+`, and the client catches up without refetching the full project.

This also makes the consistency story easy to explain:

```text
State changes and sync events are committed together. If a live broadcast is missed, the event still exists in Postgres and can be replayed.
```

The frontend keeps `lastSeenVersion` in a ref instead of tying the WebSocket effect directly to React state updates. That avoids reconnecting the socket after every incoming event. The socket lifecycle is scoped to the selected project, while the replay cursor always uses the newest seen version.

Reconnect uses exponential backoff with a small cap. That avoids a tight reconnect loop when the backend is down, but still recovers quickly from normal laptop sleep, tab backgrounding, or a short network interruption.

Demo wording:

```text
The WebSocket is best-effort live delivery.
The project event log is durable recovery.
If the socket drops, reconnect with lastSeenVersion and replay the gap.
```

## Why Optimistic Updates Still Need Rollback

For common edits like changing a task status, the frontend can apply an `optimistic update` immediately. This makes the interface feel collaborative and responsive instead of waiting on a round trip before moving a card.

However, the backend remains the source of truth. A write can still fail because validation rejects it, the task was deleted, the user lost access, or the network drops mid-request. If the frontend leaves the optimistic state in place after a failed write, the UI is lying.

The current UI handles that by:

- Saving the previous task state before applying the optimistic status change.
- Showing a `saving` banner while the mutation is in flight.
- Replacing the optimistic task with the server-confirmed task on success.
- Restoring the previous task and showing a rollback message on failure.

This is intentionally simple for the challenge. The same pattern can later grow into per-card pending indicators, retry actions, or conflict resolution.

Demo wording:

```text
Optimistic update is for responsiveness.
Rollback is for correctness.
The backend stays authoritative.
```

## Why Append-Only Project Events

The `project_events` table is the bridge between durable state and real-time delivery.

Each mutation should happen in one transaction:

```text
BEGIN
  lock project row
  validate operation
  update task/comment/project data
  increment project version
  insert project_events row
COMMIT
publish event to connected clients
```

This gives us:

- Durable event history for reconnect replay.
- A deterministic ordering per project.
- Better debugging and auditability.
- A future path to activity feeds and undo/redo.

The live WebSocket broadcast is deliberately after commit. If broadcasting fails, the database remains correct and clients can recover from the event log.

## Why Project Delete Is Permanent In The MVP

Project delete cascades to tasks, task dependencies, comments, and project events. That keeps the data model simple and avoids orphaned records, but it also means project delete is not recoverable in this MVP.

For that reason, the UI warns users that deleting a project is permanent and cannot be recovered. A production system could replace hard delete with `soft delete`, retention windows, or a separate global audit log if recovery is required.

## Why Add Project Archive

Archive is the safer default user action when someone wants to clean up the project list without destroying data.

In this implementation, archive sets `projects.archived_at` and emits a `project.archived` delta event. The default project list can show only active projects, while `GET /api/projects?includeArchived=true` lets the UI render a collapsible recovery section. Tasks, comments, and event history remain in Postgres.

That gives us a better product split:

- `Archive` means hide from the active workspace while preserving the project data.
- `Restore` / `Unarchive` clears `archived_at` and moves the project back to the active workspace.
- `Delete` means permanent destructive cleanup, and the UI warns the user before doing it.

This also fits the scale constraints. Archiving and restoring each send one small project-scoped delta event instead of resending the full project payload.

## Why WebSocket

Server-Sent Events would work for simple server-to-client notifications, and polling would be the simplest fallback. WebSocket is the strongest fit here because the system is collaborative and likely to grow into bidirectional real-time features.

WebSocket supports:

- Task and comment updates.
- Presence indicators.
- Live cursors or selections.
- Client acknowledgements.
- Heartbeats.
- Backpressure handling.
- Future collaborative editing messages.

It also gives the Go backend a clear role: manage project rooms, connected clients, event fanout, and recovery behavior.

## Why Task Creation Uses A Modal

The task model is richer than just a title. A task can have status, priority, summary, dependencies, comments, and later assigned users or custom fields.

The UI originally used a one-line quick-add form. That was fast, but it pushed users into creating incomplete tasks and then immediately opening the task detail panel to fill in the missing context.

The current UI uses a board-level `Create task` modal instead:

- It captures title, summary, status, priority, and initial dependencies together.
- It sends one complete `POST /tasks` payload instead of creating a minimal task and then patching dependencies afterward.
- It makes dependencies visible at the moment a task is created, which is important because dependencies affect workflow order and the board-level graph.
- It keeps the board itself cleaner; the board focuses on task movement and status, while the modal handles structured creation.

Demo wording:

```text
Task creation is intentionally structured, not a tiny quick-add.
Dependencies and summary are part of the task's initial context, so we capture them before the task enters the board.
```

## Why Normalize Task Dependencies

The prompt exposes dependencies as `dependencies[]` on a task. The API can and should keep returning that shape.

Internally, a normalized table is better:

```text
task_dependencies
- task_id
- dependency_id
```

This makes it easier to:

- Validate that dependencies exist.
- Validate that dependencies belong to the same project.
- Prevent deleting a task that other tasks depend on.
- Query blocked tasks or build a dependency graph.
- Support future Gantt or timeline views.

The external API remains prompt-compatible, while the internal model is more robust.

## How Task Dependency Linking Works

The UI lets a user open a task and link it to another loaded task as a dependency. Product-wise, this means:

```text
This task depends on that task.
```

The frontend sends a normal task patch:

```json
{
  "dependencies": ["task_id_123"]
}
```

The backend validates the link before saving it:

- A task cannot depend on itself.
- A dependency must exist.
- A dependency must belong to the same project.
- Duplicate dependency links are rejected.
- Cycles are rejected, so A cannot depend on B if B already depends on A directly or indirectly.

The database stores the relationship in `task_dependencies`, not inside a JSON array. The API still returns `dependencies[]` on each task for prompt compatibility, but internally the normalized table makes validation, deletion checks, and future graph queries cleaner.

When dependencies change, the backend emits a normal `task.updated` delta event. That means all connected clients update the affected task without refetching the whole project.

The UI shows the relationship from both directions:

- `Blocked by`: tasks this selected task depends on.
- `Blocking`: loaded tasks that depend on this selected task.

Only the `dependencies[]` array needs to be stored on the task. The `Blocking` list is derived from other loaded tasks that include the selected task ID in their dependencies. This keeps the persisted model simple while making the relationship understandable from either task.

Example:

```text
If "Two-client WebSocket" is blocked by "Design sync model",
open "Two-client WebSocket" and add "Design sync model" under Blocked by.

Then opening "Design sync model" will show "Two-client WebSocket" under Blocking.
```

The UI hides loaded tasks that would create a dependency cycle. The backend still validates the full graph because the frontend may not have every task loaded due to cursor pagination.

The dependency graph view is board-level, client-side, and bounded to loaded tasks. It uses the task list already in memory and draws a free-form draggable map of the loaded board:

- Nodes are positioned with a small deterministic force-style layout, so the graph feels like a map instead of a rigid table.
- The initial placement is topology-aware: blockers and downstream tasks start naturally separated before the user drags anything.
- The graph entry point lives in the board header because dependencies describe project-wide workflow structure, not just one task's detail panel.
- A selected task can still be highlighted, but opening the graph shows the loaded board instead of filtering to only one task neighborhood.
- Users can drag nodes to untangle crossing lines during a demo or while reasoning through work.
- Arrows point from the blocker to the task it unlocks.

Technical choices:

- The graph first computes a `rank` for each loaded task. Tasks with no loaded blockers are rank 0; tasks depending on rank 0 tasks become rank 1; deeper downstream tasks get higher ranks. This gives the graph a natural left-to-right flow without forcing a rigid column UI.
- Nodes are initially placed by rank, then given deterministic jitter from the task ID. That keeps repeated renders stable while avoiding a too-perfect grid.
- A small force-style cleanup pass runs after initial placement. It only nudges overlapping cards apart and gently keeps connected tasks at a readable distance. This avoids pulling the whole graph into a tight cluster.
- Edge paths are calculated from the actual task-card rectangle boundary, not from rough center points. The arrow starts just outside the blocker card and ends just before the blocked card, so lines do not run through the cards.
- The graph remains dependency-free. We avoid adding a heavy graph layout library for the MVP, while still leaving room to replace this with a dedicated graph renderer if the project needs large-scale dependency visualization later.

This keeps the graph feature lightweight and consistent with cursor pagination. A larger production version could add a dedicated graph endpoint that returns a bounded neighborhood around a task, such as `depth=2`, without loading every project task.

Demo wording:

```text
Dependencies are links between task records.
They are stored as normalized graph edges, validated transactionally, visualized as an interactive task map, and synced as small task.updated events.
```

## Why JSONB For Metadata And Configuration

The prompt includes flexible fields:

```text
Project.metadata
Task.configuration.customFields
```

These are a natural fit for `jsonb`.

`metadata` may contain project-specific settings. `configuration` has known fields like priority, description, and tags, but `customFields` can vary by use case. JSONB lets the system support this flexibility without creating migrations for every new custom field.

For commonly filtered fields, the system can later add generated columns or targeted indexes.

## Why Transactional Domain Operations

The backend should not let handlers directly perform loose table updates. Mutations should go through domain operations like:

- `CreateTask`
- `UpdateTask`
- `DeleteTask`
- `CreateComment`

Each operation owns validation, database writes, version incrementing, and event creation.

This makes the code easier to reason about and makes the demo stronger: we can explain exactly where consistency is enforced.

## How This Scales Over Time

Single backend instance:

```text
Go process owns WebSocket clients and broadcasts committed events directly.
```

Multiple backend instances:

```text
Each Go instance owns local WebSocket clients.
Committed events are published through Redis Pub/Sub, NATS, or Kafka.
Every instance receives each project event and forwards it to local subscribers.
```

Large datasets:

```text
Task lists use cursor pagination.
Comments load by task or bounded batch.
Real-time events contain deltas.
Frontend renders large task lists with virtualization.
```

Slow clients:

```text
Each connection has a bounded outbound queue.
If a client falls too far behind, disconnect it.
The client reconnects and replays missed events by version.
```

## Five-Minute Demo Narrative

1. Start with the constraint: projects can become large, so the system cannot resend full project payloads for every update.
2. Show the domain model: projects, tasks, comments, plus internal `task_dependencies` and `project_events`.
3. Show one mutation path: update a task, commit the change, insert an event, broadcast the event.
4. Open two browser windows and show that one client receives the other client's update in real time.
5. Explain reconnect recovery: the client stores `lastSeenVersion` and can replay missed events.
6. Close with scale path: cursor pagination, bounded comments, WebSocket rooms, Redis/NATS/Kafka for multi-instance fanout.

## One-Sentence Summary

We use project-scoped delta events to minimize transmitted data, cursor pagination and bounded comment loading to handle large projects, project versions for deterministic reconnect recovery, and WebSockets because the system is collaborative and likely to grow into bidirectional real-time features.
