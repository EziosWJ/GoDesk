package files

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileOperationStreamsBinaryUploadAndDownload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "payload")
	payload := bytes.Repeat([]byte{0, '\r', '\n', 0xff}, 65000)
	upload := operationRequest(t, http.MethodPost, "/upload", url.Values{"directory": {dir}, "name": {"payload"}}, bytes.NewReader(payload))
	if response, _ := executeFileOperation(t, upload); response.Status != http.StatusOK {
		t.Fatalf("upload status = %d", response.Status)
	}
	download := operationRequest(t, http.MethodGet, "/download", url.Values{"path": {path}}, nil)
	response, content := executeFileOperation(t, download)
	if response.Status != http.StatusOK || !bytes.Equal(content, payload) {
		t.Fatalf("download status = %d, bytes = %d", response.Status, len(content))
	}
	head := operationRequest(t, http.MethodHead, "/download", url.Values{"path": {path}}, nil)
	response, content = executeFileOperation(t, head)
	if response.Status != http.StatusOK || len(content) != 0 {
		t.Fatalf("HEAD status = %d, bytes = %d", response.Status, len(content))
	}
}

func TestInterruptedFileOperationDoesNotPublishPartialUpload(t *testing.T) {
	dir := t.TempDir()
	query := url.Values{"directory": {dir}, "name": {"incomplete"}}
	request := "POST /upload?" + query.Encode() + " HTTP/1.1\r\n" +
		"Host: localhost\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
		"100\r\npartial"
	response, _ := executeFileOperation(t, strings.NewReader(request))
	if response.Status < 400 {
		t.Fatalf("interrupted upload returned %d", response.Status)
	}
	items, err := os.ReadDir(dir)
	if err != nil || len(items) != 0 {
		t.Fatalf("upload left files %v, error %v", items, err)
	}
}

func TestMalformedElevationParameter(t *testing.T) {
	mux := http.NewServeMux()
	Register(mux)
	for _, query := range []string{"elevated=yes", "elevated=", "elevated=true&elevated=false", "elevated=%ZZ"} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/directory?"+query, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d", query, recorder.Code)
		}
	}
}

func operationRequest(t *testing.T, method, path string, query url.Values, body io.Reader) io.Reader {
	t.Helper()
	request := httptest.NewRequest(method, path+"?"+query.Encode(), body)
	request.Header.Set("Content-Type", "application/octet-stream")
	var wire bytes.Buffer
	if err := request.Write(&wire); err != nil {
		t.Fatal(err)
	}
	return &wire
}

func executeFileOperation(t *testing.T, input io.Reader) (operationResponse, []byte) {
	t.Helper()
	var wire bytes.Buffer
	if err := runOperation(t.Context(), input, &wire); err != nil {
		t.Fatal(err)
	}
	line, err := wire.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var response operationResponse
	if err := json.Unmarshal(line, &response); err != nil {
		t.Fatal(err)
	}
	return response, wire.Bytes()
}
