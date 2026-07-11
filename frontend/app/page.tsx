"use client";

import {
  DragEvent,
  FocusEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  Activity,
  Archive,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Link2,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  Share2,
  Trash2,
  Unlink,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  Comment,
  Project,
  ProjectEvent,
  Task,
  TaskStatus,
  WS_BASE_URL,
  archiveProject,
  createComment,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProjectSnapshot,
  listComments,
  listTasksPage,
  listProjects,
  unarchiveProject,
  updateComment,
  updateTaskDetails,
  updateTaskDependencies,
  updateProject,
  updateTaskStatus,
} from "@/lib/api";

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const priorities = ["low", "medium", "high", "urgent"];
const taskCardHeight = 118;
const virtualOverscan = 4;

type MutationStatus =
  | { state: "idle"; message: string }
  | { state: "saving"; message: string }
  | { state: "saved"; message: string }
  | { state: "rolled_back"; message: string };

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [comments, setComments] = useState<Record<string, Comment[]>>({});
  const [loadedCommentTaskIds, setLoadedCommentTaskIds] = useState<Set<string>>(() => new Set());
  const [loadingCommentTaskIds, setLoadingCommentTaskIds] = useState<Set<string>>(() => new Set());
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [draggedTaskId, setDraggedTaskId] = useState("");
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | "">("");
  const [connectionState, setConnectionState] = useState<"offline" | "connecting" | "connected">("offline");
  const [lastSeenVersion, setLastSeenVersion] = useState(0);
  const lastSeenVersionRef = useRef(0);
  const mutationStatusTimerRef = useRef<number | undefined>(undefined);
  const editProjectNameInputRef = useRef<HTMLInputElement | null>(null);
  const [taskCursor, setTaskCursor] = useState("");
  const [isLoadingMoreTasks, setIsLoadingMoreTasks] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus>({ state: "idle", message: "" });
  const [error, setError] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectDescription, setEditProjectDescription] = useState("");
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState("medium");
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("todo");
  const [taskSummary, setTaskSummary] = useState("");
  const [taskDependencyIds, setTaskDependencyIds] = useState<string[]>([]);
  const [isEditingTaskTitle, setIsEditingTaskTitle] = useState(false);
  const [editTaskTitle, setEditTaskTitle] = useState("");
  const [isEditingTaskSummary, setIsEditingTaskSummary] = useState(false);
  const [editTaskSummary, setEditTaskSummary] = useState("");
  const [dependencyTaskId, setDependencyTaskId] = useState("");
  const [isDependencyGraphOpen, setIsDependencyGraphOpen] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState("");
  const [editingCommentContent, setEditingCommentContent] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [commentAuthor, setCommentAuthor] = useState("Amy");

  const taskList = useMemo(() => Object.values(tasks), [tasks]);
  const activeProjects = useMemo(() => projects.filter((item) => !item.archivedAt), [projects]);
  const archivedProjects = useMemo(() => projects.filter((item) => item.archivedAt), [projects]);
  const selectedTask = selectedTaskId ? tasks[selectedTaskId] : undefined;
  const selectedTaskDependencies = selectedTask?.dependencies ?? [];
  const selectedComments = selectedTaskId ? uniqueById(comments[selectedTaskId] ?? []) : [];
  const selectedProjectIsArchived = Boolean(project?.archivedAt);
  const dependencyOptions = selectedTask
    ? taskList.filter(
        (task) =>
          task.id !== selectedTask.id &&
          !selectedTaskDependencies.includes(task.id) &&
          !taskDependsOn(task.id, selectedTask.id, tasks),
      )
    : [];
  const blockingTasks = selectedTask ? taskList.filter((task) => (task.dependencies ?? []).includes(selectedTask.id)) : [];
  const dependencyGraph = useMemo(() => buildDependencyGraph(taskList, ""), [taskList]);

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    void loadSnapshot(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    lastSeenVersionRef.current = lastSeenVersion;
  }, [lastSeenVersion]);

  useEffect(() => {
    if (!project?.id || !selectedTaskId || loadedCommentTaskIds.has(selectedTaskId) || loadingCommentTaskIds.has(selectedTaskId)) {
      return;
    }
    void loadTaskComments(project.id, selectedTaskId);
  }, [project?.id, selectedTaskId, loadedCommentTaskIds, loadingCommentTaskIds]);

  useEffect(() => {
    setDependencyTaskId("");
    setIsDependencyGraphOpen(false);
    setIsEditingTaskTitle(false);
    setEditTaskTitle("");
    setIsEditingTaskSummary(false);
    setEditTaskSummary("");
    setEditingCommentId("");
    setEditingCommentContent("");
  }, [selectedTaskId]);

  useEffect(() => {
    if (isEditingProject) {
      editProjectNameInputRef.current?.focus();
      editProjectNameInputRef.current?.select();
    }
  }, [isEditingProject]);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }

    function closeTaskSummaryOnOutsideClick(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("[data-task-detail]") || target.closest("[data-task-card]")) {
        return;
      }
      setSelectedTaskId("");
    }

    document.addEventListener("pointerdown", closeTaskSummaryOnOutsideClick);
    return () => {
      document.removeEventListener("pointerdown", closeTaskSummaryOnOutsideClick);
    };
  }, [selectedTaskId]);

  useEffect(() => {
    return () => {
      if (mutationStatusTimerRef.current) {
        window.clearTimeout(mutationStatusTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!project?.id) {
      return;
    }

    let stopped = false;
    let retry = 0;
    let reconnectTimer: number | undefined;
    let ws: WebSocket | undefined;

    const connect = () => {
      if (stopped) {
        return;
      }

      const replayFrom = lastSeenVersionRef.current;
      const wsUrl = `${WS_BASE_URL}/api/projects/${project.id}/ws?lastSeenVersion=${replayFrom}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        retry = 0;
        setConnectionState("connected");
      };

      ws.onmessage = (message) => {
        const event = JSON.parse(message.data) as ProjectEvent;
        applyEvent(event);
      };

      ws.onerror = () => {
        ws?.close();
      };

      ws.onclose = () => {
        if (stopped) {
          return;
        }
        retry += 1;
        setConnectionState("connecting");
        const backoffMs = Math.min(500 * 2 ** retry, 5000);
        reconnectTimer = window.setTimeout(connect, backoffMs);
      };
    };

    setConnectionState("connecting");
    connect();

    return () => {
      stopped = true;
      setConnectionState("offline");
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      ws?.close();
    };
  }, [project?.id]);

  async function loadProjects() {
    try {
      setError("");
      const data = await listProjects({ includeArchived: true });
      setProjects(data);
      const firstActiveProject = data.find((item) => !item.archivedAt);
      if (!selectedProjectId && firstActiveProject) {
        setSelectedProjectId(firstActiveProject.id);
      }
    } catch (err) {
      setError(readError(err));
    }
  }

  async function loadSnapshot(projectId: string) {
    try {
      setError("");
      const snapshot = await getProjectSnapshot(projectId);
      const firstTaskPage = await listTasksPage(projectId, { limit: 50 });
      const firstTasks = firstTaskPage.items ?? [];
      setProject(snapshot.project);
      setTasks(Object.fromEntries(firstTasks.map((task) => [task.id, task])));
      setComments(groupComments(snapshot.comments ?? []));
      setLoadedCommentTaskIds(new Set());
      setLoadingCommentTaskIds(new Set());
      setTaskCursor(firstTaskPage.nextCursor ?? "");
      setLastSeenVersion(snapshot.project.version);
      setSelectedTaskId("");
      setIsEditingProject(false);
    } catch (err) {
      setError(readError(err));
    }
  }

  async function loadTaskComments(projectId: string, taskId: string) {
    setLoadingCommentTaskIds((current) => new Set(current).add(taskId));
    try {
      setError("");
      const items = await listComments(projectId, taskId);
      setComments((current) => ({ ...current, [taskId]: uniqueById(items) }));
      setLoadedCommentTaskIds((current) => new Set(current).add(taskId));
    } catch (err) {
      setError(readError(err));
    } finally {
      setLoadingCommentTaskIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  }

  async function loadMoreTasks() {
    if (!project || !taskCursor || isLoadingMoreTasks) {
      return;
    }
    try {
      setError("");
      setIsLoadingMoreTasks(true);
      const page = await listTasksPage(project.id, { limit: 50, cursor: taskCursor });
      const pageTasks = page.items ?? [];
      setTasks((current) => ({ ...current, ...Object.fromEntries(pageTasks.map((task) => [task.id, task])) }));
      setTaskCursor(page.nextCursor ?? "");
    } catch (err) {
      setError(readError(err));
    } finally {
      setIsLoadingMoreTasks(false);
    }
  }

  function applyEvent(event: ProjectEvent) {
    setLastSeenVersion((current) => Math.max(current, event.version));

    if (event.type === "project.created") {
      const nextProject = event.payload as Project;
      setProjects((current) => upsertById(current, nextProject));
      return;
    }

    if (event.type === "project.updated") {
      const nextProject = event.payload as Project;
      setProjects((current) => upsertById(current, nextProject));
      if (project?.id === nextProject.id) {
        setProject(nextProject);
      }
      return;
    }

    if (event.type === "project.deleted") {
      const deleted = event.payload as { id: string };
      setProjects((current) => current.filter((item) => item.id !== deleted.id));
      if (project?.id === deleted.id) {
        clearSelectedProject();
      }
      return;
    }

    if (event.type === "project.archived") {
      const archived = event.payload as { id: string; archivedAt: string };
      setProjects((current) => current.map((item) => (item.id === archived.id ? { ...item, archivedAt: archived.archivedAt } : item)));
      if (project?.id === archived.id) {
        setProject((current) => (current ? { ...current, archivedAt: archived.archivedAt } : current));
      }
      return;
    }

    if (event.type === "project.unarchived") {
      const unarchived = event.payload as Partial<Project> & { id: string };
      setProjects((current) =>
        current.map((item) => {
          if (item.id !== unarchived.id) {
            return item;
          }
          if (unarchived.name) {
            return unarchived as Project;
          }
          const { archivedAt, ...activeProject } = item;
          return activeProject;
        }),
      );
      if (project?.id === unarchived.id) {
        setProject((current) => {
          if (!current) {
            return current;
          }
          if (unarchived.name) {
            return unarchived as Project;
          }
          const { archivedAt, ...activeProject } = current;
          return activeProject;
        });
      }
      return;
    }

    if (event.type === "task.created" || event.type === "task.updated") {
      const nextTask = event.payload as Task;
      setTasks((current) => ({ ...current, [nextTask.id]: nextTask }));
      return;
    }

    if (event.type === "task.deleted") {
      const deleted = event.payload as { id: string };
      setTasks((current) => {
        const next = { ...current };
        delete next[deleted.id];
        return next;
      });
      setSelectedTaskId((current) => (current === deleted.id ? "" : current));
      return;
    }

    if (event.type === "comment.created" || event.type === "comment.updated") {
      const nextComment = event.payload as Comment;
      setComments((current) => ({
        ...current,
        [nextComment.taskId]: upsertById(current[nextComment.taskId] ?? [], nextComment),
      }));
    }
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim()) {
      return;
    }
    try {
      setError("");
      const nextProject = await createProject({ name: projectName.trim(), description: projectDescription.trim() });
      setProjects((current) => upsertById(current, nextProject));
      setSelectedProjectId(nextProject.id);
      setProjectName("");
      setProjectDescription("");
      setIsCreatingProject(false);
    } catch (err) {
      setError(readError(err));
    }
  }

  function closeCreateProjectModal() {
    setIsCreatingProject(false);
    setProjectName("");
    setProjectDescription("");
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !taskTitle.trim()) {
      return;
    }
    try {
      setError("");
      const task = await createTask(project.id, {
        title: taskTitle.trim(),
        status: taskStatus,
        priority: taskPriority,
        description: taskSummary.trim(),
        dependencies: taskDependencyIds,
      });
      setTasks((current) => ({ ...current, [task.id]: task }));
      setSelectedTaskId(task.id);
      closeCreateTaskModal();
    } catch (err) {
      setError(readError(err));
    }
  }

  function closeCreateTaskModal() {
    setIsCreatingTask(false);
    setTaskTitle("");
    setTaskPriority("medium");
    setTaskStatus("todo");
    setTaskSummary("");
    setTaskDependencyIds([]);
  }

  function toggleNewTaskDependency(taskId: string) {
    setTaskDependencyIds((current) => (current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]));
  }

  function startProjectEdit() {
    if (!project || selectedProjectIsArchived) {
      return;
    }
    setEditProjectName(project.name);
    setEditProjectDescription(project.description);
    setIsEditingProject(true);
  }

  async function saveProjectEdit() {
    if (!project || !editProjectName.trim()) {
      return;
    }
    const nextName = editProjectName.trim();
    const nextDescription = editProjectDescription.trim();
    if (nextName === project.name && nextDescription === project.description) {
      setIsEditingProject(false);
      return;
    }
    try {
      setError("");
      const updatedProject = await updateProject(project.id, {
        name: nextName,
        description: nextDescription,
      });
      setProjects((current) => upsertById(current, updatedProject));
      setProject(updatedProject);
      setIsEditingProject(false);
    } catch (err) {
      setError(readError(err));
    }
  }

  function handleProjectEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveProjectEdit();
  }

  function handleProjectEditBlur(event: FocusEvent<HTMLFormElement>) {
    const nextFocusedElement = event.relatedTarget;
    if (nextFocusedElement && event.currentTarget.contains(nextFocusedElement)) {
      return;
    }
    void saveProjectEdit();
  }

  async function handleDeleteProject() {
    if (!project) {
      return;
    }
    const confirmed = window.confirm(
      `Permanently delete project "${project.name}"?\n\nThis will delete all tasks and comments in the project. This action cannot be recovered.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      setError("");
      const deletedProjectId = project.id;
      await deleteProject(deletedProjectId);
      setProjects((current) => current.filter((item) => item.id !== deletedProjectId));
      clearSelectedProject();
    } catch (err) {
      setError(readError(err));
    }
  }

  async function handleArchiveProject() {
    if (!project) {
      return;
    }
    const confirmed = window.confirm(`Archive project "${project.name}"?\n\nIt will be hidden from the active project list, but its tasks and comments will not be deleted.`);
    if (!confirmed) {
      return;
    }
    try {
      setError("");
      const archivedProjectId = project.id;
      await archiveProject(archivedProjectId);
      const archivedAt = new Date().toISOString();
      setProjects((current) => current.map((item) => (item.id === archivedProjectId ? { ...item, archivedAt } : item)));
      setProject((current) => (current ? { ...current, archivedAt } : current));
      setShowArchivedProjects(true);
    } catch (err) {
      setError(readError(err));
    }
  }

  async function handleUnarchiveProject(projectToRestore: Project) {
    try {
      setError("");
      await unarchiveProject(projectToRestore.id);
      setProjects((current) =>
        current.map((item) => {
          if (item.id !== projectToRestore.id) {
            return item;
          }
          const { archivedAt, ...activeProject } = item;
          return activeProject;
        }),
      );
      if (project?.id === projectToRestore.id) {
        setProject((current) => {
          if (!current) {
            return current;
          }
          const { archivedAt, ...activeProject } = current;
          return activeProject;
        });
      }
      setSelectedProjectId(projectToRestore.id);
    } catch (err) {
      setError(readError(err));
    }
  }

  async function handleDeleteTask() {
    if (!project || !selectedTask) {
      return;
    }
    const confirmed = window.confirm(`Delete task "${selectedTask.title}"?`);
    if (!confirmed) {
      return;
    }
    try {
      setError("");
      const deletedTaskId = selectedTask.id;
      await deleteTask(project.id, deletedTaskId);
      setTasks((current) => {
        const next = { ...current };
        delete next[deletedTaskId];
        return next;
      });
      setComments((current) => {
        const next = { ...current };
        delete next[deletedTaskId];
        return next;
      });
      setLoadedCommentTaskIds((current) => {
        const next = new Set(current);
        next.delete(deletedTaskId);
        return next;
      });
      setSelectedTaskId("");
    } catch (err) {
      setError(readError(err));
    }
  }

  async function handleStatusChange(status: TaskStatus) {
    if (!project || !selectedTask) {
      return;
    }
    await updateTaskStatusWithRollback(selectedTask, status);
  }

  function startTaskTitleEdit() {
    if (!selectedTask || selectedProjectIsArchived) {
      return;
    }
    setEditTaskTitle(selectedTask.title);
    setIsEditingTaskTitle(true);
  }

  function startTaskSummaryEdit() {
    if (!selectedTask || selectedProjectIsArchived) {
      return;
    }
    setEditTaskSummary(selectedTask.configuration.description ?? "");
    setIsEditingTaskSummary(true);
  }

  function cancelTaskTitleEdit() {
    setIsEditingTaskTitle(false);
    setEditTaskTitle("");
  }

  function cancelTaskSummaryEdit() {
    setIsEditingTaskSummary(false);
    setEditTaskSummary("");
  }

  async function saveTaskTitleEdit() {
    if (!project || !selectedTask || selectedProjectIsArchived) {
      return;
    }
    const nextTitle = editTaskTitle.trim();
    if (!nextTitle) {
      setError("Task name cannot be empty.");
      return;
    }
    if (nextTitle === selectedTask.title) {
      cancelTaskTitleEdit();
      return;
    }
    try {
      setError("");
      const updated = await updateTaskDetails(project.id, selectedTask.id, { title: nextTitle });
      setTasks((current) => ({ ...current, [updated.id]: updated }));
      cancelTaskTitleEdit();
    } catch (err) {
      setError(readError(err));
    }
  }

  async function saveTaskSummaryEdit() {
    if (!project || !selectedTask || selectedProjectIsArchived) {
      return;
    }
    const nextSummary = editTaskSummary.trim();
    if (nextSummary === (selectedTask.configuration.description ?? "")) {
      cancelTaskSummaryEdit();
      return;
    }
    try {
      setError("");
      const updated = await updateTaskDetails(project.id, selectedTask.id, {
        configuration: {
          ...selectedTask.configuration,
          description: nextSummary,
          tags: selectedTask.configuration.tags ?? [],
          customFields: selectedTask.configuration.customFields ?? {},
        },
      });
      setTasks((current) => ({ ...current, [updated.id]: updated }));
      cancelTaskSummaryEdit();
    } catch (err) {
      setError(readError(err));
    }
  }

  async function handleAddDependency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !selectedTask || !dependencyTaskId || selectedProjectIsArchived) {
      return;
    }
    const nextDependencies = uniqueValues([...selectedTaskDependencies, dependencyTaskId]);
    await updateTaskDependenciesWithStatus(selectedTask, nextDependencies, "added");
    setDependencyTaskId("");
  }

  async function handleRemoveDependency(dependencyId: string) {
    if (!selectedTask) {
      return;
    }
    const nextDependencies = selectedTaskDependencies.filter((id) => id !== dependencyId);
    await updateTaskDependenciesWithStatus(selectedTask, nextDependencies, "removed");
  }

  async function updateTaskDependenciesWithStatus(task: Task, dependencies: string[], action: "added" | "removed") {
    if (!project) {
      return;
    }
    showMutationStatus("saving", `Saving dependency links for "${task.title}"...`);
    try {
      setError("");
      const updated = await updateTaskDependencies(project.id, task.id, dependencies);
      setTasks((current) => ({ ...current, [updated.id]: updated }));
      showMutationStatus("saved", `Dependency ${action} for "${updated.title}".`);
    } catch (err) {
      showMutationStatus("rolled_back", `Could not update dependency links for "${task.title}".`);
      setError(readError(err));
    }
  }

  async function updateTaskStatusWithRollback(task: Task, status: TaskStatus) {
    if (!project || task.status === status) {
      return;
    }
    const previous = task;
    setTasks((current) => ({ ...current, [previous.id]: { ...previous, status } }));
    showMutationStatus("saving", `Saving "${previous.title}" as ${formatStatus(status)}...`);
    try {
      setError("");
      const updated = await updateTaskStatus(project.id, previous.id, status);
      setTasks((current) => ({ ...current, [updated.id]: updated }));
      showMutationStatus("saved", `Saved "${updated.title}" as ${formatStatus(updated.status)}.`);
    } catch (err) {
      setTasks((current) => ({ ...current, [previous.id]: previous }));
      showMutationStatus("rolled_back", `Server rejected the status change. Rolled "${previous.title}" back to ${formatStatus(previous.status)}.`);
      setError(readError(err));
    }
  }

  function handleTaskDragStart(event: DragEvent<HTMLButtonElement>, taskId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
    setDraggedTaskId(taskId);
  }

  function handleColumnDragOver(event: DragEvent<HTMLDivElement>, status: TaskStatus) {
    if (!draggedTaskId || selectedProjectIsArchived) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverStatus(status);
  }

  function handleTaskDrop(event: DragEvent<HTMLDivElement>, status: TaskStatus) {
    event.preventDefault();
    const droppedTaskId = event.dataTransfer.getData("text/plain") || draggedTaskId;
    setDraggedTaskId("");
    setDragOverStatus("");
    const droppedTask = tasks[droppedTaskId];
    if (!droppedTask || selectedProjectIsArchived) {
      return;
    }
    void updateTaskStatusWithRollback(droppedTask, status);
  }

  function handleTaskDragEnd() {
    setDraggedTaskId("");
    setDragOverStatus("");
  }

  function showMutationStatus(state: Exclude<MutationStatus["state"], "idle">, message: string) {
    if (mutationStatusTimerRef.current) {
      window.clearTimeout(mutationStatusTimerRef.current);
    }
    setMutationStatus({ state, message });
    if (state !== "saving") {
      mutationStatusTimerRef.current = window.setTimeout(() => {
        setMutationStatus({ state: "idle", message: "" });
      }, 4200);
    }
  }

  function clearSelectedProject() {
    setSelectedProjectId("");
    setProject(null);
    setTasks({});
    setComments({});
    setLoadedCommentTaskIds(new Set());
    setLoadingCommentTaskIds(new Set());
    setSelectedTaskId("");
    setTaskCursor("");
    setLastSeenVersion(0);
    closeCreateTaskModal();
  }

  async function handleCreateComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !selectedTask || !commentBody.trim()) {
      return;
    }
    try {
      setError("");
      const nextComment = await createComment(project.id, selectedTask.id, {
        content: commentBody.trim(),
        author: commentAuthor.trim() || "anonymous",
      });
      setComments((current) => ({
        ...current,
        [nextComment.taskId]: upsertById(current[nextComment.taskId] ?? [], nextComment),
      }));
      setLoadedCommentTaskIds((current) => new Set(current).add(nextComment.taskId));
      setCommentBody("");
    } catch (err) {
      setError(readError(err));
    }
  }

  function startCommentEdit(comment: Comment) {
    if (selectedProjectIsArchived) {
      return;
    }
    setEditingCommentId(comment.id);
    setEditingCommentContent(comment.content);
  }

  function cancelCommentEdit() {
    setEditingCommentId("");
    setEditingCommentContent("");
  }

  async function saveCommentEdit(comment: Comment) {
    if (!project || !selectedTask || selectedProjectIsArchived) {
      return;
    }
    const nextContent = editingCommentContent.trim();
    if (!nextContent) {
      cancelCommentEdit();
      return;
    }
    if (nextContent === comment.content) {
      cancelCommentEdit();
      return;
    }
    try {
      setError("");
      const updatedComment = await updateComment(project.id, selectedTask.id, comment.id, { content: nextContent });
      setComments((current) => ({
        ...current,
        [updatedComment.taskId]: upsertById(current[updatedComment.taskId] ?? [], updatedComment),
      }));
      cancelCommentEdit();
    } catch (err) {
      setError(readError(err));
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>HappyRobot Task Management</h1>
          <p>Collaborative project boards for tracking work, blockers, and team discussion.</p>
        </div>

        <Link className="analytics-card-link" href="/analytics">
          <span>
            <BarChart3 size={16} />
            Monitoring analytics
          </span>
          <small>Project health, blockers, and progress overview</small>
        </Link>

        <div className="panel-title">
          <span>Projects</span>
          <div className="panel-actions">
            <button className="button secondary icon-button" type="button" onClick={() => void loadProjects()} aria-label="Refresh projects">
              <RefreshCcw size={15} />
            </button>
            <button className="button secondary icon-button" type="button" onClick={() => setIsCreatingProject(true)} aria-label="Add project">
              <Plus size={15} />
            </button>
          </div>
        </div>

        <div className="project-list">
          {activeProjects.map((item) => (
            <button
              className={`project-button ${item.id === selectedProjectId ? "active" : ""}`}
              key={item.id}
              onClick={() => setSelectedProjectId(item.id)}
              type="button"
            >
              <strong>{item.name}</strong>
              <span>{item.description || "No description"}</span>
            </button>
          ))}
          {activeProjects.length === 0 ? <div className="empty">Create the first project to start.</div> : null}
        </div>

        <button className="archive-toggle" type="button" onClick={() => setShowArchivedProjects((current) => !current)}>
          <span>
            {showArchivedProjects ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            Archived projects
          </span>
          <strong>{archivedProjects.length}</strong>
        </button>
        {showArchivedProjects ? (
          <div className="project-list archived-list">
            {archivedProjects.map((item) => (
              <div className={`archived-project ${item.id === selectedProjectId ? "active" : ""}`} key={item.id}>
                <button className="project-button" onClick={() => setSelectedProjectId(item.id)} type="button">
                  <strong>{item.name}</strong>
                  <span>{item.description || "No description"}</span>
                </button>
              </div>
            ))}
            {archivedProjects.length === 0 ? <div className="empty compact">No archived projects.</div> : null}
          </div>
        ) : null}

      </aside>

      {isCreatingProject ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeCreateProjectModal}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <h2 id="new-project-title">Create new project</h2>
              <p>Name the workspace and add a short description for the team.</p>
            </div>
            <form className="create-form" onSubmit={handleCreateProject}>
              <input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" autoFocus />
              <input
                className="input"
                value={projectDescription}
                onChange={(event) => setProjectDescription(event.target.value)}
                placeholder="Description"
              />
              <div className="modal-actions">
                <button className="button secondary" type="button" onClick={closeCreateProjectModal}>
                  Cancel
                </button>
                <button className="button" type="submit" disabled={!projectName.trim()}>
                  <Plus size={16} />
                  Create project
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isCreatingTask ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeCreateTaskModal}>
          <section className="modal-card task-modal-card" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <div>
              <h2 id="new-task-title">Create task</h2>
              <p>Add the core details now so the task starts with the right context and dependencies.</p>
            </div>
            <form className="task-create-form" onSubmit={handleCreateTask}>
              <label className="field-label" htmlFor="create-task-title">
                Task title
              </label>
              <input
                className="input"
                id="create-task-title"
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="e.g. Design sync model"
                autoFocus
              />

              <label className="field-label" htmlFor="create-task-summary">
                Summary
              </label>
              <textarea
                className="textarea"
                id="create-task-summary"
                value={taskSummary}
                onChange={(event) => setTaskSummary(event.target.value)}
                placeholder="What needs to happen, why it matters, and any useful context."
              />

              <div className="task-create-grid">
                <div>
                  <label className="field-label" htmlFor="create-task-status">
                    Status
                  </label>
                  <select className="select" id="create-task-status" value={taskStatus} onChange={(event) => setTaskStatus(event.target.value as TaskStatus)}>
                    {columns.map((column) => (
                      <option key={column.status} value={column.status}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="create-task-priority">
                    Priority
                  </label>
                  <select className="select" id="create-task-priority" value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}>
                    {priorities.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="panel-title">
                  <span>Dependencies</span>
                  <Link2 size={15} />
                </div>
                <div className="dependency-picker">
                  {taskList.map((task) => {
                    const selected = taskDependencyIds.includes(task.id);
                    return (
                      <button
                        className={`dependency-choice ${selected ? "selected" : ""}`}
                        key={task.id}
                        type="button"
                        onClick={() => toggleNewTaskDependency(task.id)}
                      >
                        <span>{task.title}</span>
                        <small>{formatStatus(task.status)}</small>
                      </button>
                    );
                  })}
                  {taskList.length === 0 ? <div className="empty compact">No loaded tasks to link yet.</div> : null}
                </div>
                <p className="helper-text">Selected dependencies mean this new task is blocked by those tasks.</p>
              </div>

              <div className="modal-actions">
                <button className="button secondary" type="button" onClick={closeCreateTaskModal}>
                  Cancel
                </button>
                <button className="button" type="submit" disabled={!taskTitle.trim()}>
                  <Plus size={16} />
                  Create task
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      <section className="main">
        <header className="topbar">
          {project && isEditingProject ? (
            <form
              className="project-edit-form"
              onBlur={handleProjectEditBlur}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setIsEditingProject(false);
                }
              }}
              onSubmit={handleProjectEditSubmit}
            >
              <input
                className="input project-title-input"
                ref={editProjectNameInputRef}
                value={editProjectName}
                onChange={(event) => setEditProjectName(event.target.value)}
                placeholder="Project name"
              />
              <input
                className="input"
                value={editProjectDescription}
                onChange={(event) => setEditProjectDescription(event.target.value)}
                placeholder="Project description"
              />
            </form>
          ) : project ? (
            <button
              className="project-heading"
              type="button"
              onClick={startProjectEdit}
              disabled={selectedProjectIsArchived}
              title={selectedProjectIsArchived ? "Restore the project before editing." : "Click to edit project name and description."}
            >
              <h2>{project.name}</h2>
              <p>{project.description || "Click to add a project description."}</p>
            </button>
          ) : (
            <div>
              <h2>No project selected</h2>
              <p>Load a project snapshot, then apply WebSocket delta events.</p>
            </div>
          )}
          <div className="topbar-actions">
            {project ? (
              <>
                {selectedProjectIsArchived ? (
                  <button
                    aria-label="Restore this archived project"
                    className="button secondary"
                    title="Restores this project to the active list."
                    type="button"
                    onClick={() => void handleUnarchiveProject(project)}
                  >
                    <RotateCcw size={16} />
                    Restore
                  </button>
                ) : (
                  <button
                    aria-label="Archive this project"
                    className="button secondary"
                    title="Hides this project from the active list without deleting tasks or comments."
                    type="button"
                    onClick={() => void handleArchiveProject()}
                  >
                    <Archive size={16} />
                    Archive
                  </button>
                )}
                <button
                  aria-label="View board dependency graph"
                  className="button secondary"
                  title="Shows dependency links across the loaded tasks on this board."
                  type="button"
                  onClick={() => setIsDependencyGraphOpen(true)}
                  disabled={taskList.length === 0}
                >
                  <Share2 size={16} />
                  Dependency graph
                </button>
                <button
                  aria-label="Permanently delete this project"
                  className="button danger ghost"
                  title="Permanently deletes this project, including all tasks and comments. This cannot be recovered."
                  type="button"
                  onClick={() => void handleDeleteProject()}
                >
                  <Trash2 size={16} />
                  Delete project
                </button>
              </>
            ) : null}
            <div className="status-pill">
              {connectionState === "connected" ? <Wifi size={16} /> : <WifiOff size={16} />}
              <span className={`status-dot ${connectionState === "connected" ? "connected" : ""}`} />
              {connectionState}
            </div>
          </div>
        </header>

        <div className={`workspace ${selectedTask ? "has-detail" : ""}`}>
          <section className="board-pane">
            {error ? <p className="error">{error}</p> : null}
            {mutationStatus.state !== "idle" ? (
              <div className={`mutation-banner ${mutationStatus.state}`}>
                <span>{mutationStatus.message}</span>
              </div>
            ) : null}
            {selectedProjectIsArchived ? (
              <div className="mutation-banner archived-warning">This project is archived. Restore it before changing tasks or comments.</div>
            ) : null}
            <div className="board-toolbar">
              <div>
                <p className="eyebrow">Board</p>
                <strong>{taskList.length === 0 ? "No tasks yet" : `${taskList.length} loaded task${taskList.length === 1 ? "" : "s"}`}</strong>
              </div>
              <button className="button" type="button" disabled={!project || selectedProjectIsArchived} onClick={() => setIsCreatingTask(true)}>
                <Plus size={16} />
                Add task
              </button>
            </div>

            <div className="board">
              {columns.map((column) => {
                const columnTasks = taskList.filter((task) => task.status === column.status);
                return (
                  <div
                    className={`column ${selectedProjectIsArchived ? "archived" : ""} ${dragOverStatus === column.status ? "drop-target" : ""}`}
                    key={column.status}
                    onDragLeave={() => setDragOverStatus((current) => (current === column.status ? "" : current))}
                    onDragOver={(event) => handleColumnDragOver(event, column.status)}
                    onDrop={(event) => handleTaskDrop(event, column.status)}
                  >
                    <div className="column-header">
                      <strong>{column.label}</strong>
                      <span>{columnTasks.length}</span>
                    </div>
                    <VirtualTaskColumn
                      activeTaskId={selectedTaskId}
                      archived={selectedProjectIsArchived}
                      canDrag={!selectedProjectIsArchived}
                      draggedTaskId={draggedTaskId}
                      onDragEnd={handleTaskDragEnd}
                      onDragStart={handleTaskDragStart}
                      onSelectTask={(taskId) => setSelectedTaskId((current) => (current === taskId ? "" : taskId))}
                      tasks={columnTasks}
                    />
                  </div>
                );
              })}
            </div>

            <div className="pagination-bar">
              <span>{taskList.length === 0 ? "No tasks yet." : `Showing ${taskList.length} task${taskList.length === 1 ? "" : "s"}.`}</span>
              <button className="button secondary" type="button" onClick={() => void loadMoreTasks()} disabled={!taskCursor || isLoadingMoreTasks}>
                {taskCursor ? (isLoadingMoreTasks ? "Loading..." : "Load more") : "Everything loaded"}
              </button>
            </div>
          </section>

          {selectedTask ? (
            <aside className="detail" data-task-detail="true">
              <div>
                <div className="detail-heading">
                  <div className="task-edit-block">
                    {isEditingTaskTitle ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveTaskTitleEdit();
                        }}
                      >
                        <input
                          className="input task-title-input"
                          value={editTaskTitle}
                          onBlur={() => void saveTaskTitleEdit()}
                          onChange={(event) => setEditTaskTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              cancelTaskTitleEdit();
                            }
                          }}
                          autoFocus
                        />
                      </form>
                    ) : (
                      <button
                        className="task-title-button"
                        type="button"
                        onClick={startTaskTitleEdit}
                        disabled={selectedProjectIsArchived}
                        title={selectedProjectIsArchived ? "Restore the project before editing." : "Click to edit task name."}
                      >
                        <span>{selectedTask.title}</span>
                        {!selectedProjectIsArchived ? <Pencil size={14} /> : null}
                      </button>
                    )}
                  </div>
                  <button className="button danger ghost" type="button" onClick={() => void handleDeleteTask()} disabled={selectedProjectIsArchived}>
                    <Trash2 size={15} />
                    Delete
                  </button>
                </div>
                {isEditingTaskSummary ? (
                  <form
                    className="task-summary-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveTaskSummaryEdit();
                    }}
                  >
                    <textarea
                      className="textarea task-summary-textarea"
                      value={editTaskSummary}
                      onBlur={() => void saveTaskSummaryEdit()}
                      onChange={(event) => setEditTaskSummary(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          cancelTaskSummaryEdit();
                        }
                      }}
                      placeholder="Task summary"
                      autoFocus
                    />
                  </form>
                ) : (
                  <button
                    className="task-summary-button"
                    type="button"
                    onClick={startTaskSummaryEdit}
                    disabled={selectedProjectIsArchived}
                    title={selectedProjectIsArchived ? "Restore the project before editing." : "Click to edit task summary."}
                  >
                    <span>
                      <strong className="summary-keyword">Summary</strong>
                      {selectedTask.configuration.description || "Click to add a task summary."}
                    </span>
                    {!selectedProjectIsArchived ? <Pencil size={13} /> : null}
                  </button>
                )}
                <div className="task-timestamps" aria-label="Task timestamps">
                  <span>Created {formatDateTime(selectedTask.createdAt)}</span>
                  <span>Updated {formatDateTime(selectedTask.updatedAt)}</span>
                </div>

                <div className="detail-section">
                  <label className="panel-title" htmlFor="status">
                    Status
                  </label>
                  <select
                    className="select"
                    id="status"
                    value={selectedTask.status}
                    disabled={selectedProjectIsArchived}
                    onChange={(event) => void handleStatusChange(event.target.value as TaskStatus)}
                  >
                    {columns.map((column) => (
                      <option key={column.status} value={column.status}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="detail-section">
                  <div className="panel-title">
                    <span>Blocked by</span>
                    <Link2 size={15} />
                  </div>
                  <div className="dependency-list">
                    {selectedTaskDependencies.map((dependencyId) => {
                      const dependency = tasks[dependencyId];
                      return (
                        <div className={`dependency-item ${dependency ? "clickable" : ""}`} key={dependencyId}>
                          <button
                            className="dependency-link"
                            type="button"
                            onClick={() => {
                              if (dependency) {
                                setSelectedTaskId(dependency.id);
                              }
                            }}
                            disabled={!dependency}
                          >
                            <span>{dependency?.title ?? "Unloaded task"}</span>
                            <small>{dependency ? formatStatus(dependency.status) : dependencyId}</small>
                          </button>
                          <button
                            className="button secondary dependency-remove"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleRemoveDependency(dependencyId);
                            }}
                            disabled={selectedProjectIsArchived}
                          >
                            <Unlink size={13} />
                            Remove
                          </button>
                        </div>
                      );
                    })}
                    {selectedTaskDependencies.length === 0 ? <div className="empty compact">This task is not blocked by another loaded task.</div> : null}
                  </div>

                  <div className="blocking-list">
                    <p className="helper-text">Blocking</p>
                    {blockingTasks.map((task) => (
                      <button className="dependency-item readonly clickable" key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)}>
                        <span>{task.title}</span>
                        <small>{formatStatus(task.status)}</small>
                      </button>
                    ))}
                    {blockingTasks.length === 0 ? <div className="empty compact">No loaded tasks are blocked by this task.</div> : null}
                  </div>

                  <form className="dependency-form" onSubmit={handleAddDependency}>
                    <select
                      className="select"
                      value={dependencyTaskId}
                      onChange={(event) => setDependencyTaskId(event.target.value)}
                      disabled={selectedProjectIsArchived || dependencyOptions.length === 0}
                    >
                      <option value="">{dependencyOptions.length === 0 ? "No safe loaded tasks available" : "Choose what this task depends on"}</option>
                      {dependencyOptions.map((task) => (
                        <option key={task.id} value={task.id}>
                          {task.title}
                        </option>
                      ))}
                    </select>
                    <button className="button secondary" type="submit" disabled={selectedProjectIsArchived || !dependencyTaskId}>
                      <Link2 size={15} />
                      Add dependency
                    </button>
                  </form>
                </div>

                <div className="detail-section">
                  <div className="panel-title">
                    <span>Comments</span>
                    <Activity size={15} />
                  </div>
                  <div className="comments">
                    {selectedComments.map((comment) => (
                      <div className="comment" key={comment.id}>
                        <div className="comment-heading">
                          <strong>{comment.author}</strong>
                          {!selectedProjectIsArchived && editingCommentId !== comment.id ? (
                            <button className="comment-edit-trigger" type="button" onClick={() => startCommentEdit(comment)} aria-label="Edit comment">
                              <Pencil size={13} />
                            </button>
                          ) : null}
                        </div>
                        {editingCommentId === comment.id ? (
                          <form
                            className="comment-edit-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveCommentEdit(comment);
                            }}
                          >
                            <textarea
                              className="textarea comment-edit-textarea"
                              value={editingCommentContent}
                              onBlur={() => void saveCommentEdit(comment)}
                              onChange={(event) => setEditingCommentContent(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  cancelCommentEdit();
                                }
                              }}
                              autoFocus
                            />
                          </form>
                        ) : (
                          <button className="comment-content-button" type="button" onClick={() => startCommentEdit(comment)} disabled={selectedProjectIsArchived}>
                            {comment.content}
                          </button>
                        )}
                      </div>
                    ))}
                    {loadingCommentTaskIds.has(selectedTask.id) ? <div className="empty">Loading comments...</div> : null}
                    {loadedCommentTaskIds.has(selectedTask.id) && selectedComments.length === 0 ? (
                      <div className="empty">No comments yet</div>
                    ) : null}
                  </div>

                  <form className="create-form" onSubmit={handleCreateComment} style={{ marginTop: 12 }}>
                    <input className="input" value={commentAuthor} onChange={(event) => setCommentAuthor(event.target.value)} placeholder="Author" />
                    <textarea
                      className="textarea"
                      value={commentBody}
                      onChange={(event) => setCommentBody(event.target.value)}
                      placeholder="Write a comment"
                    />
                    <button className="button" type="submit" disabled={selectedProjectIsArchived}>
                      <MessageSquarePlus size={16} />
                      Add comment
                    </button>
                  </form>
                </div>
              </div>
            </aside>
          ) : null}
        </div>
      </section>

      {isDependencyGraphOpen ? (
        <DependencyGraphModal
          graph={dependencyGraph}
          onClose={() => setIsDependencyGraphOpen(false)}
          onSelectTask={(taskId) => {
            setSelectedTaskId(taskId);
          }}
          selectedTaskId={selectedTaskId}
        />
      ) : null}
    </main>
  );
}

function groupComments(items: Comment[]) {
  return items.reduce<Record<string, Comment[]>>((acc, comment) => {
    acc[comment.taskId] = upsertById(acc[comment.taskId] ?? [], comment);
    return acc;
  }, {});
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T) {
  const byID = new Map(items.map((item) => [item.id, item]));
  byID.set(nextItem.id, nextItem);
  return Array.from(byID.values());
}

function uniqueById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function uniqueValues(items: string[]) {
  return Array.from(new Set(items));
}

type DependencyGraphNode = {
  id: string;
  task: Task;
  x: number;
  y: number;
};

type DependencyGraphEdge = {
  from: string;
  to: string;
};

type DependencyGraph = {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  missingDependencyCount: number;
};

const graphNodeWidth = 170;
const graphNodeHeight = 76;
const graphCanvasWidth = 920;
const graphCanvasHeight = 520;
const graphPadding = 42;

function buildDependencyGraph(tasks: Task[], selectedTaskId: string): DependencyGraph {
  const taskByID = new Map(tasks.map((task) => [task.id, task]));
  let missingDependencyCount = 0;
  const allEdges: DependencyGraphEdge[] = [];

  tasks.forEach((task) => {
    (task.dependencies ?? []).forEach((dependencyId) => {
      if (!taskByID.has(dependencyId)) {
        missingDependencyCount += 1;
        return;
      }
      // Dependency flow is drawn from blocker -> task it unlocks.
      allEdges.push({ from: dependencyId, to: task.id });
    });
  });

  const selectedTask = selectedTaskId ? taskByID.get(selectedTaskId) : undefined;
  const upstreamIDs = new Set<string>();
  const downstreamIDs = new Set<string>();

  if (selectedTask) {
    collectUpstreamDependencies(selectedTask.id, taskByID, upstreamIDs);
    collectDownstreamDependents(selectedTask.id, tasks, downstreamIDs);
  }

  if (!selectedTask) {
    const nodes = layoutDependencyNodes(tasks, allEdges, "");
    const visibleIDs = new Set(nodes.map((node) => node.id));

    return {
      nodes,
      edges: allEdges.filter((edge) => visibleIDs.has(edge.from) && visibleIDs.has(edge.to)),
      missingDependencyCount,
    };
  }

  const relatedTasks = uniqueById([
    selectedTask,
    ...Array.from(upstreamIDs).map((id) => taskByID.get(id)).filter((task): task is Task => Boolean(task)),
    ...Array.from(downstreamIDs).map((id) => taskByID.get(id)).filter((task): task is Task => Boolean(task)),
  ]);
  const nodes = layoutDependencyNodes(relatedTasks, allEdges, selectedTask.id);
  const visibleIDs = new Set(nodes.map((node) => node.id));

  return {
    nodes,
    edges: allEdges.filter((edge) => visibleIDs.has(edge.from) && visibleIDs.has(edge.to)),
    missingDependencyCount,
  };
}

function layoutDependencyNodes(tasks: Task[], edges: DependencyGraphEdge[], selectedTaskId: string): DependencyGraphNode[] {
  const visibleIDs = new Set(tasks.map((task) => task.id));
  const visibleEdges = edges.filter((edge) => visibleIDs.has(edge.from) && visibleIDs.has(edge.to));
  const centerX = (graphCanvasWidth - graphNodeWidth) / 2;
  const centerY = (graphCanvasHeight - graphNodeHeight) / 2;
  const positions = new Map<string, { x: number; y: number }>();
  const ranks = rankDependencyNodes(tasks, visibleEdges);
  const sortedTasks = [...tasks].sort((a, b) => {
    if (a.id === selectedTaskId) {
      return -1;
    }
    if (b.id === selectedTaskId) {
      return 1;
    }
    const rankDiff = (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.title.localeCompare(b.title);
  });
  const rankValues = Array.from(new Set(sortedTasks.map((task) => ranks.get(task.id) ?? 0))).sort((a, b) => a - b);
  const rankIndexByValue = new Map(rankValues.map((rank, index) => [rank, index]));
  const tasksByRank = new Map<number, Task[]>();

  sortedTasks.forEach((task) => {
    const rank = ranks.get(task.id) ?? 0;
    tasksByRank.set(rank, [...(tasksByRank.get(rank) ?? []), task]);
  });

  tasksByRank.forEach((rankTasks, rank) => {
    const rankIndex = rankIndexByValue.get(rank) ?? 0;
    const rankProgress = rankValues.length <= 1 ? 0.5 : rankIndex / (rankValues.length - 1);
    const xBase = graphPadding + rankProgress * (graphCanvasWidth - graphNodeWidth - graphPadding * 2);
    const groupHeight = (rankTasks.length - 1) * 124;

    rankTasks.forEach((task, index) => {
      const organicOffset = seededAngle(task.id);
      const xJitter = Math.cos(organicOffset) * 34;
      const yJitter = Math.sin(organicOffset) * 18;
      const yBase = centerY - groupHeight / 2 + index * 124;
      positions.set(task.id, {
        x: clamp(xBase + xJitter, graphPadding, graphCanvasWidth - graphNodeWidth - graphPadding),
        y: clamp(yBase + yJitter, graphPadding, graphCanvasHeight - graphNodeHeight - graphPadding),
      });
    });
  });

  if (selectedTaskId && positions.has(selectedTaskId)) {
    positions.set(selectedTaskId, {
      x: centerX,
      y: centerY,
    });
  }

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const forces = new Map(sortedTasks.map((task) => [task.id, { x: 0, y: 0 }]));

    sortedTasks.forEach((a, index) => {
      sortedTasks.slice(index + 1).forEach((b) => {
        const aPosition = positions.get(a.id);
        const bPosition = positions.get(b.id);
        const aForce = forces.get(a.id);
        const bForce = forces.get(b.id);
        if (!aPosition || !bPosition || !aForce || !bForce) {
          return;
        }
        const dx = aPosition.x - bPosition.x;
        const dy = aPosition.y - bPosition.y;
        const overlapX = graphNodeWidth + 66 - Math.abs(dx);
        const overlapY = graphNodeHeight + 50 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          return;
        }
        const distanceSquared = Math.max(dx * dx + dy * dy, 100);
        const distance = Math.sqrt(distanceSquared);
        const strength = Math.min(7.5, Math.max(overlapX, overlapY) * 0.12);
        const fx = (dx / distance) * strength;
        const fy = (dy / distance) * strength;
        aForce.x += fx;
        aForce.y += fy;
        bForce.x -= fx;
        bForce.y -= fy;
      });
    });

    visibleEdges.forEach((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      const fromForce = forces.get(edge.from);
      const toForce = forces.get(edge.to);
      if (!from || !to || !fromForce || !toForce) {
        return;
      }
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const targetDistance = 285;
      const strength = (distance - targetDistance) * 0.004;
      const fx = (dx / distance) * strength;
      const fy = (dy / distance) * strength;
      fromForce.x += fx;
      fromForce.y += fy;
      toForce.x -= fx;
      toForce.y -= fy;
    });

    sortedTasks.forEach((task) => {
      const position = positions.get(task.id);
      const force = forces.get(task.id);
      if (!position || !force) {
        return;
      }
      const rank = ranks.get(task.id) ?? 0;
      const rankIndex = rankIndexByValue.get(rank) ?? 0;
      const rankProgress = rankValues.length <= 1 ? 0.5 : rankIndex / (rankValues.length - 1);
      const anchorX = task.id === selectedTaskId ? centerX : graphPadding + rankProgress * (graphCanvasWidth - graphNodeWidth - graphPadding * 2);
      const gravity = task.id === selectedTaskId ? 0.035 : 0.018;
      force.x += (anchorX - position.x) * gravity;
      force.y += (centerY - position.y) * 0.002;
      position.x = clamp(position.x + force.x, graphPadding, graphCanvasWidth - graphNodeWidth - graphPadding);
      position.y = clamp(position.y + force.y, graphPadding, graphCanvasHeight - graphNodeHeight - graphPadding);
    });
  }

  return sortedTasks.map((task) => {
    const position = positions.get(task.id) ?? { x: centerX, y: centerY };
    return {
      id: task.id,
      task,
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
  });
}

function rankDependencyNodes(tasks: Task[], edges: DependencyGraphEdge[]) {
  const visibleIDs = new Set(tasks.map((task) => task.id));
  const dependenciesByTask = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const rankCache = new Map<string, number>();

  edges.forEach((edge) => {
    if (!visibleIDs.has(edge.from) || !visibleIDs.has(edge.to)) {
      return;
    }
    dependenciesByTask.set(edge.to, [...(dependenciesByTask.get(edge.to) ?? []), edge.from]);
  });

  const visit = (taskId: string, visiting = new Set<string>()): number => {
    const cached = rankCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(taskId)) {
      return 0;
    }
    visiting.add(taskId);
    const dependencies = dependenciesByTask.get(taskId) ?? [];
    const rank = dependencies.length === 0 ? 0 : Math.max(...dependencies.map((dependencyId) => visit(dependencyId, visiting))) + 1;
    visiting.delete(taskId);
    rankCache.set(taskId, rank);
    return rank;
  };

  tasks.forEach((task) => visit(task.id));
  return rankCache;
}

function seededAngle(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100000;
  }
  return (hash / 100000) * Math.PI * 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function collectUpstreamDependencies(taskId: string, tasks: Map<string, Task>, acc: Set<string>) {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }
  (task.dependencies ?? []).forEach((dependencyId) => {
    if (acc.has(dependencyId)) {
      return;
    }
    acc.add(dependencyId);
    collectUpstreamDependencies(dependencyId, tasks, acc);
  });
}

function collectDownstreamDependents(taskId: string, tasks: Task[], acc: Set<string>) {
  tasks.forEach((task) => {
    if (!(task.dependencies ?? []).includes(taskId) || acc.has(task.id)) {
      return;
    }
    acc.add(task.id);
    collectDownstreamDependents(task.id, tasks, acc);
  });
}

function taskDependsOn(taskId: string, targetTaskId: string, tasks: Record<string, Task>, visited = new Set<string>()): boolean {
  if (visited.has(taskId)) {
    return false;
  }
  visited.add(taskId);
  const task = tasks[taskId];
  if (!task) {
    return false;
  }
  const dependencies = task.dependencies ?? [];
  return dependencies.some((dependencyId) => dependencyId === targetTaskId || taskDependsOn(dependencyId, targetTaskId, tasks, visited));
}

function readError(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong";
}

function formatStatus(status: TaskStatus) {
  return status.replace("_", " ");
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function dependencyEdgePath(from: DependencyGraphNode, to: DependencyGraphNode) {
  const fromCenter = nodeCenter(from);
  const toCenter = nodeCenter(to);
  const start = nodeBoundaryPoint(from, toCenter, 8);
  const end = nodeBoundaryPoint(to, fromCenter, 16);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const controlOffset = Math.max(52, Math.min(150, Math.sqrt(dx * dx + dy * dy) * 0.38));

  if (Math.abs(dx) > Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    return `M ${start.x} ${start.y} C ${start.x + controlOffset * direction} ${start.y}, ${end.x - controlOffset * direction} ${end.y}, ${end.x} ${end.y}`;
  }

  const direction = dy >= 0 ? 1 : -1;
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + controlOffset * direction}, ${end.x} ${end.y - controlOffset * direction}, ${end.x} ${end.y}`;
}

function nodeCenter(node: Pick<DependencyGraphNode, "x" | "y">) {
  return {
    x: node.x + graphNodeWidth / 2,
    y: node.y + graphNodeHeight / 2,
  };
}

function nodeBoundaryPoint(node: Pick<DependencyGraphNode, "x" | "y">, toward: { x: number; y: number }, offset: number) {
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const unitX = dx / distance;
  const unitY = dy / distance;
  const scaleX = unitX === 0 ? Number.POSITIVE_INFINITY : graphNodeWidth / 2 / Math.abs(unitX);
  const scaleY = unitY === 0 ? Number.POSITIVE_INFINITY : graphNodeHeight / 2 / Math.abs(unitY);
  const scale = Math.min(scaleX, scaleY);

  return {
    x: Math.round(center.x + unitX * (scale + offset)),
    y: Math.round(center.y + unitY * (scale + offset)),
  };
}

function DependencyGraphModal({
  graph,
  onClose,
  onSelectTask,
  selectedTaskId,
}: {
  graph: DependencyGraph;
  onClose: () => void;
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string;
}) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragState, setDragState] = useState<{
    id: string;
    originX: number;
    originY: number;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const didDragNodeRef = useRef(false);
  const renderedNodes = graph.nodes.map((node) => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) }));
  const nodeByID = new Map(renderedNodes.map((node) => [node.id, node]));
  const width = graphCanvasWidth;
  const height = graphCanvasHeight;
  const mouseDownRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setPositions(Object.fromEntries(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }])));
    setDragState(null);
  }, [graph]);

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: DependencyGraphNode) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = positions[node.id] ?? { x: node.x, y: node.y };
    didDragNodeRef.current = false;
    setDragState({
      id: node.id,
      originX: position.x,
      originY: position.y,
      pointerX: event.clientX,
      pointerY: event.clientY,
    });
  };

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragState) {
      return;
    }
    const nextX = clamp(dragState.originX + event.clientX - dragState.pointerX, graphPadding, width - graphNodeWidth - graphPadding);
    const nextY = clamp(dragState.originY + event.clientY - dragState.pointerY, graphPadding, height - graphNodeHeight - graphPadding);
    if (Math.abs(event.clientX - dragState.pointerX) > 4 || Math.abs(event.clientY - dragState.pointerY) > 4) {
      didDragNodeRef.current = true;
    }
    setPositions((current) => ({ ...current, [dragState.id]: { x: nextX, y: nextY } }));
  };

  const handleNodePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragState) {
      if (Math.abs(event.clientX - dragState.pointerX) > 4 || Math.abs(event.clientY - dragState.pointerY) > 4) {
        didDragNodeRef.current = true;
      }
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
  };

  const handleNodeMouseDown = (event: ReactMouseEvent<HTMLButtonElement>) => {
    mouseDownRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleNodeMouseMove = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const mouseDown = mouseDownRef.current;
    if (!mouseDown) {
      return;
    }
    if (Math.abs(event.clientX - mouseDown.x) > 4 || Math.abs(event.clientY - mouseDown.y) > 4) {
      didDragNodeRef.current = true;
    }
  };

  const handleNodeMouseUp = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const mouseDown = mouseDownRef.current;
    if (mouseDown && (Math.abs(event.clientX - mouseDown.x) > 4 || Math.abs(event.clientY - mouseDown.y) > 4)) {
      didDragNodeRef.current = true;
    }
    mouseDownRef.current = null;
  };

  return (
    <div className="modal-backdrop graph-backdrop" role="presentation">
      <section className="graph-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-graph-title">
        <div className="graph-header">
          <div>
            <p className="eyebrow">Dependency graph</p>
            <h2 id="dependency-graph-title">Board dependency map</h2>
          </div>
          <button className="button secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="graph-legend freeform">
          <span>Drag nodes to rearrange</span>
          <span>Arrow points from blocker to blocked task</span>
        </div>
        <div className="graph-canvas">
          <svg className="graph-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <defs>
              <marker id="dependency-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6.5" refY="3.5">
                <path d="M0,0 L7,3.5 L0,7 Z" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = nodeByID.get(edge.from);
              const to = nodeByID.get(edge.to);
              if (!from || !to) {
                return null;
              }

              return (
                <path
                  d={dependencyEdgePath(from, to)}
                  key={`${edge.from}-${edge.to}`}
                  markerEnd="url(#dependency-arrow)"
                />
              );
            })}
          </svg>
          <div className="graph-nodes" style={{ width, height }}>
            {renderedNodes.map((node) => (
              <button
                className={`graph-node ${node.id === selectedTaskId ? "active" : ""} ${dragState?.id === node.id ? "dragging" : ""}`}
                key={node.id}
                type="button"
                style={{ left: node.x, top: node.y }}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
                onPointerMove={handleNodePointerMove}
                onPointerUp={handleNodePointerUp}
                onPointerCancel={() => setDragState(null)}
                onMouseDown={handleNodeMouseDown}
                onMouseMove={handleNodeMouseMove}
                onMouseUp={handleNodeMouseUp}
                onClick={(event) => {
                  if (didDragNodeRef.current) {
                    event.preventDefault();
                    didDragNodeRef.current = false;
                    return;
                  }
                  onSelectTask(node.id);
                }}
              >
                <strong>{node.task.title}</strong>
                <span>{formatStatus(node.task.status)}</span>
              </button>
            ))}
            {graph.nodes.length === 0 ? <div className="empty compact graph-empty">No loaded tasks to graph yet.</div> : null}
          </div>
        </div>
        {graph.missingDependencyCount > 0 ? <p className="helper-text">Some dependency links point to tasks that are not loaded yet.</p> : null}
      </section>
    </div>
  );
}

function VirtualTaskColumn({
  activeTaskId,
  archived,
  canDrag,
  draggedTaskId,
  onDragEnd,
  onDragStart,
  onSelectTask,
  tasks,
}: {
  activeTaskId: string;
  archived: boolean;
  canDrag: boolean;
  draggedTaskId: string;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>, taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  tasks: Task[];
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportHeight = 560;
  const totalHeight = tasks.length * taskCardHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / taskCardHeight) - virtualOverscan);
  const visibleCount = Math.ceil(viewportHeight / taskCardHeight) + virtualOverscan * 2;
  const visibleTasks = tasks.slice(startIndex, startIndex + visibleCount);

  if (tasks.length === 0) {
    return <div className="empty">No tasks</div>;
  }

  return (
    <div
      className="virtual-list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{ maxHeight: viewportHeight }}
    >
      <div className="virtual-spacer" style={{ height: totalHeight }}>
        <div className="virtual-window" style={{ transform: `translateY(${startIndex * taskCardHeight}px)` }}>
          {visibleTasks.map((task) => (
            <button
              className={`task-card ${archived ? "archived" : ""} ${activeTaskId === task.id ? "active" : ""} ${draggedTaskId === task.id ? "dragging" : ""}`}
              data-task-card="true"
              draggable={canDrag}
              key={task.id}
              type="button"
              onDragEnd={onDragEnd}
              onDragStart={(event) => onDragStart(event, task.id)}
              onClick={() => onSelectTask(task.id)}
            >
              <h3>{task.title}</h3>
              <div className="task-meta">
                <span className="priority">{task.configuration.priority || "medium"}</span>
                {task.assignedTo.length > 0 ? <span>{task.assignedTo.join(", ")}</span> : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
