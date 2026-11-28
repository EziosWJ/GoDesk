package host

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	testHostnameTool = "/usr/bin/hostnamectl"
	testTimezoneTool = "/usr/bin/timedatectl"
)

func newTestHandler(env environment, run commandRunner) *handler {
	return &handler{
		info: func() Info {
			return Info{
				Hostname:         "my-linux-host",
				Timezone:         "Asia/Shanghai",
				OS:               "Ubuntu 24.04.1 LTS",
				Kernel:           "6.8.0-45-generic",
				Arch:             "amd64",
				CPUModel:         "AMD EPYC 7763",
				LogicalCores:     8,
				MemoryTotalBytes: 17179869184,
				UptimeSeconds:    123456,
				Version:          "dev",
				User:             "wangjian",
				Capabilities:     env.capabilities,
			}
		},
		environment: func() environment { return env },
		timezones:   func() []string { return []string{"Asia/Shanghai", "Etc/GMT+8", "Europe/Berlin", "UTC"} },
		run:         run,
		timeout:     time.Second,
	}
}

func testMux(h *handler) *http.ServeMux {
	mux := http.NewServeMux()
	h.register(mux, func(next http.Handler) http.Handler { return next })
	return mux
}

func putJSON(mux http.Handler, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func assertErrorBody(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", recorder.Code, status, recorder.Body.String())
	}
	var body errorBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Code != code {
		t.Errorf("code = %q, want %q", body.Code, code)
	}
	if body.Message == "" {
		t.Error("error message is empty")
	}
}

func TestHostHTTP(t *testing.T) {
	env := environment{
		capabilities: Capabilities{SetHostname: true, SetTimezone: true},
		hostnamectl:  testHostnameTool,
		timedatectl:  testTimezoneTool,
	}
	recorder := httptest.NewRecorder()
	testMux(newTestHandler(env, nil)).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/host", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	var info Info
	if err := json.Unmarshal(recorder.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if info.Hostname != "my-linux-host" || info.Timezone != "Asia/Shanghai" || info.OS != "Ubuntu 24.04.1 LTS" {
		t.Errorf("unexpected identity fields: %+v", info)
	}
	if info.Kernel != "6.8.0-45-generic" || info.Arch != "amd64" || info.CPUModel != "AMD EPYC 7763" {
		t.Errorf("unexpected platform fields: %+v", info)
	}
	if info.LogicalCores != 8 || info.MemoryTotalBytes != 17179869184 || info.UptimeSeconds != 123456 {
		t.Errorf("unexpected resource fields: %+v", info)
	}
	if info.Version != "dev" || info.Commit != "" || info.BuildDate != "" {
		t.Errorf("unexpected build fields: %+v", info)
	}
	if info.User != "wangjian" || info.IsRoot {
		t.Errorf("unexpected user fields: %+v", info)
	}
	if info.Capabilities != env.capabilities {
		t.Errorf("capabilities = %+v, want %+v", info.Capabilities, env.capabilities)
	}
}

func TestTimezonesHTTP(t *testing.T) {
	env := environment{capabilities: Capabilities{SetTimezone: true}, timedatectl: testTimezoneTool}
	recorder := httptest.NewRecorder()
	testMux(newTestHandler(env, nil)).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/timezones", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var response timezonesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	want := []string{"Asia/Shanghai", "Etc/GMT+8", "Europe/Berlin", "UTC"}
	if !slices.Equal(response.Timezones, want) {
		t.Errorf("timezones = %v, want %v", response.Timezones, want)
	}
}

func TestHostnameHTTP(t *testing.T) {
	available := environment{
		capabilities: Capabilities{SetHostname: true},
		hostnamectl:  testHostnameTool,
	}

	t.Run("success", func(t *testing.T) {
		var gotPath string
		var gotArgs []string
		run := func(_ context.Context, path string, args ...string) error {
			gotPath, gotArgs = path, args
			return nil
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", recorder.Code, recorder.Body.String())
		}
		var response hostnameResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if response.Hostname != "new-host" {
			t.Errorf("hostname = %q, want new-host", response.Hostname)
		}
		if gotPath != testHostnameTool {
			t.Errorf("command path = %q, want %q", gotPath, testHostnameTool)
		}
		if want := []string{"set-hostname", "--", "new-host"}; !slices.Equal(gotArgs, want) {
			t.Errorf("command args = %v, want %v", gotArgs, want)
		}
	})

	t.Run("invalid hostname", func(t *testing.T) {
		called := false
		run := func(context.Context, string, ...string) error {
			called = true
			return nil
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"-bad"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_hostname")
		if called {
			t.Error("command ran for an invalid hostname")
		}
	})

	t.Run("hostname longer than HOST_NAME_MAX", func(t *testing.T) {
		called := false
		run := func(context.Context, string, ...string) error {
			called = true
			return nil
		}
		// A syntactically valid dotted name that is 65 characters long.
		name := strings.Repeat("a.", 32) + "a"
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"`+name+`"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_hostname")
		if called {
			t.Error("command ran for an over-long hostname")
		}
	})

	t.Run("64 character hostname", func(t *testing.T) {
		run := func(context.Context, string, ...string) error { return nil }
		name := strings.Repeat("a.", 31) + "ab"
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"`+name+`"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("unsupported", func(t *testing.T) {
		env := environment{capabilities: Capabilities{HostnameReason: "systemd_unavailable"}}
		recorder := putJSON(testMux(newTestHandler(env, nil)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusConflict, "unsupported")
	})

	t.Run("capability without tool path", func(t *testing.T) {
		env := environment{capabilities: Capabilities{SetHostname: true}}
		recorder := putJSON(testMux(newTestHandler(env, nil)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusConflict, "unsupported")
	})

	t.Run("malformed json", func(t *testing.T) {
		recorder := putJSON(testMux(newTestHandler(available, nil)), "/api/v1/system/host/hostname", `{"hostname":`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_request")
	})

	t.Run("trailing json", func(t *testing.T) {
		recorder := putJSON(testMux(newTestHandler(available, nil)), "/api/v1/system/host/hostname", `{"hostname":"new-host"} {"hostname":"other"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_request")
	})

	t.Run("wrong content type", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPut, "/api/v1/system/host/hostname", strings.NewReader(`{"hostname":"new-host"}`))
		request.Header.Set("Content-Type", "text/plain")
		recorder := httptest.NewRecorder()
		testMux(newTestHandler(available, nil)).ServeHTTP(recorder, request)
		assertErrorBody(t, recorder, http.StatusUnsupportedMediaType, "invalid_content_type")
	})

	t.Run("permission denied", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: errors.New("exit status 1"), stderr: "sudo: a password is required\n"}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusForbidden, "permission_denied")
	})

	t.Run("sudoers refusal", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: errors.New("exit status 1"), stderr: "Sorry, user wangjian is not allowed to execute '/usr/bin/hostnamectl' as root\n"}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusForbidden, "permission_denied")
	})

	t.Run("sudo unavailable", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: &fs.PathError{Op: "fork/exec", Path: "/usr/bin/sudo", Err: fs.ErrNotExist}}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusForbidden, "sudo_unavailable")
	})

	t.Run("command failure", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: errors.New("exit status 1"), stderr: "Failed to set hostname: Invalid hostname\n"}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusUnprocessableEntity, "operation_failed")
		var body errorBody
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		if !strings.Contains(body.Message, "Failed to set hostname") {
			t.Errorf("message = %q, want the command stderr", body.Message)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: context.DeadlineExceeded}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/hostname", `{"hostname":"new-host"}`)
		assertErrorBody(t, recorder, http.StatusGatewayTimeout, "timeout")
	})
}

func TestTimezoneHTTP(t *testing.T) {
	available := environment{
		capabilities: Capabilities{SetTimezone: true},
		timedatectl:  testTimezoneTool,
	}

	t.Run("success", func(t *testing.T) {
		var gotPath string
		var gotArgs []string
		run := func(_ context.Context, path string, args ...string) error {
			gotPath, gotArgs = path, args
			return nil
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Asia/Shanghai"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", recorder.Code, recorder.Body.String())
		}
		var response timezoneResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if response.Timezone != "Asia/Shanghai" {
			t.Errorf("timezone = %q, want Asia/Shanghai", response.Timezone)
		}
		if gotPath != testTimezoneTool {
			t.Errorf("command path = %q, want %q", gotPath, testTimezoneTool)
		}
		if want := []string{"set-timezone", "--", "Asia/Shanghai"}; !slices.Equal(gotArgs, want) {
			t.Errorf("command args = %v, want %v", gotArgs, want)
		}
	})

	t.Run("etc zone accepted", func(t *testing.T) {
		var gotArgs []string
		run := func(_ context.Context, _ string, args ...string) error {
			gotArgs = args
			return nil
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Etc/GMT+8"}`)
		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %s)", recorder.Code, recorder.Body.String())
		}
		if want := []string{"set-timezone", "--", "Etc/GMT+8"}; !slices.Equal(gotArgs, want) {
			t.Errorf("command args = %v, want %v", gotArgs, want)
		}
	})

	t.Run("unknown timezone", func(t *testing.T) {
		called := false
		run := func(context.Context, string, ...string) error {
			called = true
			return nil
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Mars/Olympus"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_timezone")
		if called {
			t.Error("command ran for an unknown timezone")
		}
	})

	t.Run("unsafe timezone is rejected even when listed", func(t *testing.T) {
		h := newTestHandler(available, nil)
		h.timezones = func() []string { return []string{"../../etc/passwd"} }
		recorder := putJSON(testMux(h), "/api/v1/system/host/timezone", `{"timezone":"../../etc/passwd"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_timezone")
	})

	t.Run("absolute timezone", func(t *testing.T) {
		recorder := putJSON(testMux(newTestHandler(available, nil)), "/api/v1/system/host/timezone", `{"timezone":"/etc/passwd"}`)
		assertErrorBody(t, recorder, http.StatusBadRequest, "invalid_timezone")
	})

	t.Run("unsupported", func(t *testing.T) {
		env := environment{capabilities: Capabilities{TimezoneReason: "systemd_unavailable"}}
		recorder := putJSON(testMux(newTestHandler(env, nil)), "/api/v1/system/host/timezone", `{"timezone":"Asia/Shanghai"}`)
		assertErrorBody(t, recorder, http.StatusConflict, "unsupported")
	})

	t.Run("permission denied", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: errors.New("exit status 1"), stderr: "sudo: a password is required\n"}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Asia/Shanghai"}`)
		assertErrorBody(t, recorder, http.StatusForbidden, "permission_denied")
	})

	t.Run("command failure", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return &commandError{err: errors.New("exit status 1"), stderr: "Failed to set time zone: Invalid zone\n"}
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Asia/Shanghai"}`)
		assertErrorBody(t, recorder, http.StatusUnprocessableEntity, "operation_failed")
	})

	t.Run("plain error", func(t *testing.T) {
		run := func(context.Context, string, ...string) error {
			return errors.New("boom")
		}
		recorder := putJSON(testMux(newTestHandler(available, run)), "/api/v1/system/host/timezone", `{"timezone":"Asia/Shanghai"}`)
		assertErrorBody(t, recorder, http.StatusUnprocessableEntity, "operation_failed")
	})
}
