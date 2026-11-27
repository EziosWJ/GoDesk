package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func allCapabilities() Capabilities {
	return Capabilities{
		Start: true, Stop: true, Restart: true, Reload: true, DaemonReload: true,
		Enable: true, Disable: true, Logs: true, StateReliable: true,
	}
}

type fakeBackend struct {
	name            string
	caps            Capabilities
	services        []Service
	listErr         error
	detail          ServiceDetail
	detailErr       error
	actionErr       error
	daemonReloadErr error
	logs            []string
	logsErr         error
	stream          []string
	streamErr       error
	streamBlock     bool
	streamStarted   chan struct{}
	streamDone      chan struct{}
	streamResult    error
	calls           []string
	lineCount       int
	listCalls       int
}

func (f *fakeBackend) Name() string {
	if f.name == "" {
		return "fake"
	}
	return f.name
}

func (f *fakeBackend) Capabilities() Capabilities { return f.caps }

func (f *fakeBackend) List(context.Context) ([]Service, error) {
	f.listCalls++
	return f.services, f.listErr
}

func (f *fakeBackend) Detail(_ context.Context, unit string) (ServiceDetail, error) {
	f.calls = append(f.calls, "detail "+unit)
	return f.detail, f.detailErr
}

func (f *fakeBackend) record(action Action, unit string) error {
	f.calls = append(f.calls, string(action)+" "+unit)
	return f.actionErr
}

func (f *fakeBackend) Start(_ context.Context, unit string) error {
	return f.record(ActionStart, unit)
}

func (f *fakeBackend) Stop(_ context.Context, unit string) error {
	return f.record(ActionStop, unit)
}

func (f *fakeBackend) Restart(_ context.Context, unit string) error {
	return f.record(ActionRestart, unit)
}

func (f *fakeBackend) Reload(_ context.Context, unit string) error {
	return f.record(ActionReload, unit)
}

func (f *fakeBackend) DaemonReload(context.Context) error {
	f.calls = append(f.calls, "daemon-reload")
	return f.daemonReloadErr
}

func (f *fakeBackend) Enable(_ context.Context, unit string) error {
	return f.record(ActionEnable, unit)
}

func (f *fakeBackend) Disable(_ context.Context, unit string) error {
	return f.record(ActionDisable, unit)
}

func (f *fakeBackend) Logs(_ context.Context, unit string, lines int) ([]string, error) {
	f.calls = append(f.calls, "logs "+unit)
	f.lineCount = lines
	return f.logs, f.logsErr
}

func (f *fakeBackend) StreamLogs(ctx context.Context, unit string, initialLines int, emit func(string) error) error {
	f.calls = append(f.calls, "stream "+unit)
	f.lineCount = initialLines
	if f.streamStarted != nil {
		close(f.streamStarted)
	}
	if f.streamDone != nil {
		defer close(f.streamDone)
	}
	err := f.streamOnce(ctx, emit)
	f.streamResult = err
	return err
}

func (f *fakeBackend) streamOnce(ctx context.Context, emit func(string) error) error {
	for _, line := range f.stream {
		if err := emit(line); err != nil {
			return err
		}
	}
	if f.streamErr != nil {
		return f.streamErr
	}
	if f.streamBlock {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}

func testMux(backend Backend) *http.ServeMux {
	mux := http.NewServeMux()
	Register(mux, func(next http.Handler) http.Handler { return next }, backend)
	return mux
}

func request(mux http.Handler, method, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
	return recorder
}

func TestList(t *testing.T) {
	backend := &fakeBackend{
		name: "systemd",
		caps: allCapabilities(),
		services: []Service{{
			Name: "ssh.service", Description: "OpenBSD Secure Shell server",
			State: StateRunning, StateDetail: "active (running)", BootState: BootEnabled,
			Actions: []Action{ActionStop, ActionRestart, ActionDisable},
		}},
	}
	recorder := request(testMux(backend), http.MethodGet, "/api/v1/services")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q", got)
	}
	var response listResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Backend != "systemd" || len(response.Services) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
	if response.Services[0].Name != "ssh.service" || response.Services[0].State != StateRunning {
		t.Errorf("unexpected service: %+v", response.Services[0])
	}
}

func TestListNoneBackend(t *testing.T) {
	recorder := request(testMux(None()), http.MethodGet, "/api/v1/services")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var response struct {
		Backend  string          `json:"backend"`
		Services json.RawMessage `json:"services"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Backend != "none" {
		t.Errorf("backend = %q, want none", response.Backend)
	}
	if strings.TrimSpace(string(response.Services)) != "[]" {
		t.Errorf("services = %s, want []", response.Services)
	}
}

func TestActionSuccess(t *testing.T) {
	backend := &fakeBackend{services: []Service{{Name: "ssh.service", Actions: []Action{ActionStop}}}}
	recorder := request(testMux(backend), http.MethodPost, "/api/v1/services/ssh.service/stop")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
	if len(backend.calls) != 1 || backend.calls[0] != "stop ssh.service" {
		t.Fatalf("calls = %v", backend.calls)
	}
}

func TestReloadSuccess(t *testing.T) {
	backend := &fakeBackend{services: []Service{{Name: "ssh.service", Actions: []Action{ActionReload}}}}
	recorder := request(testMux(backend), http.MethodPost, "/api/v1/services/ssh.service/reload")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0] != "reload ssh.service" {
		t.Fatalf("calls = %v", backend.calls)
	}
}

func TestActionRejected(t *testing.T) {
	tests := []struct {
		name      string
		method    string
		path      string
		actions   []Action
		actionErr error
		status    int
		code      string
	}{
		{"action not allowed", http.MethodPost, "/api/v1/services/ssh.service/start", []Action{ActionStop}, nil, http.StatusConflict, "action_not_allowed"},
		{"unit not found", http.MethodPost, "/api/v1/services/cron.service/stop", []Action{ActionStop}, nil, http.StatusNotFound, "not_found"},
		{"invalid unit", http.MethodPost, "/api/v1/services/ssh.socket/stop", []Action{ActionStop}, nil, http.StatusBadRequest, "invalid_unit"},
		{"invalid action", http.MethodPost, "/api/v1/services/ssh.service/explode", []Action{ActionStop}, nil, http.StatusBadRequest, "invalid_action"},
		{"reload not allowed", http.MethodPost, "/api/v1/services/ssh.service/reload", []Action{ActionStop}, nil, http.StatusConflict, "action_not_allowed"},
		{"reload permission", http.MethodPost, "/api/v1/services/ssh.service/reload", []Action{ActionReload}, &Error{Code: "permission", Message: "Access denied"}, http.StatusForbidden, "permission"},
		{"permission", http.MethodPost, "/api/v1/services/ssh.service/stop", []Action{ActionStop}, &Error{Code: "permission", Message: "Access denied"}, http.StatusForbidden, "permission"},
		{"operation failed", http.MethodPost, "/api/v1/services/ssh.service/stop", []Action{ActionStop}, &Error{Code: "operation_failed", Message: "boom"}, http.StatusUnprocessableEntity, "operation_failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				services:  []Service{{Name: "ssh.service", Actions: tc.actions}},
				actionErr: tc.actionErr,
			}
			recorder := request(testMux(backend), tc.method, tc.path)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.status, recorder.Body.String())
			}
			var body errorBody
			if tc.status != http.StatusNoContent {
				if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if body.Code != tc.code {
					t.Errorf("code = %q, want %q", body.Code, tc.code)
				}
			}
		})
	}
}

type blockingBackend struct {
	*fakeBackend
}

func (b *blockingBackend) Stop(ctx context.Context, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestActionTimeout(t *testing.T) {
	backend := &blockingBackend{&fakeBackend{
		services: []Service{{Name: "ssh.service", Actions: []Action{ActionStop}}},
	}}
	h := &handler{backend: backend, listTimeout: time.Second, actionTimeout: 10 * time.Millisecond, logsTimeout: time.Second}
	mux := http.NewServeMux()
	mux.Handle("POST /api/v1/services/{unit}/{action}", http.HandlerFunc(h.action))
	recorder := request(mux, http.MethodPost, "/api/v1/services/ssh.service/stop")
	if recorder.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusGatewayTimeout)
	}
	var body errorBody
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "timeout" {
		t.Errorf("code = %q, want timeout", body.Code)
	}
}

func TestDaemonReload(t *testing.T) {
	backend := &fakeBackend{caps: allCapabilities()}
	recorder := request(testMux(backend), http.MethodPost, "/api/v1/services/daemon-reload")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0] != "daemon-reload" {
		t.Fatalf("calls = %v", backend.calls)
	}
}

func TestDaemonReloadRejected(t *testing.T) {
	tests := []struct {
		name   string
		caps   Capabilities
		err    error
		status int
		code   string
	}{
		{"unsupported", Capabilities{}, nil, http.StatusConflict, "unsupported"},
		{"permission", allCapabilities(), &Error{Code: "permission", Message: "Access denied"}, http.StatusForbidden, "permission"},
		{"operation failed", allCapabilities(), &Error{Code: "operation_failed", Message: "boom"}, http.StatusUnprocessableEntity, "operation_failed"},
		{"timeout", allCapabilities(), context.DeadlineExceeded, http.StatusGatewayTimeout, "timeout"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{caps: tc.caps, daemonReloadErr: tc.err}
			recorder := request(testMux(backend), http.MethodPost, "/api/v1/services/daemon-reload")
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.status, recorder.Body.String())
			}
			var body errorBody
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
			if tc.name == "unsupported" && len(backend.calls) != 0 {
				t.Errorf("calls = %v, want none", backend.calls)
			}
		})
	}
}

func TestDaemonReloadNoneBackend(t *testing.T) {
	recorder := request(testMux(None()), http.MethodPost, "/api/v1/services/daemon-reload")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusConflict, recorder.Body.String())
	}
	var body errorBody
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "unsupported" {
		t.Errorf("code = %q, want unsupported", body.Code)
	}
}

func TestStreamLogs(t *testing.T) {
	backend := &fakeBackend{
		caps:     allCapabilities(),
		services: []Service{{Name: "ssh.service"}},
		stream:   []string{"line one", "line two"},
	}
	recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service/logs/stream?lines=250")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	for header, want := range map[string]string{
		"Content-Type":      "text/event-stream; charset=utf-8",
		"Cache-Control":     "no-store",
		"Connection":        "keep-alive",
		"X-Accel-Buffering": "no",
	} {
		if got := recorder.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	want := ": connected\n\n" +
		"data: {\"line\":\"line one\"}\n\n" +
		"data: {\"line\":\"line two\"}\n\n"
	if got := recorder.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	if backend.lineCount != 250 {
		t.Errorf("lines param = %d, want 250", backend.lineCount)
	}
	if len(backend.calls) != 1 || backend.calls[0] != "stream ssh.service" {
		t.Errorf("calls = %v", backend.calls)
	}
}

func TestStreamLogsLineCounts(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  int
	}{
		{"default", "", 200},
		{"zero follows new entries", "?lines=0", 0},
		{"upper bound", "?lines=1000", 1000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				caps:     allCapabilities(),
				services: []Service{{Name: "ssh.service"}},
			}
			recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service/logs/stream"+tc.query)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusOK, recorder.Body.String())
			}
			if backend.lineCount != tc.want {
				t.Errorf("lines param = %d, want %d", backend.lineCount, tc.want)
			}
		})
	}
}

func TestStreamLogsRejected(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		caps   Capabilities
		status int
		code   string
	}{
		{"invalid unit", "/api/v1/services/ssh.socket/logs/stream", allCapabilities(), http.StatusBadRequest, "invalid_unit"},
		{"negative lines", "/api/v1/services/ssh.service/logs/stream?lines=-1", allCapabilities(), http.StatusBadRequest, "invalid_lines"},
		{"too many lines", "/api/v1/services/ssh.service/logs/stream?lines=1001", allCapabilities(), http.StatusBadRequest, "invalid_lines"},
		{"non numeric lines", "/api/v1/services/ssh.service/logs/stream?lines=abc", allCapabilities(), http.StatusBadRequest, "invalid_lines"},
		{"unit not found", "/api/v1/services/cron.service/logs/stream", allCapabilities(), http.StatusNotFound, "not_found"},
		{"logs unavailable", "/api/v1/services/ssh.service/logs/stream", Capabilities{}, http.StatusConflict, "logs_unavailable"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				caps:     tc.caps,
				services: []Service{{Name: "ssh.service"}},
			}
			recorder := request(testMux(backend), http.MethodGet, tc.path)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.status, recorder.Body.String())
			}
			if got := recorder.Header().Get("Content-Type"); got != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", got)
			}
			var body errorBody
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
			if len(backend.calls) != 0 {
				t.Errorf("calls = %v, want none", backend.calls)
			}
		})
	}
}

func TestStreamLogsErrorEvent(t *testing.T) {
	tests := []struct {
		name   string
		stream []string
		err    error
		want   string
	}{
		{
			name:   "error after lines",
			stream: []string{"line one"},
			err:    &Error{Code: "permission", Message: "Access denied"},
			want: ": connected\n\n" +
				"data: {\"line\":\"line one\"}\n\n" +
				"event: error\ndata: {\"code\":\"permission\",\"message\":\"Access denied\"}\n\n",
		},
		{
			name: "error before first line",
			err:  &Error{Code: "logs_unavailable", Message: "journalctl 不可用"},
			want: ": connected\n\n" +
				"event: error\ndata: {\"code\":\"logs_unavailable\",\"message\":\"journalctl 不可用\"}\n\n",
		},
		{
			name: "unknown error",
			err:  errors.New("boom"),
			want: ": connected\n\n" +
				"event: error\ndata: {\"code\":\"operation_failed\",\"message\":\"boom\"}\n\n",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				caps:      allCapabilities(),
				services:  []Service{{Name: "ssh.service"}},
				stream:    tc.stream,
				streamErr: tc.err,
			}
			recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service/logs/stream")
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusOK, recorder.Body.String())
			}
			if got := recorder.Body.String(); got != tc.want {
				t.Errorf("body = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestStreamLogsClientCancel(t *testing.T) {
	started := make(chan struct{})
	done := make(chan struct{})
	backend := &fakeBackend{
		caps:          allCapabilities(),
		services:      []Service{{Name: "ssh.service"}},
		streamBlock:   true,
		streamStarted: started,
		streamDone:    done,
	}
	server := httptest.NewServer(testMux(backend))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/services/ssh.service/logs/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("StreamLogs was not called")
	}
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("StreamLogs was not stopped by client cancellation")
	}
	if !errors.Is(backend.streamResult, context.Canceled) {
		t.Errorf("StreamLogs result = %v, want context.Canceled", backend.streamResult)
	}
}

func TestLogs(t *testing.T) {
	backend := &fakeBackend{
		services: []Service{{Name: "ssh.service"}},
		logs:     []string{"line one", "line two"},
	}
	recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service/logs?lines=500")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var response struct {
		Lines []string `json:"lines"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if len(response.Lines) != 2 || response.Lines[0] != "line one" {
		t.Errorf("lines = %v", response.Lines)
	}
	if backend.lineCount != 500 {
		t.Errorf("lines param = %d, want 500", backend.lineCount)
	}
}

func TestLogsRejected(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		logs   []string
		logErr error
		status int
		code   string
	}{
		{"zero lines", "/api/v1/services/ssh.service/logs?lines=0", nil, nil, http.StatusBadRequest, "invalid_lines"},
		{"too many lines", "/api/v1/services/ssh.service/logs?lines=1001", nil, nil, http.StatusBadRequest, "invalid_lines"},
		{"non numeric lines", "/api/v1/services/ssh.service/logs?lines=abc", nil, nil, http.StatusBadRequest, "invalid_lines"},
		{"invalid unit", "/api/v1/services/ssh.socket/logs", nil, nil, http.StatusBadRequest, "invalid_unit"},
		{"unit not found", "/api/v1/services/cron.service/logs", nil, nil, http.StatusNotFound, "not_found"},
		{"permission", "/api/v1/services/ssh.service/logs", nil, &Error{Code: "permission", Message: "Access denied"}, http.StatusForbidden, "permission"},
		{"logs unavailable", "/api/v1/services/ssh.service/logs", nil, &Error{Code: "logs_unavailable", Message: "no journalctl"}, http.StatusConflict, "logs_unavailable"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{
				services: []Service{{Name: "ssh.service"}},
				logs:     tc.logs,
				logsErr:  tc.logErr,
			}
			recorder := request(testMux(backend), http.MethodGet, tc.path)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.status, recorder.Body.String())
			}
			var body errorBody
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
		})
	}
}

func TestLogsEmpty(t *testing.T) {
	backend := &fakeBackend{services: []Service{{Name: "ssh.service"}}}
	recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service/logs")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var response struct {
		Lines json.RawMessage `json:"lines"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(response.Lines)) != "[]" {
		t.Errorf("lines = %s, want []", response.Lines)
	}
}

func TestDetail(t *testing.T) {
	pid := 1234
	memory := int64(13844480)
	cpu := int64(2391500000)
	backend := &fakeBackend{detail: ServiceDetail{
		Name: "ssh.service", State: StateRunning, StateDetail: "active (running)", BootState: BootEnabled,
		MainPID: &pid, MemoryBytes: &memory, CPUUsageNs: &cpu,
		ActiveEnterTimestamp: "Fri 2026-11-21 10:00:00 CST",
		FragmentPath:         "/usr/lib/systemd/system/ssh.service",
	}}
	recorder := request(testMux(backend), http.MethodGet, "/api/v1/services/ssh.service")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response ServiceDetail
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Name != "ssh.service" || response.State != StateRunning || response.BootState != BootEnabled {
		t.Fatalf("unexpected detail: %+v", response)
	}
	if response.MainPID == nil || *response.MainPID != pid || response.MemoryBytes == nil || *response.MemoryBytes != memory {
		t.Errorf("unexpected numeric fields: %+v", response)
	}
	if backend.listCalls != 0 {
		t.Errorf("detail called List %d times, want 0", backend.listCalls)
	}
	if len(backend.calls) != 1 || backend.calls[0] != "detail ssh.service" {
		t.Errorf("calls = %v", backend.calls)
	}
}

func TestDetailRejected(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		err    error
		status int
		code   string
	}{
		{"invalid unit", "/api/v1/services/ssh.socket", nil, http.StatusBadRequest, "invalid_unit"},
		{"not found", "/api/v1/services/cron.service", &Error{Code: "not_found", Message: "missing"}, http.StatusNotFound, "not_found"},
		{"permission", "/api/v1/services/ssh.service", &Error{Code: "permission", Message: "denied"}, http.StatusForbidden, "permission"},
		{"operation failed", "/api/v1/services/ssh.service", &Error{Code: "operation_failed", Message: "boom"}, http.StatusUnprocessableEntity, "operation_failed"},
		{"timeout", "/api/v1/services/ssh.service", context.DeadlineExceeded, http.StatusGatewayTimeout, "timeout"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			backend := &fakeBackend{detailErr: tc.err}
			recorder := request(testMux(backend), http.MethodGet, tc.path)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, tc.status, recorder.Body.String())
			}
			var body errorBody
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
		})
	}
}

func TestDetailNoneBackend(t *testing.T) {
	recorder := request(testMux(None()), http.MethodGet, "/api/v1/services/ssh.service")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}
}

func TestFailedMapping(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"deadline", context.DeadlineExceeded, http.StatusGatewayTimeout, "timeout"},
		{"canceled", context.Canceled, http.StatusGatewayTimeout, "timeout"},
		{"permission", &Error{Code: "permission", Message: "denied"}, http.StatusForbidden, "permission"},
		{"not found", &Error{Code: "not_found", Message: "missing"}, http.StatusNotFound, "not_found"},
		{"logs unavailable", &Error{Code: "logs_unavailable", Message: "missing"}, http.StatusConflict, "logs_unavailable"},
		{"action not allowed", &Error{Code: "action_not_allowed", Message: "no"}, http.StatusConflict, "action_not_allowed"},
		{"unsupported", &Error{Code: "unsupported", Message: "no"}, http.StatusConflict, "unsupported"},
		{"operation failed", &Error{Code: "operation_failed", Message: "boom"}, http.StatusUnprocessableEntity, "operation_failed"},
		{"unknown service error", &Error{Code: "other", Message: "boom"}, http.StatusUnprocessableEntity, "operation_failed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			failed(recorder, tc.err)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
			}
			var body errorBody
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tc.code {
				t.Errorf("code = %q, want %q", body.Code, tc.code)
			}
		})
	}
}
