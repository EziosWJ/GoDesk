package httpserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"
)

func New(db *sql.DB, desktop http.Handler) http.Handler {
	mux := http.NewServeMux()
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
