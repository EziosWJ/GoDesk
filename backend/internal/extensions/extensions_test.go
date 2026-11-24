package extensions

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/EziosWJ/Extension-Host/host"
	extservices "github.com/EziosWJ/Extension-Host/hostsys/services"
	"github.com/coder/websocket"
)

const testPluginID = "com.example.echo"

func TestEmbeddedPluginHTTPAndEvents(t *testing.T) {
	manager, err := Open(t.Context(), Options{
		DataDir: t.TempDir(),
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
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

func TestEmbeddedPluginServiceGrants(t *testing.T) {
	backend := &fakePluginBackend{
		services: []extservices.Service{
			{
				Name:        "alpha.service",
				Description: "Alpha",
				State:       extservices.StateRunning,
				StateDetail: "running",
				BootState:   extservices.BootEnabled,
				Actions:     []extservices.Action{extservices.ActionRestart},
			},
			{
				Name:        "beta.service",
				Description: "Beta",
				State:       extservices.StateStopped,
				StateDetail: "dead",
				BootState:   extservices.BootDisabled,
			},
		},
		detail: extservices.ServiceDetail{
			Name:        "alpha.service",
			State:       extservices.StateRunning,
			StateDetail: "running",
			BootState:   extservices.BootEnabled,
		},
	}
	manager, err := Open(t.Context(), Options{
		DataDir:        t.TempDir(),
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServiceBackend: backend,
		ServiceGrants: map[string]host.ServiceGrant{
			testPluginID: {
				Units:   []string{"alpha.service"},
				Actions: []string{"list", "get", "restart"},
				Elevate: []string{"restart"},
			},
		},
	})
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

	api := server.URL + "/extensions/" + testPluginID + "/api"

	response, err = http.Get(api + "/services-list")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("services list = %d, %q", response.StatusCode, body)
	}
	var listed []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &listed); err != nil {
		t.Fatalf("decode services list %q: %v", body, err)
	}
	if len(listed) != 1 || listed[0].Name != "alpha.service" {
		t.Fatalf("services list = %#v, want only alpha.service", listed)
	}

	response, err = http.Get(api + "/services-get?unit=alpha.service")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"name":"alpha.service"`) {
		t.Fatalf("granted get = %d, %q", response.StatusCode, body)
	}

	response, err = http.Get(api + "/services-get?unit=beta.service")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode == http.StatusOK || !strings.Contains(string(body), "is not authorized") {
		t.Fatalf("ungranted get = %d, %q", response.StatusCode, body)
	}

	response, err = http.Post(api+"/services-restart?unit=alpha.service", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("restart = %d, %q", response.StatusCode, body)
	}
	calls := backend.restartCalls()
	if len(calls) != 1 || calls[0].unit != "alpha.service" || !calls[0].elevated {
		t.Fatalf("restart calls = %#v, want one elevated restart of alpha.service", calls)
	}
}

func TestEmbeddedPluginServiceGrantDeniesUngrantedAction(t *testing.T) {
	backend := &fakePluginBackend{
		services: []extservices.Service{{Name: "alpha.service", State: extservices.StateRunning}},
		detail:   extservices.ServiceDetail{Name: "alpha.service", State: extservices.StateRunning},
	}
	manager, err := Open(t.Context(), Options{
		DataDir:        t.TempDir(),
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServiceBackend: backend,
		ServiceGrants: map[string]host.ServiceGrant{
			testPluginID: {
				Units:   []string{"alpha.service"},
				Actions: []string{"list", "get"},
			},
		},
	})
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
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("install = %d", response.StatusCode)
	}
	response = post(t, server.URL+"/api/v1/extensions/"+testPluginID+"/enable")
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("enable = %d", response.StatusCode)
	}

	api := server.URL + "/extensions/" + testPluginID + "/api"
	response, err = http.Post(api+"/services-restart?unit=alpha.service", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode == http.StatusOK || !strings.Contains(string(body), "is not authorized") {
		t.Fatalf("ungranted restart = %d, %q", response.StatusCode, body)
	}
	if calls := backend.restartCalls(); len(calls) != 0 {
		t.Fatalf("restart calls = %#v, want none", calls)
	}
}

type fakePluginRestartCall struct {
	unit     string
	elevated bool
}

type fakePluginBackend struct {
	services []extservices.Service
	detail   extservices.ServiceDetail

	mu       sync.Mutex
	restarts []fakePluginRestartCall
}

func (f *fakePluginBackend) List(context.Context) ([]extservices.Service, error) {
	return f.services, nil
}

func (f *fakePluginBackend) Detail(context.Context, string) (extservices.ServiceDetail, error) {
	return f.detail, nil
}

func (f *fakePluginBackend) Restart(_ context.Context, unit string, elevated bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts = append(f.restarts, fakePluginRestartCall{unit: unit, elevated: elevated})
	return nil
}

func (f *fakePluginBackend) restartCalls() []fakePluginRestartCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakePluginRestartCall(nil), f.restarts...)
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
			"entry": {"web": "web/index.html", "lua": "lua/init.lua"},
			"capabilities": ["services"]
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

local function reply(value)
  return {
    status = 200,
    headers = { ["content-type"] = "application/json; charset=utf-8" },
    body = host.json.encode(value),
  }
end

host.app.route("GET", "/services-list", function()
  return reply(host.services.list())
end)

host.app.route("GET", "/services-get", function(request)
  return reply(host.services.get(request.query.unit))
end)

host.app.route("POST", "/services-restart", function(request)
  host.services.restart(request.query.unit)
  return reply({ ok = true })
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
