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

	"godesk/internal/auth"
	"godesk/internal/httpserver"
	"godesk/internal/monitor"
	"godesk/internal/terminal"
	"godesk/internal/webui"

	_ "modernc.org/sqlite"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := command(ctx, os.Args[1:]); err != nil {
		slog.Error("goDesk stopped", "error", err)
		os.Exit(1)
	}
}

func command(ctx context.Context, args []string) error {
	if len(args) > 0 && args[0] == "reset-password" {
		return resetPassword(ctx, args[1:])
	}
	listen := flag.String("listen", "0.0.0.0:8080", "HTTP listen address")
	dataDir := flag.String("data-dir", "./data", "directory for persistent goDesk data")
	_ = flag.CommandLine.Parse(args)
	return run(ctx, *listen, *dataDir)
}

func run(ctx context.Context, address, dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}

	dbPath, err := databasePath(dataDir)
	if err != nil {
		return fmt.Errorf("resolve database path: %w", err)
	}
	db, err := openDatabase(ctx, dbPath, "rwc")
	if err != nil {
		return err
	}
	defer db.Close()

	credentials, err := auth.Open(ctx, db)
	if err != nil {
		return fmt.Errorf("initialize authentication storage: %w", err)
	}
	terminals, err := terminal.Open(ctx, db)
	if err != nil {
		return fmt.Errorf("initialize terminal storage: %w", err)
	}
	defer terminals.Close()

	monitoring := monitor.Start(ctx, monitor.DefaultInterval)
	defer monitoring.Close()

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	server := &http.Server{
		Handler:           httpserver.New(db, credentials, terminals, monitoring, webui.Handler()),
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
		terminals.Close()
		monitoring.Close()
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

func databasePath(dataDir string) (string, error) {
	return filepath.Abs(filepath.Join(dataDir, "godesk.db"))
}

func openDatabase(ctx context.Context, path, mode string) (*sql.DB, error) {
	// Use a file URI so characters such as '?' in the data directory stay part of the path.
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: "mode=" + mode}
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
