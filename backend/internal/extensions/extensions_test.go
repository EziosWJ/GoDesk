package extensions

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testPluginID = "com.example.echo"

func TestEmbeddedPluginHTTPAndEvents(t *testing.T) {
	manager, err := Open(t.Context(), t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("open host: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := manager.Close(ctx); err != nil {
			t.Errorf("close host: %v", err)
		}
	}()

	handler := manager.Handler(func(next http.Handler) http.Handler { return next })
	server := httptest.NewServer(handler)
	defer server.Close()

	install, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		server.URL+"/api/v1/extensions", bytes.NewReader(testPluginZip(t)))
	if err != nil {
		t.Fatal(err)
	}
	install.Header.Set("Content-Type", "application/zip")
	response, err := http.DefaultClient.Do(install)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d, %s", response.StatusCode, body)
	}

	response = post(t, server.URL+"/api/v1/extensions/"+testPluginID+"/enable")
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("enable = %d", response.StatusCode)
	}

	response, err = http.Get(server.URL + "/extensions/" + testPluginID + "/web/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "echo web") {
		t.Fatalf("plugin web = %d, %q", response.StatusCode, body)
	}

	socketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/extensions/" + testPluginID + "/events"
	socket, _, err := websocket.Dial(t.Context(), socketURL, nil)
	if err != nil {
		t.Fatalf("dial events: %v", err)
	}

	response, err = http.Get(server.URL + "/extensions/" + testPluginID + "/api/hello")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"visits":1`) {
		t.Fatalf("plugin API = %d, %q", response.StatusCode, body)
	}

	readCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	messageType, event, err := socket.Read(readCtx)
	if err != nil {
		t.Fatalf("read event: %v", err)
	}
	if messageType != websocket.MessageText || !strings.Contains(string(event), `"event":"visit"`) ||
		!strings.Contains(string(event), `"count":1`) {
		t.Fatalf("event = %s, %q", messageType, event)
	}

	// Closing one browser window only drops that subscription.
	if err := socket.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close socket: %v", err)
	}
	response, err = http.Get(server.URL + "/extensions/" + testPluginID + "/api/hello")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"visits":2`) {
		t.Fatalf("plugin API after window close = %d, %q", response.StatusCode, body)
	}

	// Stopping the plugin closes the remaining subscriptions.
	socket, _, err = websocket.Dial(t.Context(), socketURL, nil)
	if err != nil {
		t.Fatalf("dial events again: %v", err)
	}
	response = post(t, server.URL+"/api/v1/extensions/"+testPluginID+"/disable")
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("disable = %d", response.StatusCode)
	}
	readCtx, cancel = context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, _, err := socket.Read(readCtx); err == nil {
		t.Fatal("event socket stayed open after the plugin stopped")
	}
}

func post(t *testing.T, url string) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return response
}

func testPluginZip(t *testing.T) []byte {
	t.Helper()
	files := map[string]string{
		"manifest.json": fmt.Sprintf(`{
			"schemaVersion": 1,
			"id": %q,
			"name": "Echo",
			"version": "0.1.0",
			"hostApi": {"min": 1, "max": 1},
			"entry": {"web": "web/index.html", "lua": "lua/init.lua"}
		}`, testPluginID),
		"web/index.html": "<!doctype html><title>Echo</title><p>echo web</p>",
		"lua/init.lua": `
local visits = 0
host.app.route("GET", "/hello", function(request)
  visits = visits + 1
  host.app.emit("visit", { count = visits })
  return {
    status = 200,
    headers = { ["content-type"] = "application/json; charset=utf-8" },
    body = host.json.encode({ message = "hello", visits = visits }),
  }
end)
`,
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
