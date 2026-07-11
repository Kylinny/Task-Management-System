package domain

import "time"

type Project struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Metadata    map[string]any `json:"metadata"`
	Version     int64          `json:"version"`
	ArchivedAt  *time.Time     `json:"archivedAt,omitempty"`
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}

type TaskStatus string

const (
	TaskStatusTodo       TaskStatus = "todo"
	TaskStatusInProgress TaskStatus = "in_progress"
	TaskStatusBlocked    TaskStatus = "blocked"
	TaskStatusDone       TaskStatus = "done"
)

type TaskConfiguration struct {
	Priority     string         `json:"priority"`
	Description  string         `json:"description"`
	Tags         []string       `json:"tags"`
	CustomFields map[string]any `json:"customFields"`
}

type Task struct {
	ID            string            `json:"id"`
	ProjectID     string            `json:"projectId"`
	Title         string            `json:"title"`
	Status        TaskStatus        `json:"status"`
	AssignedTo    []string          `json:"assignedTo"`
	Configuration TaskConfiguration `json:"configuration"`
	Dependencies  []string          `json:"dependencies"`
	Version       int64             `json:"version"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
}

type Comment struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"taskId"`
	Content   string    `json:"content"`
	Author    string    `json:"author"`
	Timestamp time.Time `json:"timestamp"`
}

type ProjectSnapshot struct {
	Project  Project   `json:"project"`
	Tasks    []Task    `json:"tasks"`
	Comments []Comment `json:"comments"`
}

type StatusCounts struct {
	Todo       int `json:"todo"`
	InProgress int `json:"inProgress"`
	Blocked    int `json:"blocked"`
	Done       int `json:"done"`
}

type ProjectProgress struct {
	ProjectID         string       `json:"projectId"`
	Name              string       `json:"name"`
	Description       string       `json:"description"`
	UpdatedAt         time.Time    `json:"updatedAt"`
	TotalTasks        int          `json:"totalTasks"`
	CommentCount      int          `json:"commentCount"`
	CompletionPercent float64      `json:"completionPercent"`
	BlockedPercent    float64      `json:"blockedPercent"`
	StatusCounts      StatusCounts `json:"statusCounts"`
}

type ProjectProgressDashboard struct {
	GeneratedAt      time.Time         `json:"generatedAt"`
	TotalProjects    int               `json:"totalProjects"`
	ArchivedProjects int               `json:"archivedProjects"`
	TotalTasks       int               `json:"totalTasks"`
	TotalComments    int               `json:"totalComments"`
	StatusCounts     StatusCounts      `json:"statusCounts"`
	Projects         []ProjectProgress `json:"projects"`
}

type DeletedProject struct {
	ID string `json:"id"`
}

type ArchivedProject struct {
	ID         string    `json:"id"`
	ArchivedAt time.Time `json:"archivedAt"`
}

type UnarchivedProject struct {
	ID string `json:"id"`
}

type TaskPage struct {
	Items      []Task `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
}

type Event struct {
	Type      string    `json:"type"`
	ProjectID string    `json:"projectId"`
	EntityID  string    `json:"entityId"`
	Version   int64     `json:"version"`
	Payload   any       `json:"payload"`
	CreatedAt time.Time `json:"createdAt"`
}
