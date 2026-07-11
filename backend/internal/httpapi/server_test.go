package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"happyrobot/backend/internal/domain"
	"happyrobot/backend/internal/realtime"
	"happyrobot/backend/internal/store"
)

func TestSplitPath(t *testing.T) {
	got := splitPath("/project-1/tasks/task-2/comments/")
	want := []string{"project-1", "tasks", "task-2", "comments"}

	if len(got) != len(want) {
		t.Fatalf("splitPath length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitPath[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestListTasksPassesPaginationOptions(t *testing.T) {
	mock := &mockProjectStore{
		listTasksFunc: func(_ context.Context, projectID string, options store.TaskListOptions) (domain.TaskPage, error) {
			if projectID != "project-1" {
				t.Fatalf("projectID = %q, want project-1", projectID)
			}
			if options.Limit != 25 {
				t.Fatalf("Limit = %d, want 25", options.Limit)
			}
			if options.Cursor != "cursor-123" {
				t.Fatalf("Cursor = %q, want cursor-123", options.Cursor)
			}
			return domain.TaskPage{
				Items: []domain.Task{
					{
						ID:        "task-1",
						ProjectID: "project-1",
						Title:     "Design sync",
						Status:    domain.TaskStatusTodo,
						CreatedAt: time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC),
						UpdatedAt: time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC),
					},
				},
				NextCursor: "cursor-456",
			}, nil
		},
	}
	server := NewServer(mock, realtime.NewHub()).Routes()
	request := httptest.NewRequest(http.MethodGet, "/api/projects/project-1/tasks?limit=25&cursor=cursor-123", nil)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if mock.listTasksCalls != 1 {
		t.Fatalf("ListTasks calls = %d, want 1", mock.listTasksCalls)
	}

	var page domain.TaskPage
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items length = %d, want 1", len(page.Items))
	}
	if page.Items[0].ID != "task-1" {
		t.Fatalf("task id = %q, want task-1", page.Items[0].ID)
	}
	if page.NextCursor != "cursor-456" {
		t.Fatalf("nextCursor = %q, want cursor-456", page.NextCursor)
	}
}

func TestListTasksRejectsInvalidLimitBeforeStore(t *testing.T) {
	mock := &mockProjectStore{}
	server := NewServer(mock, realtime.NewHub()).Routes()
	request := httptest.NewRequest(http.MethodGet, "/api/projects/project-1/tasks?limit=-1", nil)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if mock.listTasksCalls != 0 {
		t.Fatalf("ListTasks calls = %d, want 0", mock.listTasksCalls)
	}
}

func TestListProjectsPassesIncludeArchived(t *testing.T) {
	mock := &mockProjectStore{}
	server := NewServer(mock, realtime.NewHub()).Routes()
	request := httptest.NewRequest(http.MethodGet, "/api/projects?includeArchived=true", nil)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if !mock.listProjectsIncludeArchived {
		t.Fatal("ListProjects includeArchived = false, want true")
	}
}

func TestUnarchiveProjectRoute(t *testing.T) {
	mock := &mockProjectStore{}
	server := NewServer(mock, realtime.NewHub()).Routes()
	request := httptest.NewRequest(http.MethodPost, "/api/projects/project-1/unarchive", nil)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusNoContent, response.Body.String())
	}
	if mock.unarchiveProjectID != "project-1" {
		t.Fatalf("UnarchiveProject projectID = %q, want project-1", mock.unarchiveProjectID)
	}
}

func TestProjectMetricsRoute(t *testing.T) {
	mock := &mockProjectStore{
		projectMetrics: domain.ProjectProgressDashboard{
			TotalProjects: 1,
			TotalTasks:    3,
			StatusCounts:  domain.StatusCounts{Todo: 1, InProgress: 1, Done: 1},
			Projects: []domain.ProjectProgress{
				{ProjectID: "project-1", Name: "Launch", TotalTasks: 3, CompletionPercent: 33.33333333333333},
			},
		},
	}
	server := NewServer(mock, realtime.NewHub()).Routes()
	request := httptest.NewRequest(http.MethodGet, "/api/metrics/projects", nil)
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var dashboard domain.ProjectProgressDashboard
	if err := json.NewDecoder(response.Body).Decode(&dashboard); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if dashboard.TotalProjects != 1 || dashboard.TotalTasks != 3 {
		t.Fatalf("dashboard summary = projects:%d tasks:%d, want projects:1 tasks:3", dashboard.TotalProjects, dashboard.TotalTasks)
	}
	if len(dashboard.Projects) != 1 || dashboard.Projects[0].ProjectID != "project-1" {
		t.Fatalf("dashboard projects = %#v, want project-1", dashboard.Projects)
	}
}

type mockProjectStore struct {
	listProjectsIncludeArchived bool
	unarchiveProjectID          string
	projectMetrics              domain.ProjectProgressDashboard
	listTasksCalls              int
	listTasksFunc               func(context.Context, string, store.TaskListOptions) (domain.TaskPage, error)
}

func (m *mockProjectStore) ListProjects(_ context.Context, includeArchived bool) ([]domain.Project, error) {
	m.listProjectsIncludeArchived = includeArchived
	return []domain.Project{}, nil
}

func (m *mockProjectStore) ProjectProgressDashboard(context.Context) (domain.ProjectProgressDashboard, error) {
	return m.projectMetrics, nil
}

func (m *mockProjectStore) CreateProject(context.Context, string, string, map[string]any) (domain.Project, domain.Event, error) {
	return domain.Project{}, domain.Event{}, nil
}

func (m *mockProjectStore) UpdateProject(context.Context, string, store.ProjectPatch) (domain.Project, domain.Event, error) {
	return domain.Project{}, domain.Event{}, nil
}

func (m *mockProjectStore) ArchiveProject(context.Context, string) (domain.Event, error) {
	return domain.Event{}, nil
}

func (m *mockProjectStore) UnarchiveProject(_ context.Context, projectID string) (domain.Event, error) {
	m.unarchiveProjectID = projectID
	return domain.Event{}, nil
}

func (m *mockProjectStore) DeleteProject(context.Context, string) (domain.Event, error) {
	return domain.Event{}, nil
}

func (m *mockProjectStore) Snapshot(context.Context, string) (domain.ProjectSnapshot, error) {
	return domain.ProjectSnapshot{}, nil
}

func (m *mockProjectStore) ListTasks(ctx context.Context, projectID string, options store.TaskListOptions) (domain.TaskPage, error) {
	m.listTasksCalls++
	if m.listTasksFunc != nil {
		return m.listTasksFunc(ctx, projectID, options)
	}
	return domain.TaskPage{}, nil
}

func (m *mockProjectStore) CreateTask(context.Context, string, domain.Task) (domain.Task, domain.Event, error) {
	return domain.Task{}, domain.Event{}, nil
}

func (m *mockProjectStore) UpdateTask(context.Context, string, string, store.TaskPatch) (domain.Task, domain.Event, error) {
	return domain.Task{}, domain.Event{}, nil
}

func (m *mockProjectStore) DeleteTask(context.Context, string, string) (domain.Event, error) {
	return domain.Event{}, nil
}

func (m *mockProjectStore) ListComments(context.Context, string, string) ([]domain.Comment, error) {
	return nil, nil
}

func (m *mockProjectStore) CreateComment(context.Context, string, string, string, string) (domain.Comment, domain.Event, error) {
	return domain.Comment{}, domain.Event{}, nil
}

func (m *mockProjectStore) UpdateComment(context.Context, string, string, string, string) (domain.Comment, domain.Event, error) {
	return domain.Comment{}, domain.Event{}, nil
}

func (m *mockProjectStore) ListEventsAfter(context.Context, string, int64) ([]domain.Event, error) {
	return nil, nil
}
