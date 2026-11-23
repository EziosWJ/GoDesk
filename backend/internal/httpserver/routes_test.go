package httpserver

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"godesk/internal/auth"
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
	mux := New(db, store, terminals, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	for path, code := range map[string]int{
		"/":                         http.StatusAccepted,
		"/api/v1/files/directory":   http.StatusUnauthorized,
		"/api/v1/terminal/sessions": http.StatusUnauthorized,
		"/api/v1/settings/terminal": http.StatusUnauthorized,
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != code {
			t.Errorf("%s returned %d, want %d", path, w.Code, code)
		}
	}
}
