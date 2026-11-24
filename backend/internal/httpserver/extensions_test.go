package httpserver

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"godesk/internal/auth"
	"godesk/internal/extensions"
	"godesk/internal/health"
	"godesk/internal/monitor"
	"godesk/internal/services"
	"godesk/internal/terminal"

	_ "modernc.org/sqlite"
)

func TestExtensionRoutesRequireSession(t *testing.T) {
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
	manager, err := extensions.Open(t.Context(), extensions.Options{
		DataDir: filepath.Join(t.TempDir(), "extensions"),
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("open extension host: %v", err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = manager.Close(closeCtx)
	})
	desktop := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})
	mux := New(db, store, terminals, monitoring, healthEngine, services.None(),
		manager.Handler(store.RequireSession), desktop)

	for _, path := range []string{
		"/api/v1/extensions",
		"/extensions/com.example.echo/web/",
		"/extensions/com.example.echo/api/hello",
		"/extensions/com.example.echo/events",
	} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s without session = %d, want %d", path, recorder.Code, http.StatusUnauthorized)
		}
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("desktop fallback = %d, want %d", recorder.Code, http.StatusAccepted)
	}

	setup := httptest.NewRequest(http.MethodPost, "/api/v1/auth/setup",
		strings.NewReader(`{"password":"correct horse battery"}`))
	setup.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, setup)
	if recorder.Code != http.StatusOK {
		t.Fatalf("setup = %d, want %d", recorder.Code, http.StatusOK)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("setup returned no session cookie")
	}

	authenticated := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}

	recorder = authenticated("/api/v1/extensions")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"plugins"`) {
		t.Fatalf("authenticated plugin list = %d, %q", recorder.Code, recorder.Body.String())
	}
	recorder = authenticated("/extensions/com.example.echo/web/")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("authenticated missing plugin web = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}
