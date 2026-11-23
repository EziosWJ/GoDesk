package httpserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"godesk/internal/auth"
	"godesk/internal/files"
	"godesk/internal/monitor"
	"godesk/internal/services"
	"godesk/internal/terminal"
)

func New(db *sql.DB, credentials *auth.Store, terminals *terminal.Manager, monitoring *monitor.Collector, serviceBackend services.Backend, desktop http.Handler) http.Handler {
	mux := http.NewServeMux()
	credentials.Register(mux)
	terminals.Register(mux, credentials.RequireSession)
	if monitoring != nil {
		monitoring.Register(mux, credentials.RequireSession)
	}
	if serviceBackend != nil {
		services.Register(mux, credentials.RequireSession, serviceBackend)
	}
	const filePrefix = "/api/v1/files"
	fileRoutes := http.NewServeMux()
	files.Register(fileRoutes)
	fileHandler := credentials.RequireSession(http.StripPrefix(filePrefix, fileRoutes))
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut} {
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
	return mux
}
