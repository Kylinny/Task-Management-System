package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"happyrobot/backend/internal/domain"
	"happyrobot/backend/internal/realtime"
	"happyrobot/backend/internal/store"
)

type ProjectStore interface {
	ListProjects(context.Context, bool) ([]domain.Project, error)
	ProjectProgressDashboard(context.Context) (domain.ProjectProgressDashboard, error)
	CreateProject(context.Context, string, string, map[string]any) (domain.Project, domain.Event, error)
	UpdateProject(context.Context, string, store.ProjectPatch) (domain.Project, domain.Event, error)
	ArchiveProject(context.Context, string) (domain.Event, error)
	UnarchiveProject(context.Context, string) (domain.Event, error)
	DeleteProject(context.Context, string) (domain.Event, error)
	Snapshot(context.Context, string) (domain.ProjectSnapshot, error)
	ListTasks(context.Context, string, store.TaskListOptions) (domain.TaskPage, error)
	CreateTask(context.Context, string, domain.Task) (domain.Task, domain.Event, error)
	UpdateTask(context.Context, string, string, store.TaskPatch) (domain.Task, domain.Event, error)
	DeleteTask(context.Context, string, string) (domain.Event, error)
	ListComments(context.Context, string, string) ([]domain.Comment, error)
	CreateComment(context.Context, string, string, string, string) (domain.Comment, domain.Event, error)
	UpdateComment(context.Context, string, string, string, string) (domain.Comment, domain.Event, error)
	ListEventsAfter(context.Context, string, int64) ([]domain.Event, error)
}

type Server struct {
	store ProjectStore
	hub   *realtime.Hub
}

func NewServer(store ProjectStore, hub *realtime.Hub) *Server {
	return &Server{store: store, hub: hub}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/metrics/projects", s.handleProjectMetrics)
	mux.HandleFunc("/api/projects", s.handleProjects)
	mux.HandleFunc("/api/projects/", s.handleProjectRoutes)
	return withCORS(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleProjectMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	dashboard, err := s.store.ProjectProgressDashboard(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dashboard)
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		includeArchived := r.URL.Query().Get("includeArchived") == "true"
		projects, err := s.store.ListProjects(r.Context(), includeArchived)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, projects)
	case http.MethodPost:
		var input struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			Metadata    map[string]any `json:"metadata"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		project, event, err := s.store.CreateProject(r.Context(), input.Name, input.Description, input.Metadata)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		s.hub.Publish(event)
		writeJSON(w, http.StatusCreated, project)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleProjectRoutes(w http.ResponseWriter, r *http.Request) {
	parts := splitPath(strings.TrimPrefix(r.URL.Path, "/api/projects/"))
	if len(parts) == 0 {
		http.NotFound(w, r)
		return
	}

	projectID := parts[0]
	if len(parts) == 1 {
		if r.Method == http.MethodPatch {
			var patch store.ProjectPatch
			if !decodeJSON(w, r, &patch) {
				return
			}
			project, event, err := s.store.UpdateProject(r.Context(), projectID, patch)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			s.hub.Publish(event)
			writeJSON(w, http.StatusOK, project)
			return
		}
		if r.Method == http.MethodDelete {
			event, err := s.store.DeleteProject(r.Context(), projectID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			s.hub.Publish(event)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		snapshot, err := s.store.Snapshot(r.Context(), projectID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
		return
	}

	switch parts[1] {
	case "archive":
		s.handleArchiveProject(w, r, projectID)
	case "unarchive":
		s.handleUnarchiveProject(w, r, projectID)
	case "events":
		s.handleEvents(w, r, projectID)
	case "ws":
		s.handleWebSocket(w, r, projectID)
	case "tasks":
		s.handleTasks(w, r, projectID, parts[2:])
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleArchiveProject(w http.ResponseWriter, r *http.Request, projectID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	event, err := s.store.ArchiveProject(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.hub.Publish(event)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnarchiveProject(w http.ResponseWriter, r *http.Request, projectID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	event, err := s.store.UnarchiveProject(r.Context(), projectID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.hub.Publish(event)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, projectID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	afterVersion, ok := parseIntQuery(w, r, "afterVersion", 0)
	if !ok {
		return
	}
	events, err := s.store.ListEventsAfter(r.Context(), projectID, afterVersion)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request, projectID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	lastSeenVersion, ok := parseIntQuery(w, r, "lastSeenVersion", 0)
	if !ok {
		return
	}
	replay, err := s.store.ListEventsAfter(r.Context(), projectID, lastSeenVersion)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.hub.ServeWS(w, r, projectID, replay)
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request, projectID string, parts []string) {
	if len(parts) == 0 {
		switch r.Method {
		case http.MethodGet:
			limit, ok := parseIntQuery(w, r, "limit", 50)
			if !ok {
				return
			}
			page, err := s.store.ListTasks(r.Context(), projectID, store.TaskListOptions{
				Limit:  int(limit),
				Cursor: r.URL.Query().Get("cursor"),
			})
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, page)
		case http.MethodPost:
			var input domain.Task
			if !decodeJSON(w, r, &input) {
				return
			}
			task, event, err := s.store.CreateTask(r.Context(), projectID, input)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			s.hub.Publish(event)
			writeJSON(w, http.StatusCreated, task)
		default:
			methodNotAllowed(w)
		}
		return
	}

	taskID := parts[0]
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPatch:
			var patch store.TaskPatch
			if !decodeJSON(w, r, &patch) {
				return
			}
			task, event, err := s.store.UpdateTask(r.Context(), projectID, taskID, patch)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			s.hub.Publish(event)
			writeJSON(w, http.StatusOK, task)
		case http.MethodDelete:
			event, err := s.store.DeleteTask(r.Context(), projectID, taskID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			s.hub.Publish(event)
			w.WriteHeader(http.StatusNoContent)
		default:
			methodNotAllowed(w)
		}
		return
	}

	if len(parts) == 2 && parts[1] == "comments" {
		s.handleComments(w, r, projectID, taskID)
		return
	}

	if len(parts) == 3 && parts[1] == "comments" {
		s.handleComment(w, r, projectID, taskID, parts[2])
		return
	}

	http.NotFound(w, r)
}

func (s *Server) handleComments(w http.ResponseWriter, r *http.Request, projectID, taskID string) {
	switch r.Method {
	case http.MethodGet:
		comments, err := s.store.ListComments(r.Context(), projectID, taskID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, comments)
	case http.MethodPost:
		var input struct {
			Content string `json:"content"`
			Author  string `json:"author"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		comment, event, err := s.store.CreateComment(r.Context(), projectID, taskID, input.Content, input.Author)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		s.hub.Publish(event)
		writeJSON(w, http.StatusCreated, comment)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleComment(w http.ResponseWriter, r *http.Request, projectID, taskID, commentID string) {
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	comment, event, err := s.store.UpdateComment(r.Context(), projectID, taskID, commentID, input.Content)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.hub.Publish(event)
	writeJSON(w, http.StatusOK, comment)
}

func splitPath(path string) []string {
	raw := strings.Split(strings.Trim(path, "/"), "/")
	parts := raw[:0]
	for _, part := range raw {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func parseIntQuery(w http.ResponseWriter, r *http.Request, key string, fallback int64) (int64, bool) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": key + " must be a non-negative integer"})
		return 0, false
	}
	return value, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return false
	}
	return true
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrInvalidInput), errors.Is(err, store.ErrInvalidStatus):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		log.Printf("unexpected api error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
