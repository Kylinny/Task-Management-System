# API Usage

This document is a developer-facing guide for using the HappyRobot Task Management API locally.

Default local base URLs:

```text
HTTP API: http://localhost:8080
WebSocket: ws://localhost:8080
```

All JSON requests should send:

```text
Content-Type: application/json
```

## Health Check

```bash
curl http://localhost:8080/healthz
```

## Projects

### List Projects

```bash
curl 'http://localhost:8080/api/projects?includeArchived=true'
```

Use `includeArchived=true` when the UI needs both active and archived projects.

### Create Project

```bash
curl -X POST http://localhost:8080/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Launch Plan",
    "description": "Demo workspace",
    "metadata": {}
  }'
```

### Get Project Snapshot

```bash
curl http://localhost:8080/api/projects/{projectId}
```

The snapshot is intentionally lightweight. Tasks are loaded separately through cursor pagination, and comments are loaded per task.

### Update Project

```bash
curl -X PATCH http://localhost:8080/api/projects/{projectId} \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Updated Launch Plan",
    "description": "Updated description"
  }'
```

### Archive Project

```bash
curl -X POST http://localhost:8080/api/projects/{projectId}/archive
```

### Restore Archived Project

```bash
curl -X POST http://localhost:8080/api/projects/{projectId}/unarchive
```

### Permanently Delete Project

```bash
curl -X DELETE http://localhost:8080/api/projects/{projectId}
```

Project delete is permanent in this MVP and cascades to tasks, dependencies, comments, and project events.

## Tasks

### List Tasks With Cursor Pagination

```bash
curl 'http://localhost:8080/api/projects/{projectId}/tasks?limit=50'
```

Response:

```json
{
  "items": [],
  "nextCursor": "opaque-cursor"
}
```

Load the next page:

```bash
curl 'http://localhost:8080/api/projects/{projectId}/tasks?limit=50&cursor={nextCursor}'
```

### Create Task

```bash
curl -X POST http://localhost:8080/api/projects/{projectId}/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Design sync model",
    "status": "todo",
    "assignedTo": [],
    "configuration": {
      "priority": "high",
      "description": "Emit project-scoped delta events instead of full project payloads.",
      "tags": ["sync"],
      "customFields": {}
    },
    "dependencies": []
  }'
```

Supported task statuses:

```text
todo
in_progress
blocked
done
```

### Update Task

Patch only the fields that changed:

```bash
curl -X PATCH http://localhost:8080/api/projects/{projectId}/tasks/{taskId} \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "in_progress"
  }'
```

Update title and summary:

```bash
curl -X PATCH http://localhost:8080/api/projects/{projectId}/tasks/{taskId} \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Implement WebSocket replay",
    "configuration": {
      "priority": "high",
      "description": "Replay missed project events after reconnect.",
      "tags": [],
      "customFields": {}
    }
  }'
```

Update dependencies:

```bash
curl -X PATCH http://localhost:8080/api/projects/{projectId}/tasks/{taskId} \
  -H 'Content-Type: application/json' \
  -d '{
    "dependencies": ["blockingTaskId"]
  }'
```

The backend validates that dependencies exist, belong to the same project, are not self-links, are not duplicates, and do not create dependency cycles.

### Delete Task

```bash
curl -X DELETE http://localhost:8080/api/projects/{projectId}/tasks/{taskId}
```

Task delete is rejected if another task currently depends on it.

## Comments

### List Comments For Task

```bash
curl http://localhost:8080/api/projects/{projectId}/tasks/{taskId}/comments
```

### Create Comment

```bash
curl -X POST http://localhost:8080/api/projects/{projectId}/tasks/{taskId}/comments \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Looks good to me.",
    "author": "Amy"
  }'
```

### Update Comment

```bash
curl -X PATCH http://localhost:8080/api/projects/{projectId}/tasks/{taskId}/comments/{commentId} \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Updated comment text."
  }'
```

Only comment content is editable. The original author and timestamp are preserved.

## Metrics

### Project Progress Dashboard

```bash
curl http://localhost:8080/api/metrics/projects
```

Returns aggregate project progress, status counts, completion percentages, blocked percentages, and comment totals without requiring the frontend to load every task for every project.

## Event Replay

### List Events After Project Version

```bash
curl 'http://localhost:8080/api/projects/{projectId}/events?afterVersion=0'
```

Clients use this after reconnect to recover missed updates.

Event shape:

```json
{
  "type": "task.updated",
  "projectId": "project-id",
  "entityId": "task-id",
  "version": 12,
  "payload": {},
  "createdAt": "2026-07-11T12:00:00Z"
}
```

## WebSocket Sync

Connect to project-scoped realtime updates:

```text
ws://localhost:8080/api/projects/{projectId}/ws?lastSeenVersion={version}
```

Recommended client behavior:

1. Load project snapshot and current task page.
2. Track the latest event `version`.
3. Connect WebSocket with `lastSeenVersion`.
4. Apply incoming events idempotently by entity ID.
5. On reconnect, call the event replay endpoint with the last seen version, then reconnect the socket.

## Error Responses

Most validation failures return:

```json
{
  "error": "invalid input: explanation"
}
```

Common cases:

- Invalid task status.
- Dependency does not exist.
- Dependency belongs to another project.
- Dependency would create a cycle.
- Cannot delete a task that is still blocking another task.
