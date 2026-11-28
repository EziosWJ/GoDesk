package httpserver

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"godesk/internal/auth"
	"godesk/internal/health"
	"godesk/internal/monitor"
	"godesk/internal/services"
	"godesk/internal/terminal"

	_ "modernc.org/sqlite"
)

func TestFileRoutesAndDesktopCoexist(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, err := auth.Open(t.Context(), db)
	if err != nil {
		t.Fatal(err)
	}
	terminals, err := terminal.Open(t.Context(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer terminals.Close()
	monitoring := monitor.Start(t.Context(), time.Second)
	defer monitoring.Close()
	healthEngine := health.Start(t.Context(), monitoring, time.Second)
	mux := New(db, store, terminals, monitoring, healthEngine, services.None(), nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	for path, code := range map[string]int{
		"/":                           http.StatusAccepted,
		"/api/v1/files/directory":     http.StatusUnauthorized,
		"/api/v1/terminal/sessions":   http.StatusUnauthorized,
		"/api/v1/terminal/sudo":       http.StatusUnauthorized,
		"/api/v1/settings/terminal":   http.StatusUnauthorized,
		"/api/v1/system/metrics":      http.StatusUnauthorized,
		"/api/v1/system/ports":        http.StatusUnauthorized,
		"/api/v1/system/ports/detail": http.StatusUnauthorized,
		"/api/v1/system/ports/logs":   http.StatusUnauthorized,
		"/api/v1/system/status":       http.StatusUnauthorized,
		"/api/v1/system/host":         http.StatusUnauthorized,
		"/api/v1/system/timezones":    http.StatusUnauthorized,
		"/api/v1/services":            http.StatusUnauthorized,
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != code {
			t.Errorf("%s returned %d, want %d", path, w.Code, code)
		}
	}
	for _, path := range []string{"/api/v1/system/host/hostname", "/api/v1/system/host/timezone"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodPut, path, nil))
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s returned %d, want %d", path, w.Code, http.StatusUnauthorized)
		}
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/system/ports/stop", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("port stop returned %d, want %d", w.Code, http.StatusUnauthorized)
	}
}
