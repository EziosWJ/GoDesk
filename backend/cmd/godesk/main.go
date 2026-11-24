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
	"godesk/internal/extensions"
	"godesk/internal/files"
	"godesk/internal/health"
	"godesk/internal/httpserver"
	"godesk/internal/monitor"
	"godesk/internal/privileges"
	"godesk/internal/services"
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
	if len(args) > 0 {
		switch args[0] {
		case "reset-password":
			return resetPassword(ctx, args[1:])
		case "--setup-sudo", "--check-sudo", "--remove-sudo", "--file-operation":
			if len(args) != 1 {
				return fmt.Errorf("%s 不接受额外参数", args[0])
			}
			switch args[0] {
			case "--setup-sudo":
				return privileges.Setup(ctx)
			case "--check-sudo":
				return privileges.Check(ctx, os.Stdout)
			case "--remove-sudo":
				return privileges.Remove()
			default:
				return files.RunElevated(ctx, os.Stdin, os.Stdout)
			}
		}
	}
	listen := flag.String("listen", "0.0.0.0:5000", "HTTP listen address")
	dataDir := flag.String("data-dir", "./data", "directory for persistent goDesk data")
	setupSudo := flag.Bool("setup-sudo", false, "install the GoDesk sudoers rule")
	checkSudo := flag.Bool("check-sudo", false, "check passwordless sudo and the GoDesk rule")
	removeSudo := flag.Bool("remove-sudo", false, "remove the GoDesk sudoers rule")
	serviceBackend := flag.String("service-backend", "auto", "service backend: auto, systemd, or none")
	extensionGrants := flag.String("extension-grants", "", "service grants JSON file for extension plugins")
	_ = flag.CommandLine.Parse(args)
	if *setupSudo || *checkSudo || *removeSudo {
		return errors.New("sudo commands must be run on their own")
	}
	return run(ctx, *listen, *dataDir, *serviceBackend, *extensionGrants)
}

func run(ctx context.Context, address, dataDir, serviceBackend, extensionGrants string) error {
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
	healthEngine := health.Start(ctx, monitoring, monitor.DefaultInterval)

	serviceManager, err := services.Open(serviceBackend)
	if err != nil {
		return fmt.Errorf("initialize service backend: %w", err)
	}
	slog.Info("service backend ready", "backend", serviceManager.Name())

	grants, err := extensions.LoadServiceGrants(extensionGrants)
	if err != nil {
		return fmt.Errorf("load extension service grants: %w", err)
	}
	pluginServices, err := services.OpenPlugin(serviceBackend)
	if err != nil {
		return fmt.Errorf("initialize extension service backend: %w", err)
	}

	// Extension failures must not take down the built-in applications.
	extensionManager, err := extensions.Open(ctx, extensions.Options{
		DataDir:        filepath.Join(dataDir, "extensions"),
		Logger:         slog.Default(),
		ServiceBackend: pluginServices,
		ServiceGrants:  grants,
	})
	if err != nil {
		slog.Error("extension host unavailable; built-in applications continue without extensions", "error", err)
	} else {
		defer closeExtensions(extensionManager)
		go restoreExtensions(ctx, extensionManager)
	}
	var extensionHandler http.Handler
	if extensionManager != nil {
		extensionHandler = extensionManager.Handler(credentials.RequireSession)
	} else {
		extensionHandler = credentials.RequireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "extension host unavailable", http.StatusServiceUnavailable)
		}))
	}

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	server := &http.Server{
		Handler:           httpserver.New(db, credentials, terminals, monitoring, healthEngine, serviceManager, extensionHandler, webui.Handler()),
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
		if extensionManager != nil {
			// Closing the host first lets plugin event sockets exit before the
			// HTTP server stops accepting connections.
			closeExtensions(extensionManager)
		}
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

func restoreExtensions(ctx context.Context, manager *extensions.Manager) {
	ctx, cancel := context.WithTimeout(ctx, extensions.RestoreTimeout)
	defer cancel()
	if err := manager.Restore(ctx); err != nil {
		slog.Error("restore extension plugins", "error", err)
	}
}

func closeExtensions(manager *extensions.Manager) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := manager.Close(ctx); err != nil {
		slog.Error("close extension host", "error", err)
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
