package files

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

var archiveStamp = time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)

func sendJSONValue(t *testing.T, mux http.Handler, path string, value any, status int) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return request(t, mux, "POST", path, "application/json", bytes.NewReader(data), status)
}

func decodeValue[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body, err)
	}
	return value
}

func failureCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeValue[struct {
		Code string `json:"code"`
	}](t, recorder).Code
}

func TestDirectoryIncludesModTime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stamped.txt")
	mustWrite(t, path, "hello")
	stamp := time.Date(2024, 5, 6, 7, 8, 9, 0, time.FixedZone("UTC+8", 8*60*60))
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	w := request(t, testRoutes(), "GET", "/directory?path="+url.QueryEscape(dir), "", nil, 200)
	data := decodeValue[struct {
		Entries []entry `json:"entries"`
	}](t, w)
	var found *entry
	for i := range data.Entries {
		if data.Entries[i].Name == "stamped.txt" {
			found = &data.Entries[i]
		}
	}
	if found == nil {
		t.Fatalf("stamped.txt missing from %+v", data.Entries)
	}
	parsed, err := time.Parse(time.RFC3339, found.ModTime)
	if err != nil {
		t.Fatalf("modTime %q is not RFC3339: %v", found.ModTime, err)
	}
	if !parsed.Equal(stamp) || parsed.Location() != time.UTC {
		t.Fatalf("modTime = %q, want %q in UTC", found.ModTime, stamp.UTC().Format(time.RFC3339))
	}
}

type zipMember struct {
	body []byte
	mode fs.FileMode
	dir  bool
}

func readZip(t *testing.T, data []byte) map[string]zipMember {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	members := make(map[string]zipMember, len(reader.File))
	for _, file := range reader.File {
		body, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(body)
		_ = body.Close()
		if err != nil {
			t.Fatal(err)
		}
		members[strings.TrimSuffix(file.Name, "/")] = zipMember{body: content, mode: file.Mode(), dir: file.FileInfo().IsDir()}
	}
	return members
}

func TestArchiveDownloadMultipleSelection(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "one.txt"), "first")
	if err := os.Mkdir(filepath.Join(root, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "docs", "two.txt"), "second")
	if err := os.Symlink("one.txt", filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	query := url.Values{"path": {
		filepath.Join(root, "one.txt"),
		filepath.Join(root, "docs"),
		filepath.Join(root, "alias"),
	}}
	w := request(t, testRoutes(), "GET", "/archive/download?"+query.Encode(), "", nil, 200)
	if w.Header().Get("Content-Type") != "application/zip" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected headers: %v", w.Header())
	}
	_, parameters, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
	if err != nil || parameters["filename"] != filepath.Base(root)+".zip" {
		t.Fatalf("filename = %q, %v", parameters["filename"], err)
	}
	members := readZip(t, w.Body.Bytes())
	if string(members["one.txt"].body) != "first" {
		t.Fatalf("one.txt = %q", members["one.txt"].body)
	}
	if !members["docs"].dir || string(members["docs/two.txt"].body) != "second" {
		t.Fatalf("directory content missing: %+v", members["docs"])
	}
	alias, ok := members["alias"]
	if !ok || alias.mode&fs.ModeSymlink == 0 || string(alias.body) != "one.txt" {
		t.Fatalf("symlink member = %+v", alias)
	}
}

func TestArchiveDownloadSingleItemFilename(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "notes.txt")
	mustWrite(t, path, "content")
	query := url.Values{"path": {path}}
	w := request(t, testRoutes(), "GET", "/archive/download?"+query.Encode(), "", nil, 200)
	_, parameters, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
	if err != nil || parameters["filename"] != "notes.txt.zip" {
		t.Fatalf("filename = %q, %v", parameters["filename"], err)
	}
	if string(readZip(t, w.Body.Bytes())["notes.txt"].body) != "content" {
		t.Fatal("downloaded archive content mismatch")
	}
}

func TestArchiveDownloadRejectsInvalidSelection(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "keep.txt")
	mustWrite(t, valid, "data")
	mux := testRoutes()
	missing := filepath.Join(root, "missing.txt")
	w := request(t, mux, "GET", "/archive/download?"+url.Values{"path": {valid, missing}}.Encode(), "", nil, 404)
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || failureCode(t, w) != "not_found" {
		t.Fatalf("unexpected pre-flight failure: %d %q", w.Code, w.Body)
	}
	w = request(t, mux, "GET", "/archive/download?"+url.Values{"path": {"relative"}}.Encode(), "", nil, 400)
	if failureCode(t, w) != "invalid_request" {
		t.Fatalf("relative path code = %q", failureCode(t, w))
	}
	request(t, mux, "GET", "/archive/download", "", nil, 400)
	pipe := filepath.Join(root, "pipe")
	if err := unix.Mkfifo(pipe, 0600); err != nil {
		t.Fatal(err)
	}
	w = request(t, mux, "GET", "/archive/download?"+url.Values{"path": {pipe}}.Encode(), "", nil, 415)
	if failureCode(t, w) != "unsupported_type" {
		t.Fatalf("fifo code = %q", failureCode(t, w))
	}
}

func TestCompressArchiveAndConflicts(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a.txt")
	b := filepath.Join(root, "b.txt")
	mustWrite(t, a, "alpha")
	mustWrite(t, b, "beta")
	destination := filepath.Join(root, "bundle.zip")
	mux := testRoutes()
	form := map[string]any{"paths": []string{a, b}, "destination": destination}
	w := sendJSONValue(t, mux, "/archive/compress", form, 200)
	if created := decodeValue[struct {
		Path string `json:"path"`
	}](t, w); created.Path != destination {
		t.Fatalf("path = %q, want %q", created.Path, destination)
	}
	members := readZip(t, mustReadBytes(t, destination))
	if string(members["a.txt"].body) != "alpha" || string(members["b.txt"].body) != "beta" {
		t.Fatalf("unexpected compress result: %+v", members)
	}
	w = sendJSONValue(t, mux, "/archive/compress", form, 409)
	if failureCode(t, w) != "exists" {
		t.Fatalf("conflict code = %q", failureCode(t, w))
	}
	form["conflict"] = "keep"
	w = sendJSONValue(t, mux, "/archive/compress", form, 200)
	kept := filepath.Join(root, "bundle (1).zip")
	if created := decodeValue[struct {
		Path string `json:"path"`
	}](t, w); created.Path != kept {
		t.Fatalf("kept path = %q, want %q", created.Path, kept)
	}
	readZip(t, mustReadBytes(t, kept))
}

func TestCompressArchiveCancellationLeavesNothing(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "a.txt"), strings.Repeat("data", 1024))
	body, err := json.Marshal(map[string]any{
		"paths": []string{filepath.Join(root, "a.txt")}, "destination": filepath.Join(root, "canceled.zip"),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/archive/compress", bytes.NewReader(body)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	testRoutes().ServeHTTP(w, r)
	if w.Code >= 200 && w.Code < 300 {
		t.Fatalf("canceled compress returned %d", w.Code)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range entries {
		if item.Name() != "a.txt" {
			t.Fatalf("canceled compress left %q behind", item.Name())
		}
	}
}

func TestArchiveDownloadThroughElevatedOperation(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	b := filepath.Join(dir, "b.txt")
	mustWrite(t, a, "alpha")
	mustWrite(t, b, "beta")
	request := operationRequest(t, http.MethodGet, "/archive/download", url.Values{"path": {a, b}}, nil)
	response, content := executeFileOperation(t, request)
	if response.Status != http.StatusOK {
		t.Fatalf("status = %d", response.Status)
	}
	members := readZip(t, content)
	if string(members["a.txt"].body) != "alpha" || string(members["b.txt"].body) != "beta" {
		t.Fatalf("streamed archive content mismatch: %+v", members)
	}
}

type testArchiveEntry struct {
	name string
	body string
	mode fs.FileMode
}

func buildZipArchive(t *testing.T, entries []testArchiveEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		mode := entry.mode
		if mode == 0 {
			mode = 0644
		}
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate, Modified: archiveStamp}
		header.SetMode(mode)
		target, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(target, entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func buildTarArchive(t *testing.T, entries []testArchiveEntry, compressed bool) []byte {
	t.Helper()
	var buffer bytes.Buffer
	var target io.Writer = &buffer
	var gz *gzip.Writer
	if compressed {
		gz = gzip.NewWriter(&buffer)
		target = gz
	}
	writer := tar.NewWriter(target)
	for _, entry := range entries {
		mode := entry.mode
		if mode == 0 {
			mode = 0644
		}
		header := &tar.Header{Name: entry.name, Mode: int64(mode.Perm()), ModTime: archiveStamp}
		switch {
		case mode.IsDir():
			header.Typeflag = tar.TypeDir
		case mode&fs.ModeSymlink != 0:
			header.Typeflag, header.Linkname = tar.TypeSymlink, entry.body
		default:
			header.Typeflag, header.Size = tar.TypeReg, int64(len(entry.body))
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := io.WriteString(writer, entry.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if gz != nil {
		if err := gz.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return buffer.Bytes()
}

func mustReadBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestExtractArchiveFormats(t *testing.T) {
	entries := []testArchiveEntry{
		{name: "a.txt", body: "alpha"},
		{name: "sub", mode: fs.ModeDir | 0755},
		{name: "sub/b.txt", body: "beta"},
		{name: "link", mode: fs.ModeSymlink | 0777, body: "a.txt"},
	}
	tests := []struct {
		name   string
		suffix string
		build  func(*testing.T, []testArchiveEntry) []byte
	}{
		{"zip", ".zip", buildZipArchive},
		{"tar", ".tar", func(t *testing.T, entries []testArchiveEntry) []byte {
			return buildTarArchive(t, entries, false)
		}},
		{"tar.gz", ".tar.gz", func(t *testing.T, entries []testArchiveEntry) []byte {
			return buildTarArchive(t, entries, true)
		}},
		{"tgz", ".tgz", func(t *testing.T, entries []testArchiveEntry) []byte {
			return buildTarArchive(t, entries, true)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			archive := filepath.Join(root, "sample"+test.suffix)
			if err := os.WriteFile(archive, test.build(t, entries), 0600); err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(root, "out")
			if err := os.Mkdir(destination, 0700); err != nil {
				t.Fatal(err)
			}
			w := sendJSONValue(t, testRoutes(), "/archive/extract", map[string]string{
				"path": archive, "destination": destination, "mode": "folder", "conflict": "skip",
			}, 200)
			result := decodeValue[struct {
				Destination string `json:"destination"`
				Extracted   int    `json:"extracted"`
				Skipped     int    `json:"skipped"`
			}](t, w)
			extracted := filepath.Join(destination, "sample")
			if result.Destination != extracted || result.Extracted != len(entries) || result.Skipped != 0 {
				t.Fatalf("unexpected result: %+v", result)
			}
			mustRead(t, filepath.Join(extracted, "a.txt"), "alpha")
			mustRead(t, filepath.Join(extracted, "sub", "b.txt"), "beta")
			if link, err := os.Readlink(filepath.Join(extracted, "link")); err != nil || link != "a.txt" {
				t.Fatalf("link = %q, %v", link, err)
			}
		})
	}
}

func TestExtractArchiveHereAndConflicts(t *testing.T) {
	entries := []testArchiveEntry{{name: "a.txt", body: "alpha"}, {name: "sub/b.txt", body: "beta"}}
	root := t.TempDir()
	archive := filepath.Join(root, "sample.zip")
	if err := os.WriteFile(archive, buildZipArchive(t, entries), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "out")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	mux := testRoutes()
	form := map[string]string{"path": archive, "destination": destination, "mode": "here"}
	first := decodeValue[struct {
		Destination string `json:"destination"`
		Extracted   int    `json:"extracted"`
		Skipped     int    `json:"skipped"`
	}](t, sendJSONValue(t, mux, "/archive/extract", form, 200))
	if first.Destination != destination || first.Extracted != 2 || first.Skipped != 0 {
		t.Fatalf("first extraction = %+v", first)
	}
	mustRead(t, filepath.Join(destination, "sub", "b.txt"), "beta")

	form["conflict"] = "skip"
	second := decodeValue[struct {
		Extracted int `json:"extracted"`
		Skipped   int `json:"skipped"`
	}](t, sendJSONValue(t, mux, "/archive/extract", form, 200))
	if second.Extracted != 0 || second.Skipped != 2 {
		t.Fatalf("skip extraction = %+v", second)
	}

	form["conflict"] = "keep"
	third := decodeValue[struct {
		Extracted int `json:"extracted"`
	}](t, sendJSONValue(t, mux, "/archive/extract", form, 200))
	if third.Extracted != 2 {
		t.Fatalf("keep extraction = %+v", third)
	}
	mustRead(t, filepath.Join(destination, "a (1).txt"), "alpha")
	mustRead(t, filepath.Join(destination, "sub", "b (1).txt"), "beta")
}

func TestExtractArchiveDefaultsToArchiveParent(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "sample.zip")
	if err := os.WriteFile(archive, buildZipArchive(t, []testArchiveEntry{{name: "only.txt", body: "one"}}), 0600); err != nil {
		t.Fatal(err)
	}
	w := sendJSONValue(t, testRoutes(), "/archive/extract", map[string]string{"path": archive, "mode": "folder"}, 200)
	result := decodeValue[struct {
		Destination string `json:"destination"`
	}](t, w)
	if result.Destination != filepath.Join(root, "sample") {
		t.Fatalf("destination = %q", result.Destination)
	}
	mustRead(t, filepath.Join(root, "sample", "only.txt"), "one")
}

func TestExtractArchiveRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "safe")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		suffix string
		data   []byte
	}{
		{"zip parent", ".zip", buildZipArchive(t, []testArchiveEntry{{name: "../escape.txt", body: "x"}})},
		{"zip absolute", ".zip", buildZipArchive(t, []testArchiveEntry{{name: "/tmp/escape.txt", body: "x"}})},
		{"tar parent", ".tar", buildTarArchive(t, []testArchiveEntry{{name: "../escape.txt", body: "x"}}, false)},
		{"tar symlink", ".tar", buildTarArchive(t, []testArchiveEntry{
			{name: "link", mode: fs.ModeSymlink | 0777, body: "../../escape.txt"},
		}, false)},
	}
	mux := testRoutes()
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			archive := filepath.Join(root, "archive"+test.suffix)
			if err := os.WriteFile(archive, test.data, 0600); err != nil {
				t.Fatal(err)
			}
			w := sendJSONValue(t, mux, "/archive/extract", map[string]string{
				"path": archive, "destination": destination, "mode": "here",
			}, 400)
			if code := failureCode(t, w); code != "path_traversal" {
				t.Fatalf("code = %q, want path_traversal", code)
			}
			if _, err := os.Lstat(filepath.Join(root, "escape.txt")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("traversal entry escaped the destination")
			}
		})
	}
}

func TestExtractFailureRemovesCreatedFolder(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "sample.zip")
	entries := []testArchiveEntry{{name: "ok.txt", body: "ok"}, {name: "../bad.txt", body: "bad"}}
	if err := os.WriteFile(archive, buildZipArchive(t, entries), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "out")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	sendJSONValue(t, testRoutes(), "/archive/extract", map[string]string{
		"path": archive, "destination": destination, "mode": "folder",
	}, 400)
	if _, err := os.Lstat(filepath.Join(destination, "sample")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("failed extraction left its folder behind")
	}
}

func TestExtractUnsupportedType(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "notes.rar")
	mustWrite(t, path, "not an archive")
	w := sendJSONValue(t, testRoutes(), "/archive/extract", map[string]string{"path": path}, 415)
	if code := failureCode(t, w); code != "unsupported_type" {
		t.Fatalf("code = %q", code)
	}
}
