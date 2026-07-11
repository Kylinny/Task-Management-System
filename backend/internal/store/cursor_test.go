package store

import (
	"errors"
	"testing"
	"time"
)

func TestTaskListOptionsLimit(t *testing.T) {
	tests := []struct {
		name  string
		limit int
		want  int
	}{
		{name: "default for zero", limit: 0, want: 50},
		{name: "default for negative", limit: -1, want: 50},
		{name: "uses caller limit", limit: 25, want: 25},
		{name: "caps large limits", limit: 500, want: 200},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := (TaskListOptions{Limit: tt.limit}).limit()
			if got != tt.want {
				t.Fatalf("limit() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestTaskCursorRoundTrip(t *testing.T) {
	createdAt := time.Date(2026, 7, 9, 12, 30, 0, 123, time.UTC)
	input := taskCursor{CreatedAt: createdAt, ID: "task-123"}

	raw := encodeTaskCursor(input)
	if raw == "" {
		t.Fatal("encodeTaskCursor returned an empty cursor")
	}

	got, err := decodeTaskCursor(raw)
	if err != nil {
		t.Fatalf("decodeTaskCursor returned error: %v", err)
	}
	if !got.CreatedAt.Equal(input.CreatedAt) {
		t.Fatalf("CreatedAt = %s, want %s", got.CreatedAt, input.CreatedAt)
	}
	if got.ID != input.ID {
		t.Fatalf("ID = %q, want %q", got.ID, input.ID)
	}
}

func TestDecodeTaskCursorEmpty(t *testing.T) {
	got, err := decodeTaskCursor("")
	if err != nil {
		t.Fatalf("decodeTaskCursor empty returned error: %v", err)
	}
	if !got.CreatedAt.IsZero() || got.ID != "" {
		t.Fatalf("empty cursor = %+v, want zero value", got)
	}
}

func TestDecodeTaskCursorInvalid(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "not base64", raw: "not a cursor"},
		{name: "missing id", raw: encodeTaskCursor(taskCursor{CreatedAt: time.Now().UTC()})},
		{name: "missing createdAt", raw: encodeTaskCursor(taskCursor{ID: "task-123"})},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := decodeTaskCursor(tt.raw)
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("decodeTaskCursor error = %v, want ErrInvalidInput", err)
			}
		})
	}
}
