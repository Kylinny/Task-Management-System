package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"happyrobot/backend/internal/domain"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrInvalidInput  = errors.New("invalid input")
	ErrInvalidStatus = errors.New("invalid status transition")
)

type PostgresStore struct {
	db *pgxpool.Pool
}

func NewPostgresStore(db *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{db: db}
}

func (s *PostgresStore) EnsureSchema(ctx context.Context) error {
	_, err := s.db.Exec(ctx, `ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`)
	return err
}

func (s *PostgresStore) ListProjects(ctx context.Context, includeArchived bool) ([]domain.Project, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, description, metadata, version, archived_at, created_at, updated_at
		FROM projects
		WHERE $1::boolean OR archived_at IS NULL
		ORDER BY archived_at IS NOT NULL, updated_at DESC`, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var projects []domain.Project
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	if projects == nil {
		projects = []domain.Project{}
	}
	return projects, rows.Err()
}

func (s *PostgresStore) ProjectProgressDashboard(ctx context.Context) (domain.ProjectProgressDashboard, error) {
	var dashboard domain.ProjectProgressDashboard
	dashboard.GeneratedAt = time.Now()
	if err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM projects WHERE archived_at IS NOT NULL`).Scan(&dashboard.ArchivedProjects); err != nil {
		return domain.ProjectProgressDashboard{}, err
	}

	rows, err := s.db.Query(ctx, `
		WITH task_counts AS (
			SELECT
				project_id,
				COUNT(*)::int AS total_tasks,
				COUNT(*) FILTER (WHERE status = 'todo')::int AS todo,
				COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
				COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
				COUNT(*) FILTER (WHERE status = 'done')::int AS done
			FROM tasks
			GROUP BY project_id
		),
		comment_counts AS (
			SELECT t.project_id, COUNT(c.id)::int AS comment_count
			FROM tasks t
			LEFT JOIN comments c ON c.task_id = t.id
			GROUP BY t.project_id
		)
		SELECT
			p.id,
			p.name,
			p.description,
			p.updated_at,
			COALESCE(tc.total_tasks, 0),
			COALESCE(tc.todo, 0),
			COALESCE(tc.in_progress, 0),
			COALESCE(tc.blocked, 0),
			COALESCE(tc.done, 0),
			COALESCE(cc.comment_count, 0)
		FROM projects p
		LEFT JOIN task_counts tc ON tc.project_id = p.id
		LEFT JOIN comment_counts cc ON cc.project_id = p.id
		WHERE p.archived_at IS NULL
		ORDER BY p.updated_at DESC`)
	if err != nil {
		return domain.ProjectProgressDashboard{}, err
	}
	defer rows.Close()

	for rows.Next() {
		var progress domain.ProjectProgress
		if err := rows.Scan(
			&progress.ProjectID,
			&progress.Name,
			&progress.Description,
			&progress.UpdatedAt,
			&progress.TotalTasks,
			&progress.StatusCounts.Todo,
			&progress.StatusCounts.InProgress,
			&progress.StatusCounts.Blocked,
			&progress.StatusCounts.Done,
			&progress.CommentCount,
		); err != nil {
			return domain.ProjectProgressDashboard{}, err
		}
		progress.CompletionPercent = percent(progress.StatusCounts.Done, progress.TotalTasks)
		progress.BlockedPercent = percent(progress.StatusCounts.Blocked, progress.TotalTasks)
		dashboard.TotalProjects++
		dashboard.TotalTasks += progress.TotalTasks
		dashboard.TotalComments += progress.CommentCount
		dashboard.StatusCounts.Todo += progress.StatusCounts.Todo
		dashboard.StatusCounts.InProgress += progress.StatusCounts.InProgress
		dashboard.StatusCounts.Blocked += progress.StatusCounts.Blocked
		dashboard.StatusCounts.Done += progress.StatusCounts.Done
		dashboard.Projects = append(dashboard.Projects, progress)
	}
	if err := rows.Err(); err != nil {
		return domain.ProjectProgressDashboard{}, err
	}
	if dashboard.Projects == nil {
		dashboard.Projects = []domain.ProjectProgress{}
	}
	return dashboard, nil
}

func (s *PostgresStore) CreateProject(ctx context.Context, name, description string, metadata map[string]any) (domain.Project, domain.Event, error) {
	if name == "" {
		return domain.Project{}, domain.Event{}, fmt.Errorf("%w: project name is required", ErrInvalidInput)
	}
	if metadata == nil {
		metadata = map[string]any{}
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	project := domain.Project{
		ID:          newID(),
		Name:        name,
		Description: description,
		Metadata:    metadata,
		Version:     1,
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}

	err = tx.QueryRow(ctx, `
		INSERT INTO projects (id, name, description, metadata, version)
		VALUES ($1, $2, $3, $4, 1)
		RETURNING created_at, updated_at`,
		project.ID, project.Name, project.Description, metadataJSON,
	).Scan(&project.CreatedAt, &project.UpdatedAt)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}

	event, err := insertEvent(ctx, tx, project.ID, "project.created", project.ID, 1, project)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	return project, event, nil
}

func (s *PostgresStore) UpdateProject(ctx context.Context, projectID string, patch ProjectPatch) (domain.Project, domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	project, err := getProjectForUpdate(ctx, tx, projectID)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	if patch.Name != nil {
		if *patch.Name == "" {
			return domain.Project{}, domain.Event{}, fmt.Errorf("%w: project name cannot be empty", ErrInvalidInput)
		}
		project.Name = *patch.Name
	}
	if patch.Description != nil {
		project.Description = *patch.Description
	}

	err = tx.QueryRow(ctx, `
		UPDATE projects
		SET name = $2, description = $3, version = version + 1, updated_at = now()
		WHERE id = $1
		RETURNING version, updated_at`, project.ID, project.Name, project.Description).Scan(&project.Version, &project.UpdatedAt)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}

	event, err := insertEvent(ctx, tx, project.ID, "project.updated", project.ID, project.Version, project)
	if err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Project{}, domain.Event{}, err
	}
	return project, event, nil
}

func (s *PostgresStore) ArchiveProject(ctx context.Context, projectID string) (domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Event{}, err
	}
	defer rollback(ctx, tx)

	project, err := getProjectForUpdate(ctx, tx, projectID)
	if err != nil {
		return domain.Event{}, err
	}
	if project.ArchivedAt != nil {
		if err := tx.Commit(ctx); err != nil {
			return domain.Event{}, err
		}
		return domain.Event{
			ProjectID: projectID,
			EntityID:  projectID,
			Type:      "project.archived",
			Version:   project.Version,
			Payload:   domain.ArchivedProject{ID: projectID, ArchivedAt: *project.ArchivedAt},
			CreatedAt: time.Now(),
		}, nil
	}

	var archivedAt time.Time
	err = tx.QueryRow(ctx, `
		UPDATE projects
		SET archived_at = now(), version = version + 1, updated_at = now()
		WHERE id = $1
		RETURNING archived_at, version`, projectID).Scan(&archivedAt, &project.Version)
	if err != nil {
		return domain.Event{}, err
	}

	event, err := insertEvent(ctx, tx, projectID, "project.archived", projectID, project.Version, domain.ArchivedProject{ID: projectID, ArchivedAt: archivedAt})
	if err != nil {
		return domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Event{}, err
	}
	return event, nil
}

func (s *PostgresStore) UnarchiveProject(ctx context.Context, projectID string) (domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Event{}, err
	}
	defer rollback(ctx, tx)

	project, err := getProjectForUpdate(ctx, tx, projectID)
	if err != nil {
		return domain.Event{}, err
	}
	if project.ArchivedAt == nil {
		if err := tx.Commit(ctx); err != nil {
			return domain.Event{}, err
		}
		return domain.Event{
			ProjectID: projectID,
			EntityID:  projectID,
			Type:      "project.unarchived",
			Version:   project.Version,
			Payload:   domain.UnarchivedProject{ID: projectID},
			CreatedAt: time.Now(),
		}, nil
	}

	err = tx.QueryRow(ctx, `
		UPDATE projects
		SET archived_at = NULL, version = version + 1, updated_at = now()
		WHERE id = $1
		RETURNING version, updated_at`, projectID).Scan(&project.Version, &project.UpdatedAt)
	if err != nil {
		return domain.Event{}, err
	}
	project.ArchivedAt = nil

	event, err := insertEvent(ctx, tx, projectID, "project.unarchived", projectID, project.Version, project)
	if err != nil {
		return domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Event{}, err
	}
	return event, nil
}

func (s *PostgresStore) DeleteProject(ctx context.Context, projectID string) (domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Event{}, err
	}
	defer rollback(ctx, tx)

	project, err := getProjectForUpdate(ctx, tx, projectID)
	if err != nil {
		return domain.Event{}, err
	}

	event, err := insertEvent(ctx, tx, projectID, "project.deleted", projectID, project.Version+1, domain.DeletedProject{ID: projectID})
	if err != nil {
		return domain.Event{}, err
	}

	tag, err := tx.Exec(ctx, `DELETE FROM projects WHERE id = $1`, projectID)
	if err != nil {
		return domain.Event{}, err
	}
	if tag.RowsAffected() == 0 {
		return domain.Event{}, ErrNotFound
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Event{}, err
	}
	return event, nil
}

func (s *PostgresStore) Snapshot(ctx context.Context, projectID string) (domain.ProjectSnapshot, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return domain.ProjectSnapshot{}, err
	}
	defer rollback(ctx, tx)

	project, err := getProject(ctx, tx, projectID)
	if err != nil {
		return domain.ProjectSnapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.ProjectSnapshot{}, err
	}
	return domain.ProjectSnapshot{Project: project, Tasks: []domain.Task{}, Comments: []domain.Comment{}}, nil
}

func (s *PostgresStore) ListTasks(ctx context.Context, projectID string, options TaskListOptions) (domain.TaskPage, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return domain.TaskPage{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProject(ctx, tx, projectID); err != nil {
		return domain.TaskPage{}, err
	}

	limit := options.limit()
	cursor, err := decodeTaskCursor(options.Cursor)
	if err != nil {
		return domain.TaskPage{}, err
	}

	tasks, err := listTasksPage(ctx, tx, projectID, limit+1, cursor)
	if err != nil {
		return domain.TaskPage{}, err
	}
	if tasks == nil {
		tasks = []domain.Task{}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.TaskPage{}, err
	}

	page := domain.TaskPage{Items: tasks}
	if len(tasks) > limit {
		page.Items = tasks[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeTaskCursor(taskCursor{CreatedAt: last.CreatedAt, ID: last.ID})
	}
	return page, nil
}

func (s *PostgresStore) CreateTask(ctx context.Context, projectID string, input domain.Task) (domain.Task, domain.Event, error) {
	if input.Title == "" {
		return domain.Task{}, domain.Event{}, fmt.Errorf("%w: task title is required", ErrInvalidInput)
	}
	if input.Status == "" {
		input.Status = domain.TaskStatusTodo
	}
	if !isKnownStatus(input.Status) {
		return domain.Task{}, domain.Event{}, fmt.Errorf("%w: unknown status %q", ErrInvalidInput, input.Status)
	}
	if input.Configuration.CustomFields == nil {
		input.Configuration.CustomFields = map[string]any{}
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProjectForUpdate(ctx, tx, projectID); err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	if err := validateDependencies(ctx, tx, projectID, "", input.Dependencies); err != nil {
		return domain.Task{}, domain.Event{}, err
	}

	task := input
	task.ID = newID()
	task.ProjectID = projectID
	task.Version = 1

	assignedToJSON, configJSON, err := taskJSON(task)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO tasks (id, project_id, title, status, assigned_to, configuration, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING created_at, updated_at`,
		task.ID, task.ProjectID, task.Title, task.Status, assignedToJSON, configJSON, task.Version,
	).Scan(&task.CreatedAt, &task.UpdatedAt)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	if err := replaceDependencies(ctx, tx, task.ID, task.Dependencies); err != nil {
		return domain.Task{}, domain.Event{}, err
	}

	projectVersion, err := bumpProjectVersion(ctx, tx, projectID)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	event, err := insertEvent(ctx, tx, projectID, "task.created", task.ID, projectVersion, task)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	return task, event, nil
}

func (s *PostgresStore) UpdateTask(ctx context.Context, projectID, taskID string, patch TaskPatch) (domain.Task, domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProjectForUpdate(ctx, tx, projectID); err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	task, err := getTaskForUpdate(ctx, tx, projectID, taskID)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}

	if patch.Title != nil {
		if *patch.Title == "" {
			return domain.Task{}, domain.Event{}, fmt.Errorf("%w: task title cannot be empty", ErrInvalidInput)
		}
		task.Title = *patch.Title
	}
	if patch.Status != nil {
		if !isKnownStatus(*patch.Status) {
			return domain.Task{}, domain.Event{}, fmt.Errorf("%w: unknown status %q", ErrInvalidInput, *patch.Status)
		}
		task.Status = *patch.Status
	}
	if patch.AssignedTo != nil {
		task.AssignedTo = *patch.AssignedTo
	}
	if patch.Configuration != nil {
		task.Configuration = *patch.Configuration
		if task.Configuration.CustomFields == nil {
			task.Configuration.CustomFields = map[string]any{}
		}
	}
	if patch.Dependencies != nil {
		if err := validateDependencies(ctx, tx, projectID, taskID, *patch.Dependencies); err != nil {
			return domain.Task{}, domain.Event{}, err
		}
		task.Dependencies = *patch.Dependencies
	}

	task.Version++
	assignedToJSON, configJSON, err := taskJSON(task)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	err = tx.QueryRow(ctx, `
		UPDATE tasks
		SET title = $3, status = $4, assigned_to = $5, configuration = $6, version = $7, updated_at = now()
		WHERE project_id = $1 AND id = $2
		RETURNING updated_at`,
		projectID, taskID, task.Title, task.Status, assignedToJSON, configJSON, task.Version,
	).Scan(&task.UpdatedAt)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	if patch.Dependencies != nil {
		if err := replaceDependencies(ctx, tx, task.ID, task.Dependencies); err != nil {
			return domain.Task{}, domain.Event{}, err
		}
	}

	projectVersion, err := bumpProjectVersion(ctx, tx, projectID)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	event, err := insertEvent(ctx, tx, projectID, "task.updated", task.ID, projectVersion, task)
	if err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Task{}, domain.Event{}, err
	}
	return task, event, nil
}

func (s *PostgresStore) DeleteTask(ctx context.Context, projectID, taskID string) (domain.Event, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Event{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProjectForUpdate(ctx, tx, projectID); err != nil {
		return domain.Event{}, err
	}
	if _, err := getTaskForUpdate(ctx, tx, projectID, taskID); err != nil {
		return domain.Event{}, err
	}

	var dependentID string
	err = tx.QueryRow(ctx, `
		SELECT td.task_id
		FROM task_dependencies td
		JOIN tasks t ON t.id = td.task_id
		WHERE t.project_id = $1 AND td.dependency_id = $2
		LIMIT 1`, projectID, taskID).Scan(&dependentID)
	if err == nil {
		return domain.Event{}, fmt.Errorf("%w: task is still depended on by %s", ErrInvalidInput, dependentID)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Event{}, err
	}

	tag, err := tx.Exec(ctx, `DELETE FROM tasks WHERE project_id = $1 AND id = $2`, projectID, taskID)
	if err != nil {
		return domain.Event{}, err
	}
	if tag.RowsAffected() == 0 {
		return domain.Event{}, ErrNotFound
	}

	projectVersion, err := bumpProjectVersion(ctx, tx, projectID)
	if err != nil {
		return domain.Event{}, err
	}
	event, err := insertEvent(ctx, tx, projectID, "task.deleted", taskID, projectVersion, map[string]string{"id": taskID})
	if err != nil {
		return domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Event{}, err
	}
	return event, nil
}

func (s *PostgresStore) ListComments(ctx context.Context, projectID, taskID string) ([]domain.Comment, error) {
	var exists bool
	if err := s.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM tasks WHERE project_id = $1 AND id = $2
		)`, projectID, taskID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}

	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.task_id, c.content, c.author, c.timestamp
		FROM comments c
		JOIN tasks t ON t.id = c.task_id
		WHERE t.project_id = $1 AND c.task_id = $2
		ORDER BY c.timestamp ASC`, projectID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var comments []domain.Comment
	for rows.Next() {
		var comment domain.Comment
		if err := rows.Scan(&comment.ID, &comment.TaskID, &comment.Content, &comment.Author, &comment.Timestamp); err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	if comments == nil {
		comments = []domain.Comment{}
	}
	return comments, rows.Err()
}

func (s *PostgresStore) CreateComment(ctx context.Context, projectID, taskID, content, author string) (domain.Comment, domain.Event, error) {
	if content == "" {
		return domain.Comment{}, domain.Event{}, fmt.Errorf("%w: comment content is required", ErrInvalidInput)
	}
	if author == "" {
		author = "anonymous"
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProjectForUpdate(ctx, tx, projectID); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	if _, err := getTaskForUpdate(ctx, tx, projectID, taskID); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}

	comment := domain.Comment{
		ID:      newID(),
		TaskID:  taskID,
		Content: content,
		Author:  author,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO comments (id, task_id, content, author)
		VALUES ($1, $2, $3, $4)
		RETURNING timestamp`,
		comment.ID, comment.TaskID, comment.Content, comment.Author,
	).Scan(&comment.Timestamp)
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}

	projectVersion, err := bumpProjectVersion(ctx, tx, projectID)
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	event, err := insertEvent(ctx, tx, projectID, "comment.created", comment.ID, projectVersion, comment)
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	return comment, event, nil
}

func (s *PostgresStore) UpdateComment(ctx context.Context, projectID, taskID, commentID, content string) (domain.Comment, domain.Event, error) {
	if content == "" {
		return domain.Comment{}, domain.Event{}, fmt.Errorf("%w: comment content is required", ErrInvalidInput)
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	defer rollback(ctx, tx)

	if _, err := getProjectForUpdate(ctx, tx, projectID); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	if _, err := getTaskForUpdate(ctx, tx, projectID, taskID); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}

	var comment domain.Comment
	err = tx.QueryRow(ctx, `
		UPDATE comments
		SET content = $3
		WHERE id = $1 AND task_id = $2
		RETURNING id, task_id, content, author, timestamp`,
		commentID, taskID, content,
	).Scan(&comment.ID, &comment.TaskID, &comment.Content, &comment.Author, &comment.Timestamp)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Comment{}, domain.Event{}, ErrNotFound
	}
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}

	projectVersion, err := bumpProjectVersion(ctx, tx, projectID)
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	event, err := insertEvent(ctx, tx, projectID, "comment.updated", comment.ID, projectVersion, comment)
	if err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Comment{}, domain.Event{}, err
	}
	return comment, event, nil
}

func (s *PostgresStore) ListEventsAfter(ctx context.Context, projectID string, after int64) ([]domain.Event, error) {
	rows, err := s.db.Query(ctx, `
		SELECT event_type, project_id, entity_id, version, payload, created_at
		FROM project_events
		WHERE project_id = $1 AND version > $2
		ORDER BY version ASC
		LIMIT 500`, projectID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []domain.Event
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

type TaskPatch struct {
	Title         *string                   `json:"title"`
	Status        *domain.TaskStatus        `json:"status"`
	AssignedTo    *[]string                 `json:"assignedTo"`
	Configuration *domain.TaskConfiguration `json:"configuration"`
	Dependencies  *[]string                 `json:"dependencies"`
}

type ProjectPatch struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type TaskListOptions struct {
	Limit  int
	Cursor string
}

type taskCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

type rowScanner interface {
	Scan(dest ...any) error
}

func getProject(ctx context.Context, tx pgx.Tx, projectID string) (domain.Project, error) {
	return scanProject(tx.QueryRow(ctx, `
		SELECT id, name, description, metadata, version, archived_at, created_at, updated_at
		FROM projects
		WHERE id = $1`, projectID))
}

func getProjectForUpdate(ctx context.Context, tx pgx.Tx, projectID string) (domain.Project, error) {
	return scanProject(tx.QueryRow(ctx, `
		SELECT id, name, description, metadata, version, archived_at, created_at, updated_at
		FROM projects
		WHERE id = $1
		FOR UPDATE`, projectID))
}

func getTaskForUpdate(ctx context.Context, tx pgx.Tx, projectID, taskID string) (domain.Task, error) {
	task, err := scanTask(tx.QueryRow(ctx, `
		SELECT id, project_id, title, status, assigned_to, configuration, version, created_at, updated_at
		FROM tasks
		WHERE project_id = $1 AND id = $2
		FOR UPDATE`, projectID, taskID))
	if err != nil {
		return domain.Task{}, err
	}
	deps, err := listTaskDependencies(ctx, tx, task.ID)
	if err != nil {
		return domain.Task{}, err
	}
	task.Dependencies = deps
	return task, nil
}

func listTasks(ctx context.Context, tx pgx.Tx, projectID string) ([]domain.Task, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, project_id, title, status, assigned_to, configuration, version, created_at, updated_at
		FROM tasks
		WHERE project_id = $1
		ORDER BY created_at ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []domain.Task
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	for i := range tasks {
		deps, err := listTaskDependencies(ctx, tx, tasks[i].ID)
		if err != nil {
			return nil, err
		}
		tasks[i].Dependencies = deps
	}
	return tasks, nil
}

func listTasksPage(ctx context.Context, tx pgx.Tx, projectID string, limit int, cursor taskCursor) ([]domain.Task, error) {
	args := []any{projectID, limit}
	where := `WHERE project_id = $1`
	if !cursor.CreatedAt.IsZero() && cursor.ID != "" {
		where += ` AND (created_at, id) > ($3, $4)`
		args = append(args, cursor.CreatedAt, cursor.ID)
	}

	rows, err := tx.Query(ctx, fmt.Sprintf(`
		SELECT id, project_id, title, status, assigned_to, configuration, version, created_at, updated_at
		FROM tasks
		%s
		ORDER BY created_at ASC, id ASC
		LIMIT $2`, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []domain.Task
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	for i := range tasks {
		deps, err := listTaskDependencies(ctx, tx, tasks[i].ID)
		if err != nil {
			return nil, err
		}
		tasks[i].Dependencies = deps
	}
	return tasks, nil
}

func listProjectComments(ctx context.Context, tx pgx.Tx, projectID string) ([]domain.Comment, error) {
	rows, err := tx.Query(ctx, `
		SELECT c.id, c.task_id, c.content, c.author, c.timestamp
		FROM comments c
		JOIN tasks t ON t.id = c.task_id
		WHERE t.project_id = $1
		ORDER BY c.timestamp ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var comments []domain.Comment
	for rows.Next() {
		var comment domain.Comment
		if err := rows.Scan(&comment.ID, &comment.TaskID, &comment.Content, &comment.Author, &comment.Timestamp); err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	return comments, rows.Err()
}

func listTaskDependencies(ctx context.Context, tx pgx.Tx, taskID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT dependency_id
		FROM task_dependencies
		WHERE task_id = $1
		ORDER BY created_at ASC`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dependencies []string
	for rows.Next() {
		var dependencyID string
		if err := rows.Scan(&dependencyID); err != nil {
			return nil, err
		}
		dependencies = append(dependencies, dependencyID)
	}
	if dependencies == nil {
		dependencies = []string{}
	}
	return dependencies, rows.Err()
}

func validateDependencies(ctx context.Context, tx pgx.Tx, projectID, taskID string, dependencies []string) error {
	seen := map[string]bool{}
	for _, dependencyID := range dependencies {
		if dependencyID == taskID {
			return fmt.Errorf("%w: task cannot depend on itself", ErrInvalidInput)
		}
		if seen[dependencyID] {
			return fmt.Errorf("%w: duplicate dependency %s", ErrInvalidInput, dependencyID)
		}
		seen[dependencyID] = true

		var exists bool
		err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM tasks WHERE project_id = $1 AND id = $2
			)`, projectID, dependencyID).Scan(&exists)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("%w: dependency %s not found", ErrInvalidInput, dependencyID)
		}
		if taskID != "" {
			wouldCycle, err := dependencyWouldCreateCycle(ctx, tx, dependencyID, taskID)
			if err != nil {
				return err
			}
			if wouldCycle {
				return fmt.Errorf("%w: dependency %s would create a cycle", ErrInvalidInput, dependencyID)
			}
		}
	}
	return nil
}

func dependencyWouldCreateCycle(ctx context.Context, tx pgx.Tx, dependencyID, taskID string) (bool, error) {
	var wouldCycle bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE dependency_tree(dependency_id) AS (
			SELECT dependency_id
			FROM task_dependencies
			WHERE task_id = $1
			UNION
			SELECT td.dependency_id
			FROM task_dependencies td
			JOIN dependency_tree dt ON td.task_id = dt.dependency_id
		)
		SELECT EXISTS (
			SELECT 1 FROM dependency_tree WHERE dependency_id = $2
		)`, dependencyID, taskID).Scan(&wouldCycle)
	return wouldCycle, err
}

func replaceDependencies(ctx context.Context, tx pgx.Tx, taskID string, dependencies []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM task_dependencies WHERE task_id = $1`, taskID); err != nil {
		return err
	}
	for _, dependencyID := range dependencies {
		if _, err := tx.Exec(ctx, `
			INSERT INTO task_dependencies (task_id, dependency_id)
			VALUES ($1, $2)`, taskID, dependencyID); err != nil {
			return err
		}
	}
	return nil
}

func bumpProjectVersion(ctx context.Context, tx pgx.Tx, projectID string) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `
		UPDATE projects
		SET version = version + 1, updated_at = now()
		WHERE id = $1
		RETURNING version`, projectID).Scan(&version)
	return version, err
}

func insertEvent(ctx context.Context, tx pgx.Tx, projectID, eventType, entityID string, version int64, payload any) (domain.Event, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return domain.Event{}, err
	}
	event := domain.Event{
		Type:      eventType,
		ProjectID: projectID,
		EntityID:  entityID,
		Version:   version,
		Payload:   payload,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO project_events (project_id, event_type, entity_id, version, payload)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`,
		projectID, eventType, entityID, version, payloadJSON,
	).Scan(&event.CreatedAt)
	return event, err
}

func scanProject(scanner rowScanner) (domain.Project, error) {
	var project domain.Project
	var metadataJSON []byte
	if err := scanner.Scan(&project.ID, &project.Name, &project.Description, &metadataJSON, &project.Version, &project.ArchivedAt, &project.CreatedAt, &project.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Project{}, ErrNotFound
		}
		return domain.Project{}, err
	}
	if len(metadataJSON) > 0 {
		if err := json.Unmarshal(metadataJSON, &project.Metadata); err != nil {
			return domain.Project{}, err
		}
	}
	return project, nil
}

func scanTask(scanner rowScanner) (domain.Task, error) {
	var task domain.Task
	var assignedToJSON []byte
	var configJSON []byte
	if err := scanner.Scan(
		&task.ID,
		&task.ProjectID,
		&task.Title,
		&task.Status,
		&assignedToJSON,
		&configJSON,
		&task.Version,
		&task.CreatedAt,
		&task.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Task{}, ErrNotFound
		}
		return domain.Task{}, err
	}
	if len(assignedToJSON) > 0 {
		if err := json.Unmarshal(assignedToJSON, &task.AssignedTo); err != nil {
			return domain.Task{}, err
		}
	}
	if len(configJSON) > 0 {
		if err := json.Unmarshal(configJSON, &task.Configuration); err != nil {
			return domain.Task{}, err
		}
	}
	return task, nil
}

func scanEvent(scanner rowScanner) (domain.Event, error) {
	var event domain.Event
	var payloadJSON []byte
	if err := scanner.Scan(&event.Type, &event.ProjectID, &event.EntityID, &event.Version, &payloadJSON, &event.CreatedAt); err != nil {
		return domain.Event{}, err
	}
	if len(payloadJSON) > 0 {
		var payload any
		if err := json.Unmarshal(payloadJSON, &payload); err != nil {
			return domain.Event{}, err
		}
		event.Payload = payload
	}
	return event, nil
}

func taskJSON(task domain.Task) ([]byte, []byte, error) {
	assignedTo := task.AssignedTo
	if assignedTo == nil {
		assignedTo = []string{}
	}
	assignedToJSON, err := json.Marshal(assignedTo)
	if err != nil {
		return nil, nil, err
	}
	configJSON, err := json.Marshal(task.Configuration)
	if err != nil {
		return nil, nil, err
	}
	return assignedToJSON, configJSON, nil
}

func (options TaskListOptions) limit() int {
	if options.Limit <= 0 {
		return 50
	}
	if options.Limit > 200 {
		return 200
	}
	return options.Limit
}

func encodeTaskCursor(cursor taskCursor) string {
	body, err := json.Marshal(cursor)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(body)
}

func decodeTaskCursor(raw string) (taskCursor, error) {
	if raw == "" {
		return taskCursor{}, nil
	}
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return taskCursor{}, fmt.Errorf("%w: invalid cursor", ErrInvalidInput)
	}
	var cursor taskCursor
	if err := json.Unmarshal(body, &cursor); err != nil {
		return taskCursor{}, fmt.Errorf("%w: invalid cursor", ErrInvalidInput)
	}
	if cursor.CreatedAt.IsZero() || cursor.ID == "" {
		return taskCursor{}, fmt.Errorf("%w: invalid cursor", ErrInvalidInput)
	}
	return cursor, nil
}

func isKnownStatus(status domain.TaskStatus) bool {
	switch status {
	case domain.TaskStatusTodo, domain.TaskStatusInProgress, domain.TaskStatusBlocked, domain.TaskStatusDone:
		return true
	default:
		return false
	}
}

func canTransition(from, to domain.TaskStatus) bool {
	return isKnownStatus(from) && isKnownStatus(to)
}

func percent(part, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

func rollback(ctx context.Context, tx pgx.Tx) {
	_ = tx.Rollback(ctx)
}

func newID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	encoded := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32])
}
