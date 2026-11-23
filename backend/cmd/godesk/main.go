package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"godesk/internal/httpserver"
	"godesk/internal/webui"

	_ "modernc.org/sqlite"
)

func main() {
	listen := flag.String("listen", "0.0.0.0:8080", "HTTP listen address")
	dataDir := flag.String("data-dir", "./data", "directory for persistent goDesk data")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *listen, *dataDir); err != nil {
		slog.Error("goDesk stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, address, dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}

	dbPath, err := filepath.Abs(filepath.Join(dataDir, "godesk.db"))
	if err != nil {
		return fmt.Errorf("resolve database path: %w", err)
	}
	db, err := openDatabase(ctx, dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	server := &http.Server{
		Handler:           httpserver.New(db, webui.Handler()),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()
	slog.Info("goDesk started", "listen", listener.Addr(), "database", dbPath)

	select {
	case err := <-serveErr:
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down HTTP server: %w", err)
		}
		if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	}
}

func openDatabase(ctx context.Context, path string) (*sql.DB, error) {
	// Use a file URI so characters such as '?' in the data directory stay part of the path.
	dsn := url.URL{Scheme: "file", Path: path}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to SQLite database: %w", err)
	}
	return db, nil
}
