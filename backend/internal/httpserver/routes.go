package httpserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"godesk/internal/auth"
	"godesk/internal/files"
	"godesk/internal/health"
	"godesk/internal/monitor"
	"godesk/internal/services"
	"godesk/internal/terminal"
	"godesk/internal/webshortcuts"
)

func New(db *sql.DB, credentials *auth.Store, terminals *terminal.Manager, monitoring *monitor.Collector, healthEngine *health.Engine, serviceBackend services.Backend, extensions http.Handler, desktop http.Handler) http.Handler {
	mux := http.NewServeMux()
	credentials.Register(mux)
	webshortcuts.Register(mux, db, credentials.RequireSession)
	terminals.Register(mux, credentials.RequireSession)
	if monitoring != nil {
		monitoring.Register(mux, credentials.RequireSession)
	}
	if healthEngine != nil {
		healthEngine.Register(mux, credentials.RequireSession)
	}
	if serviceBackend != nil {
		services.Register(mux, credentials.RequireSession, serviceBackend)
	}
	const filePrefix = "/api/v1/files"
	fileRoutes := http.NewServeMux()
	files.Register(fileRoutes)
	fileHandler := credentials.RequireSession(http.StripPrefix(filePrefix, fileRoutes))
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut} {
		mux.Handle(method+" "+filePrefix+"/", fileHandler)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()

		status := "ok"
		code := http.StatusOK
		if err := db.PingContext(ctx); err != nil {
			status = "unavailable"
			code = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
	})
	if desktop != nil {
		mux.Handle("GET /", desktop)
	}
	if extensions == nil {
		return mux
	}
	// The extension handler owns its full route set and applies the session
	// middleware itself. Dispatching first keeps every extension route ahead of
	// the desktop fallback without changing the methods accepted elsewhere.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if extensionPath(r.URL.Path) {
			extensions.ServeHTTP(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func extensionPath(path string) bool {
	return path == "/api/v1/extensions" ||
		strings.HasPrefix(path, "/api/v1/extensions/") ||
		strings.HasPrefix(path, "/extensions/")
}
