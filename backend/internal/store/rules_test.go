package store

import (
	"testing"

	"happyrobot/backend/internal/domain"
)

func TestCanTransitionAllowsKanbanMovement(t *testing.T) {
	tests := []struct {
		name string
		from domain.TaskStatus
		to   domain.TaskStatus
		want bool
	}{
		{name: "todo to in progress", from: domain.TaskStatusTodo, to: domain.TaskStatusInProgress, want: true},
		{name: "todo to done", from: domain.TaskStatusTodo, to: domain.TaskStatusDone, want: true},
		{name: "in progress back to todo", from: domain.TaskStatusInProgress, to: domain.TaskStatusTodo, want: true},
		{name: "done can reopen", from: domain.TaskStatusDone, to: domain.TaskStatusInProgress, want: true},
		{name: "blocked can resume", from: domain.TaskStatusBlocked, to: domain.TaskStatusInProgress, want: true},
		{name: "unknown target is invalid", from: domain.TaskStatusTodo, to: domain.TaskStatus("archived"), want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := canTransition(tt.from, tt.to); got != tt.want {
				t.Fatalf("canTransition(%q, %q) = %v, want %v", tt.from, tt.to, got, tt.want)
			}
		})
	}
}

func TestIsKnownStatus(t *testing.T) {
	if !isKnownStatus(domain.TaskStatusTodo) {
		t.Fatal("todo should be known")
	}
	if isKnownStatus(domain.TaskStatus("archived")) {
		t.Fatal("archived should not be known")
	}
}
