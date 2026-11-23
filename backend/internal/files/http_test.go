package files

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"

	"golang.org/x/sys/unix"
)

func testRoutes() *http.ServeMux {
	mux := http.NewServeMux()
	Register(mux)
	return mux
}

func request(t *testing.T, mux http.Handler, method, path, contentType string, body io.Reader, status int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, w.Code, status, w.Body)
	}
	return w
}

func sendJSON(t *testing.T, mux http.Handler, method, path string, values map[string]string, status int) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	return request(t, mux, method, path, "application/json", strings.NewReader(string(data)), status)
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path, expected string) {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != expected {
		t.Fatalf("%s = %q, want %q", path, content, expected)
	}
}

func TestUploadConflictAndDownload(t *testing.T) {
	parent := t.TempDir()
	mux := testRoutes()
	name := "测试 #.txt"
	path := "/upload?" + url.Values{"directory": {parent}, "name": {name}}.Encode()
	upload := func(query, text string, status int) {
		request(t, mux, "POST", path+query, "application/octet-stream", strings.NewReader(text), status)
	}
	upload("", "original", 200)
	upload("", "conflict", 409)
	upload("&conflict=skip", "skip", 200)
	upload("&conflict=keep", "copy", 200)
	mustRead(t, filepath.Join(parent, name), "original")
	target := filepath.Join(parent, "测试 # (1).txt")
	response := request(t, mux, "GET", "/download?path="+url.QueryEscape(target), "", nil, 200)
	if response.Body.String() != "copy" || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("unexpected download: %q, %v", response.Body, response.Header())
	}
}

func TestInterruptedUploadDoesNotPublish(t *testing.T) {
	parent := t.TempDir()
	mux := testRoutes()
	path := "/upload?" + url.Values{"directory": {parent}, "name": {"report.txt"}}.Encode()
	failedBody := io.MultiReader(strings.NewReader("partial data"), iotest.ErrReader(io.ErrUnexpectedEOF))
	request(t, mux, "POST", path, "application/octet-stream", failedBody, 422)
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("interrupted upload left files: %v, %v", entries, err)
	}
	request(t, mux, "POST", path, "application/octet-stream", strings.NewReader("retry"), 200)
	mustRead(t, filepath.Join(parent, "report.txt"), "retry")
}

func TestCopyLinksAndCleanup(t *testing.T) {
	root := t.TempDir()
	mux := testRoutes()
	source := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	for _, directory := range []string{source, target} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("missing", filepath.Join(source, "broken")); err != nil {
		t.Fatal(err)
	}
	copy := map[string]string{"operation": "copy", "path": source, "destination": target}
	sendJSON(t, mux, "POST", "/action", copy, 200)
	copiedLink := filepath.Join(target, "source", "broken")
	if link, err := os.Readlink(copiedLink); err != nil || link != "missing" {
		t.Fatalf("copied link = %q: %v", link, err)
	}
	sendJSON(t, mux, "POST", "/action", map[string]string{"operation": "delete", "path": copiedLink}, 200)
	if _, err := os.Lstat(filepath.Join(source, "broken")); err != nil {
		t.Fatal(err)
	}

	// Failing on a later entry must remove the staged read-only directory.
	readOnly := filepath.Join(source, "a")
	if err := os.Mkdir(readOnly, 0700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(readOnly, "child"), "data")
	if err := os.Chmod(readOnly, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnly, 0700) })
	if err := unix.Mkfifo(filepath.Join(source, "z"), 0600); err != nil {
		t.Fatal(err)
	}
	copy["conflict"] = "keep"
	sendJSON(t, mux, "POST", "/action", copy, 415)
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 1 || entries[0].Name() != "source" {
		t.Fatalf("copy left unexpected destinations: %v, %v", entries, err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(source, alias); err != nil {
		t.Fatal(err)
	}
	copy["destination"] = alias
	sendJSON(t, mux, "POST", "/action", copy, 422)
}

func TestSaveDetectsExternalChangesAndPreservesLink(t *testing.T) {
	parent := t.TempDir()
	mux := testRoutes()
	target := filepath.Join(parent, "actual.txt")
	link := filepath.Join(parent, "alias.txt")
	mustWrite(t, target, "original")
	if err := os.Symlink("actual.txt", link); err != nil {
		t.Fatal(err)
	}
	read := func() document {
		t.Helper()
		w := request(t, mux, "GET", "/text?path="+url.QueryEscape(link), "", nil, 200)
		var data document
		if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	first := read()
	mustWrite(t, target, "external")
	sendJSON(t, mux, "PUT", "/text", map[string]string{"path": link, "version": first.Version, "text": "draft"}, 409)
	mustRead(t, target, "external")
	current := read()
	sendJSON(t, mux, "PUT", "/text", map[string]string{"path": link, "version": current.Version, "text": "draft"}, 200)
	mustRead(t, target, "draft")
	if _, err := os.Readlink(link); err != nil {
		t.Fatal(err)
	}
	saved := read()
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	sendJSON(t, mux, "PUT", "/text", map[string]string{"path": link, "version": saved.Version, "text": "stale"}, 409)
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old file was recreated: %v", err)
	}
}
