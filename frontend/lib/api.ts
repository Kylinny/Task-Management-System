export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export type Project = {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskConfiguration = {
  priority: string;
  description: string;
  tags: string[];
  customFields: Record<string, unknown>;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  assignedTo: string[];
  configuration: TaskConfiguration;
  dependencies: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Comment = {
  id: string;
  taskId: string;
  content: string;
  author: string;
  timestamp: string;
};

export type ProjectSnapshot = {
  project: Project;
  tasks: Task[];
  comments: Comment[];
};

export type TaskPage = {
  items: Task[];
  nextCursor?: string;
};

export type ProjectEvent = {
  type:
    | "project.created"
    | "project.updated"
    | "project.archived"
    | "project.unarchived"
    | "project.deleted"
    | "task.created"
    | "task.updated"
    | "task.deleted"
    | "comment.created"
    | "comment.updated";
  projectId: string;
  entityId: string;
  version: number;
  payload: unknown;
  createdAt: string;
};

export type StatusCounts = {
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
};

export type ProjectProgress = {
  projectId: string;
  name: string;
  description: string;
  updatedAt: string;
  totalTasks: number;
  commentCount: number;
  completionPercent: number;
  blockedPercent: number;
  statusCounts: StatusCounts;
};

export type ProjectProgressDashboard = {
  generatedAt: string;
  totalProjects: number;
  archivedProjects: number;
  totalTasks: number;
  totalComments: number;
  statusCounts: StatusCounts;
  projects: ProjectProgress[];
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
export const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8080";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let parsedError = "";
    try {
      const parsed = JSON.parse(body) as { error?: string };
      parsedError = parsed.error ?? "";
    } catch {
      parsedError = "";
    }
    throw new Error(parsedError || body || `Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function listProjects(options: { includeArchived?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.includeArchived) {
    params.set("includeArchived", "true");
  }
  const query = params.toString();
  return request<Project[]>(`/api/projects${query ? `?${query}` : ""}`);
}

export function getProjectMetrics() {
  return request<ProjectProgressDashboard>("/api/metrics/projects");
}

export function createProject(input: { name: string; description: string }) {
  return request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ ...input, metadata: {} }),
  });
}

export function updateProject(projectId: string, input: { name: string; description: string }) {
  return request<Project>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getProjectSnapshot(projectId: string) {
  return request<ProjectSnapshot>(`/api/projects/${projectId}`);
}

export function archiveProject(projectId: string) {
  return request<void>(`/api/projects/${projectId}/archive`, {
    method: "POST",
  });
}

export function unarchiveProject(projectId: string) {
  return request<void>(`/api/projects/${projectId}/unarchive`, {
    method: "POST",
  });
}

export function deleteProject(projectId: string) {
  return request<void>(`/api/projects/${projectId}`, {
    method: "DELETE",
  });
}

export function listTasksPage(projectId: string, options: { limit?: number; cursor?: string } = {}) {
  const params = new URLSearchParams();
  if (options.limit) {
    params.set("limit", String(options.limit));
  }
  if (options.cursor) {
    params.set("cursor", options.cursor);
  }
  const query = params.toString();
  return request<TaskPage>(`/api/projects/${projectId}/tasks${query ? `?${query}` : ""}`);
}

export function createTask(
  projectId: string,
  input: {
    title: string;
    status: TaskStatus;
    priority: string;
    description: string;
    dependencies: string[];
  },
) {
  return request<Task>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      status: input.status,
      assignedTo: [],
      configuration: {
        priority: input.priority,
        description: input.description,
        tags: [],
        customFields: {},
      },
      dependencies: input.dependencies,
    }),
  });
}

export function updateTaskStatus(projectId: string, taskId: string, status: TaskStatus) {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function updateTaskDetails(projectId: string, taskId: string, input: { title?: string; configuration?: TaskConfiguration }) {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateTaskDependencies(projectId: string, taskId: string, dependencies: string[]) {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ dependencies }),
  });
}

export function deleteTask(projectId: string, taskId: string) {
  return request<void>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: "DELETE",
  });
}

export function listComments(projectId: string, taskId: string) {
  return request<Comment[]>(`/api/projects/${projectId}/tasks/${taskId}/comments`);
}

export function createComment(projectId: string, taskId: string, input: { content: string; author: string }) {
  return request<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateComment(projectId: string, taskId: string, commentId: string, input: { content: string }) {
  return request<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
