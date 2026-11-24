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

func TestTextReadAndSaveWithAnyFilename(t *testing.T) {
	mux := testRoutes()
	for _, name := range []string{"hosts", "server.conf", ".env", "notes.dat"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			const original = "127.0.0.1 localhost\n# 主机\n"
			sendJSON(t, mux, "PUT", "/text", map[string]string{"path": path, "text": original}, 200)
			w := request(t, mux, "GET", "/text?path="+url.QueryEscape(path), "", nil, 200)
			var data document
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
			if data.Path != path || data.Text != original || data.Version == "" {
				t.Fatalf("unexpected document: %+v", data)
			}
			sendJSON(t, mux, "PUT", "/text", map[string]string{"path": path, "text": "updated", "version": data.Version}, 200)
			mustRead(t, path, "updated")
			sendJSON(t, mux, "PUT", "/text", map[string]string{"path": path, "text": "stale", "version": data.Version}, 409)
			mustRead(t, path, "updated")
		})
	}
}

func TestTextOpenValidatesFullBoundedContent(t *testing.T) {
	mux := testRoutes()
	path := filepath.Join(t.TempDir(), "example.txt")
	query := "/text?path=" + url.QueryEscape(path)
	prefix := strings.Repeat("a", textLimit-3)
	mustWrite(t, path, prefix+"字")
	request(t, mux, "GET", query, "", nil, 200)

	for _, test := range []struct {
		name, content, code string
		status              int
	}{
		{"NUL near limit", prefix + "\x00", "binary_file", 415},
		{"invalid UTF-8 near limit", prefix + "\xff", "unsupported_encoding", 415},
		{"UTF-16 BOM", "\xff\xfeA\x00", "unsupported_encoding", 415},
		{"over limit", prefix + "字a", "text_too_large", 413},
	} {
		t.Run(test.name, func(t *testing.T) {
			mustWrite(t, path, test.content)
			w := request(t, mux, "GET", query, "", nil, test.status)
			var data struct{ Code, Message string }
			if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
				t.Fatal(err)
			}
			if data.Code != test.code || data.Message == "" {
				t.Fatalf("unexpected error: %+v", data)
			}
		})
	}
}

func TestImagePreview(t *testing.T) {
	mux := testRoutes()
	dir := t.TempDir()
	png := "\x89PNG\r\n\x1a\n" + strings.Repeat("a", 600)
	svg := "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>"
	for _, test := range []struct{ name, content, contentType string }{
		{"photo.PNG", png, "image/png"},
		{"drawing.svg", svg, "image/svg+xml"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(dir, test.name)
			mustWrite(t, path, test.content)
			query := "/image?path=" + url.QueryEscape(path)
			w := request(t, mux, "GET", query, "", nil, 200)
			if w.Body.String() != test.content || w.Header().Get("Content-Type") != test.contentType ||
				w.Header().Get("Content-Disposition") != "" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("unexpected inline image response")
			}
			if test.contentType == "image/svg+xml" && !strings.HasPrefix(w.Header().Get("Content-Security-Policy"), "sandbox;") {
				t.Fatal("SVG response must be sandboxed when opened directly")
			}
			head := request(t, mux, "HEAD", query, "", nil, 200)
			if head.Body.Len() != 0 || head.Header().Get("Content-Type") != test.contentType {
				t.Fatal("unexpected image metadata response")
			}
		})
	}
	path := filepath.Join(dir, "not-an-image.png")
	mustWrite(t, path, "<html>Not an image</html>")
	request(t, mux, "GET", "/image?path="+url.QueryEscape(path), "", nil, 415)
}
