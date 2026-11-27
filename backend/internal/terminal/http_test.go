package terminal

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func newHTTPManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	manager, err := Open(t.Context(), db)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		manager.Close()
		_ = db.Close()
	})
	return manager
}

func sessionMux(manager *Manager) http.Handler {
	mux := http.NewServeMux()
	manager.Register(mux, func(next http.Handler) http.Handler { return next })
	return mux
}

func postSession(t *testing.T, mux http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/terminal/sessions", strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func TestCreateSessionWithCwd(t *testing.T) {
	manager := newHTTPManager(t)
	dir := t.TempDir()
	recorder := postSession(t, sessionMux(manager), `{"cwd": `+strconv.Quote(dir)+`}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body)
	}
	var summary Summary
	if err := json.Unmarshal(recorder.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	session := manager.session(summary.ID)
	if session == nil {
		t.Fatal("session was not registered")
	}
	if session.cmd.Dir != dir {
		t.Fatalf("session cwd = %q, want %q", session.cmd.Dir, dir)
	}
}

func TestCreateSessionWithoutCwd(t *testing.T) {
	manager := newHTTPManager(t)
	mux := sessionMux(manager)
	home, _ := os.UserHomeDir()
	for _, body := range []string{"{}", ""} {
		recorder := postSession(t, mux, body)
		if recorder.Code != http.StatusCreated {
			t.Fatalf("body %q: status = %d: %s", body, recorder.Code, recorder.Body)
		}
		var summary Summary
		if err := json.Unmarshal(recorder.Body.Bytes(), &summary); err != nil {
			t.Fatal(err)
		}
		session := manager.session(summary.ID)
		if session == nil {
			t.Fatal("session was not registered")
		}
		if info, err := os.Stat(home); err == nil && info.IsDir() && session.cmd.Dir != home {
			t.Fatalf("body %q: cwd = %q, want home %q", body, session.cmd.Dir, home)
		}
	}
}

func TestCreateSessionCwdErrors(t *testing.T) {
	manager := newHTTPManager(t)
	mux := sessionMux(manager)
	file := filepath.Join(t.TempDir(), "plain.txt")
	if err := os.WriteFile(file, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	tests := []struct {
		name   string
		cwd    string
		status int
		code   string
	}{
		{"missing", missing, http.StatusNotFound, "cwd_not_found"},
		{"file", file, http.StatusBadRequest, "cwd_not_directory"},
		{"relative", "relative/path", http.StatusBadRequest, "invalid_cwd"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := postSession(t, mux, `{"cwd": `+strconv.Quote(test.cwd)+`}`)
			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body)
			}
			var failure struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &failure); err != nil {
				t.Fatal(err)
			}
			if failure.Code != test.code || failure.Message == "" {
				t.Fatalf("failure = %+v, want code %q", failure, test.code)
			}
		})
	}
	if len(manager.list()) != 0 {
		t.Fatal("rejected cwd started a session")
	}
}

func TestCreateSessionCwdPermissionDenied(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can enter every directory")
	}
	manager := newHTTPManager(t)
	dir := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	recorder := postSession(t, sessionMux(manager), `{"cwd": `+strconv.Quote(dir)+`}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusForbidden, recorder.Body)
	}
	var failure struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Code != "cwd_permission_denied" {
		t.Fatalf("code = %q", failure.Code)
	}
}
