package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"happyrobot/backend/internal/httpapi"
	"happyrobot/backend/internal/realtime"
	"happyrobot/backend/internal/store"
)

func main() {
	addr := env("HTTP_ADDR", ":8080")
	databaseURL := env("DATABASE_URL", "postgres://happyrobot:happyrobot@localhost:55432/happyrobot?sslmode=disable")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatal(err)
	}

	repo := store.NewPostgresStore(pool)
	if err := repo.EnsureSchema(ctx); err != nil {
		log.Fatal(err)
	}
	hub := realtime.NewHub()
	server := httpapi.NewServer(repo, hub)

	srv := &http.Server{
		Addr:              addr,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("api listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
