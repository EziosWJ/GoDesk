package webshortcuts

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"godesk/internal/auth"

	_ "modernc.org/sqlite"
)

func TestStoredCredentialIsOnlySentInAuthenticatedRedirect(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx := t.Context()
	if err := Initialize(ctx, db); err != nil {
		t.Fatal(err)
	}
	credentials, err := auth.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	credentials.Register(mux)
	Register(mux, db, credentials.RequireSession)

	const path = "/api/v1/web-shortcuts"
	const secret = "private-key+&# value"
	const address = "https://magpie.example.com/?theme=light#providers"
	var cookies []*http.Cookie
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		if rec.Code != status {
			t.Fatalf("%s %s status = %d, want %d (%s)", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}
	setup := request("POST", "/api/v1/auth/setup", `{"password":"test operator password"}`, http.StatusOK)
	request("GET", path+"/1/open", "", http.StatusUnauthorized)
	cookies = setup.Result().Cookies()

	create := request("POST", path, `{"name":"Magpie","url":"`+address+`","parameterName":"k","secret":"private-key+&# value"}`, http.StatusCreated)
	var item shortcut
	if err := json.Unmarshal(create.Body.Bytes(), &item); err != nil || item.ID != 1 {
		t.Fatalf("created shortcut = %+v (%v)", item, err)
	}
	edit := request("PUT", path+"/1", `{"name":"Magpie Web","url":"`+address+`","parameterName":"k"}`, http.StatusOK)
	list := request("GET", path, "", http.StatusOK)
	for _, result := range []*httptest.ResponseRecorder{create, edit, list} {
		if strings.Contains(result.Body.String(), "secret") || strings.Contains(result.Body.String(), "private-key") {
			t.Fatal("shortcut metadata disclosed a credential")
		}
	}
	redirect := request("GET", path+"/1/open", "", http.StatusFound)
	destination, err := url.Parse(redirect.Header().Get("Location"))
	if err != nil || destination.Query().Get("k") != secret || destination.Query().Get("theme") != "light" || destination.Fragment != "providers" {
		t.Fatal("redirect must carry the encoded credential and preserve the configured query and fragment")
	}
	if redirect.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("credentialed redirect must not be cached")
	}

	request("PUT", path+"/1", `{"name":"Magpie Web","url":"`+address+`"}`, http.StatusOK)
	redirect = request("GET", path+"/1/open", "", http.StatusFound)
	if redirect.Header().Get("Location") != address {
		t.Fatal("clearing the parameter must clear the stored credential")
	}
	request("DELETE", path+"/1", "", http.StatusNoContent)
	request("GET", path+"/1/open", "", http.StatusNotFound)
}
