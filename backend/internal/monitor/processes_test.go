package monitor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func processStatLine(name, state string, ppid int, utime, stime uint64, threads int, start uint64, rss int64) string {
	fields := []string{
		"1234", "(" + name + ")", state, strconv.Itoa(ppid),
		"1234", "1234", "0", "-1", "4194560", "100", "0", "0", "0",
		strconv.FormatUint(utime, 10), strconv.FormatUint(stime, 10), "0", "0", "20", "0",
		strconv.Itoa(threads), "0", strconv.FormatUint(start, 10), "1000000", strconv.FormatInt(rss, 10),
	}
	for len(fields) < 50 {
		fields = append(fields, "0")
	}
	return strings.Join(fields, " ")
}

func TestParseProcStat(t *testing.T) {
	line := processStatLine("my proc (x)", "S", 1, 15, 25, 3, 5000, 500)
	stat, err := parseProcStat(1234, line)
	if err != nil {
		t.Fatal(err)
	}
	if stat.pid != 1234 || stat.name != "my proc (x)" || stat.state != "S" || stat.parent != 1 {
		t.Errorf("stat = %+v", stat)
	}
	if stat.ticks != 40 || stat.startTicks != 5000 || stat.threads != 3 || stat.rssPages != 500 {
		t.Errorf("stat values = %+v", stat)
	}

	record, err := parseProcessStat(1234, line)
	if err != nil {
		t.Fatal(err)
	}
	if record.PID != 1234 || record.Process != "my proc (x)" || record.StartTicks != 5000 || record.parent != 1 {
		t.Errorf("record = %+v", record)
	}

	if _, err := parseProcStat(1, "1 (bad"); err == nil {
		t.Error("malformed comm should fail")
	}
	if _, err := parseProcStat(1, "1 (ok) S 1 2"); err == nil {
		t.Error("short stat should fail")
	}
}

func TestBuildProcessInfosCPUPercent(t *testing.T) {
	now := time.Unix(1000, 0).UTC()
	samples := []procSample{
		{pid: 10, startTicks: 100, ticks: 200, rssBytes: 100, name: "a", user: "root", state: "S", parent: 1},
		{pid: 11, startTicks: 200, ticks: 10, rssBytes: 200, name: "b", user: "root", state: "S", parent: 1},
		{pid: 12, startTicks: 300, ticks: 50, rssBytes: 300, name: "c", user: "root", state: "S", parent: 1},
	}
	previous := map[processKey]uint64{
		{pid: 10, startTicks: 100}: 100,
		{pid: 11, startTicks: 200}: 5,
		{pid: 12, startTicks: 999}: 1,
	}
	infos := buildProcessInfos(samples, previous, now.Add(-2*time.Second), now, 100, 2)
	if len(infos) != 3 {
		t.Fatalf("infos = %d, want 3", len(infos))
	}
	// Budget is 2s * 100 ticks * 2 cores = 400 ticks.
	if infos[0].CPUPercent != 25 {
		t.Errorf("pid 10 cpu = %v, want 25", infos[0].CPUPercent)
	}
	if infos[1].CPUPercent != 1.25 {
		t.Errorf("pid 11 cpu = %v, want 1.25", infos[1].CPUPercent)
	}
	if infos[2].CPUPercent != 0 {
		t.Errorf("pid 12 cpu = %v, want 0 for a changed process", infos[2].CPUPercent)
	}

	first := buildProcessInfos(samples, nil, time.Time{}, now, 100, 2)
	for _, info := range first {
		if info.CPUPercent != 0 {
			t.Errorf("first scan pid %d cpu = %v, want 0", info.PID, info.CPUPercent)
		}
	}
}

func TestProcessCPUPercentClamp(t *testing.T) {
	if got := processCPUPercent(1000, 1, 100, 1); got != 100 {
		t.Errorf("clamped cpu = %v, want 100", got)
	}
	if got := processCPUPercent(10, 0, 100, 1); got != 0 {
		t.Errorf("zero elapsed cpu = %v, want 0", got)
	}
}

func TestFilterAndSortProcesses(t *testing.T) {
	processes := []ProcessInfo{
		{PID: 10, Name: "Alice", User: "root", CPUPercent: 1, RSSBytes: 300},
		{PID: 20, Name: "bob", User: "daemon", CPUPercent: 3, RSSBytes: 100},
		{PID: 30, Name: "carol", User: "root", CPUPercent: 2, RSSBytes: 200},
	}
	if got := filterProcesses(processes, "ALI"); len(got) != 1 || got[0].PID != 10 {
		t.Errorf("name query = %+v", got)
	}
	if got := filterProcesses(processes, "ROOT"); len(got) != 2 {
		t.Errorf("user query returned %d, want 2", len(got))
	}
	if got := filterProcesses(processes, "20"); len(got) != 1 || got[0].PID != 20 {
		t.Errorf("pid query = %+v", got)
	}
	if got := filterProcesses(processes, "  "); len(got) != 3 {
		t.Errorf("blank query returned %d, want 3", len(got))
	}

	cpu := append([]ProcessInfo{}, processes...)
	sortProcesses(cpu, "cpu", "desc")
	if cpu[0].PID != 20 || cpu[1].PID != 30 || cpu[2].PID != 10 {
		t.Errorf("cpu desc order = %+v", cpu)
	}

	memory := append([]ProcessInfo{}, processes...)
	sortProcesses(memory, "memory", "asc")
	if memory[0].PID != 20 || memory[1].PID != 30 || memory[2].PID != 10 {
		t.Errorf("memory asc order = %+v", memory)
	}

	name := append([]ProcessInfo{}, processes...)
	sortProcesses(name, "name", "asc")
	if name[0].PID != 10 || name[1].PID != 20 || name[2].PID != 30 {
		t.Errorf("name asc order = %+v", name)
	}

	pid := append([]ProcessInfo{}, processes...)
	sortProcesses(pid, "pid", "desc")
	if pid[0].PID != 30 || pid[2].PID != 10 {
		t.Errorf("pid desc order = %+v", pid)
	}

	if defaultProcessOrder("cpu") != "desc" || defaultProcessOrder("memory") != "desc" {
		t.Error("cpu and memory should default to descending")
	}
	if defaultProcessOrder("pid") != "asc" || defaultProcessOrder("name") != "asc" {
		t.Error("pid and name should default to ascending")
	}
	if !validProcessSort("cpu") || validProcessSort("state") {
		t.Error("validProcessSort is wrong")
	}
}

func TestProtectedProcessIDs(t *testing.T) {
	samples := []procSample{
		{pid: 1},
		{pid: 100, parent: 1},
		{pid: 200, parent: 100},
		{pid: 300, parent: 200},
		{pid: 400, parent: 1},
	}
	got := protectedProcessIDs(samples, 300)
	want := []int{1, 100, 200, 300}
	if len(got) != len(want) {
		t.Fatalf("protected = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("protected = %v, want %v", got, want)
		}
	}

	missing := protectedProcessIDs([]procSample{{pid: 1}}, 500)
	if len(missing) != 2 || missing[0] != 1 || missing[1] != 500 {
		t.Errorf("protected with missing parent = %v", missing)
	}
}

func newProcessTestMux(t *testing.T, execute processSignalExecutor) *http.ServeMux {
	t.Helper()
	collector := newCollector(time.Second)
	mux := http.NewServeMux()
	collector.register(mux, func(next http.Handler) http.Handler { return next }, runPortOperation, execute)
	return mux
}

func getJSON(t *testing.T, mux *http.ServeMux, path string, target any) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	if target != nil && recorder.Code == http.StatusOK {
		if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
			t.Fatal(err)
		}
	}
	return recorder
}

func TestProcessListEndpoint(t *testing.T) {
	mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
		return processSignalResult{Status: http.StatusNoContent}
	})

	var list ProcessList
	recorder := getJSON(t, mux, "/api/v1/system/processes", &list)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list returned %d: %s", recorder.Code, recorder.Body)
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Error("missing no-store")
	}
	if list.SelfPID != os.Getpid() {
		t.Errorf("selfPid = %d, want %d", list.SelfPID, os.Getpid())
	}
	if list.Total != len(list.Processes) {
		t.Errorf("total = %d, processes = %d", list.Total, len(list.Processes))
	}
	hasSelf, hasInit := false, false
	for _, pid := range list.ProtectedPIDs {
		if pid == os.Getpid() {
			hasSelf = true
		}
		if pid == 1 {
			hasInit = true
		}
	}
	if !hasSelf || !hasInit {
		t.Errorf("protectedPids = %v, want PID 1 and %d", list.ProtectedPIDs, os.Getpid())
	}

	var self ProcessInfo
	found := false
	for _, process := range list.Processes {
		if process.PID == os.Getpid() {
			self, found = process, true
			break
		}
	}
	if !found {
		t.Fatalf("self PID %d missing from list", os.Getpid())
	}
	if self.StartTicks == 0 || self.Name == "" || self.User == "" {
		t.Errorf("self row = %+v", self)
	}
	if self.CPUPercent != 0 {
		t.Errorf("first scan cpuPercent = %v, want 0", self.CPUPercent)
	}

	// Search and sort are applied server-side.
	recorder = getJSON(t, mux, fmt.Sprintf("/api/v1/system/processes?q=%d&sort=pid&order=asc", os.Getpid()), &list)
	if recorder.Code != http.StatusOK {
		t.Fatalf("filtered list returned %d: %s", recorder.Code, recorder.Body)
	}
	if len(list.Processes) == 0 || list.Processes[0].PID != os.Getpid() {
		t.Errorf("filtered list = %+v", list.Processes)
	}

	if recorder = getJSON(t, mux, "/api/v1/system/processes?sort=state", nil); recorder.Code != http.StatusBadRequest {
		t.Errorf("invalid sort returned %d, want 400", recorder.Code)
	}
	if recorder = getJSON(t, mux, "/api/v1/system/processes?order=sideways", nil); recorder.Code != http.StatusBadRequest {
		t.Errorf("invalid order returned %d, want 400", recorder.Code)
	}

	var names ProcessList
	getJSON(t, mux, "/api/v1/system/processes?sort=name&order=asc", &names)
	for i := 1; i < len(names.Processes); i++ {
		if strings.ToLower(names.Processes[i-1].Name) > strings.ToLower(names.Processes[i].Name) {
			t.Fatalf("names not sorted at %d: %q > %q", i, names.Processes[i-1].Name, names.Processes[i].Name)
		}
	}
}

func TestProcessDetailEndpoint(t *testing.T) {
	mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
		return processSignalResult{Status: http.StatusNoContent}
	})
	var list ProcessList
	getJSON(t, mux, "/api/v1/system/processes", &list)
	var self ProcessInfo
	for _, process := range list.Processes {
		if process.PID == os.Getpid() {
			self = process
			break
		}
	}
	if self.StartTicks == 0 {
		t.Fatal("self process missing")
	}

	var detail ProcessDetail
	path := fmt.Sprintf("/api/v1/system/processes/%d?startTicks=%d", self.PID, self.StartTicks)
	recorder := getJSON(t, mux, path, &detail)
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail returned %d: %s", recorder.Code, recorder.Body)
	}
	if detail.PID != os.Getpid() || detail.StartTicks != self.StartTicks {
		t.Errorf("detail identity = %+v", detail)
	}
	if detail.Threads < 1 || detail.StartedAt.IsZero() {
		t.Errorf("detail threads/startedAt = %d/%v", detail.Threads, detail.StartedAt)
	}
	if len(detail.Cmdline) == 0 || detail.CWD == "" {
		t.Errorf("cmdline = %v, cwd = %q", detail.Cmdline, detail.CWD)
	}
	if !detail.IsSelfOrAncestor || detail.Tree == nil {
		t.Errorf("isSelfOrAncestor = %v, tree = %v", detail.IsSelfOrAncestor, detail.Tree)
	}

	recorder = getJSON(t, mux, fmt.Sprintf("/api/v1/system/processes/%d?startTicks=%d", self.PID, self.StartTicks+1), nil)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("stale detail returned %d, want 409", recorder.Code)
	}
	var body errorBody
	json.Unmarshal(recorder.Body.Bytes(), &body)
	if body.Code != "process_changed" {
		t.Errorf("stale detail code = %q", body.Code)
	}

	if recorder = getJSON(t, mux, "/api/v1/system/processes/1073741824", nil); recorder.Code != http.StatusNotFound {
		t.Errorf("missing process returned %d, want 404", recorder.Code)
	}
	if recorder = getJSON(t, mux, "/api/v1/system/processes/not-a-pid", nil); recorder.Code != http.StatusBadRequest {
		t.Errorf("invalid pid returned %d, want 400", recorder.Code)
	}
	if recorder = getJSON(t, mux, fmt.Sprintf("/api/v1/system/processes/%d?startTicks=x", os.Getpid()), nil); recorder.Code != http.StatusBadRequest {
		t.Errorf("invalid startTicks returned %d, want 400", recorder.Code)
	}
}

func signalRequest(mux *http.ServeMux, body, contentType string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/system/processes/signal", strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func TestProcessSignalValidation(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		var operation processSignalOperation
		mux := newProcessTestMux(t, func(_ context.Context, op processSignalOperation) processSignalResult {
			operation = op
			return processSignalResult{Status: http.StatusNoContent}
		})
		body := `{"pid":1234,"startTicks":99,"signal":"SIGTERM"}`
		recorder := signalRequest(mux, body, "application/json")
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("signal returned %d: %s", recorder.Code, recorder.Body)
		}
		if operation.PID != 1234 || operation.StartTicks != 99 || operation.Signal != "SIGTERM" {
			t.Errorf("operation = %+v", operation)
		}
	})

	t.Run("content type", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			t.Fatal("executor must not run")
			return processSignalResult{}
		})
		if recorder := signalRequest(mux, `{"pid":1234,"startTicks":99,"signal":"SIGTERM"}`, "text/plain"); recorder.Code != http.StatusUnsupportedMediaType {
			t.Errorf("content type returned %d, want 415", recorder.Code)
		}
	})

	t.Run("pid one", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			t.Fatal("executor must not run")
			return processSignalResult{}
		})
		recorder := signalRequest(mux, `{"pid":1,"startTicks":1,"signal":"SIGTERM"}`, "application/json")
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("pid 1 returned %d, want 403", recorder.Code)
		}
		var body errorBody
		json.Unmarshal(recorder.Body.Bytes(), &body)
		if body.Code != "forbidden_pid" {
			t.Errorf("code = %q, want forbidden_pid", body.Code)
		}
	})

	t.Run("invalid signal", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			t.Fatal("executor must not run")
			return processSignalResult{}
		})
		recorder := signalRequest(mux, `{"pid":1234,"startTicks":99,"signal":"SIGHUP"}`, "application/json")
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("signal returned %d, want 400", recorder.Code)
		}
		var body errorBody
		json.Unmarshal(recorder.Body.Bytes(), &body)
		if body.Code != "invalid_signal" {
			t.Errorf("code = %q, want invalid_signal", body.Code)
		}
	})

	t.Run("missing start ticks", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			t.Fatal("executor must not run")
			return processSignalResult{}
		})
		if recorder := signalRequest(mux, `{"pid":1234,"signal":"SIGTERM"}`, "application/json"); recorder.Code != http.StatusBadRequest {
			t.Errorf("missing startTicks returned %d, want 400", recorder.Code)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			t.Fatal("executor must not run")
			return processSignalResult{}
		})
		if recorder := signalRequest(mux, `{"pid":`, "application/json"); recorder.Code != http.StatusBadRequest {
			t.Errorf("invalid json returned %d, want 400", recorder.Code)
		}
		if recorder := signalRequest(mux, `{"pid":1234,"startTicks":99,"signal":"SIGTERM"} {}`, "application/json"); recorder.Code != http.StatusBadRequest {
			t.Errorf("trailing json returned %d, want 400", recorder.Code)
		}
	})

	t.Run("sudo unavailable passthrough", func(t *testing.T) {
		mux := newProcessTestMux(t, func(context.Context, processSignalOperation) processSignalResult {
			return signalError(http.StatusForbidden, "sudo_unavailable", "no sudo")
		})
		recorder := signalRequest(mux, `{"pid":1234,"startTicks":99,"signal":"SIGTERM"}`, "application/json")
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("returned %d, want 403", recorder.Code)
		}
		var body errorBody
		json.Unmarshal(recorder.Body.Bytes(), &body)
		if body.Code != "sudo_unavailable" {
			t.Errorf("code = %q, want sudo_unavailable", body.Code)
		}
	})
}

func startSleep(t *testing.T) *exec.Cmd {
	t.Helper()
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if child.ProcessState == nil {
			_ = child.Process.Kill()
			_, _ = child.Process.Wait()
		}
	})
	return child
}

func TestSendSignalProcess(t *testing.T) {
	child := startSleep(t)
	pid := child.Process.Pid
	stat, err := readProcStat(pid)
	if err != nil {
		t.Fatal(err)
	}

	if err := sendSignal(pid, stat.startTicks+1, unix.SIGTERM); !errors.Is(err, errProcessChanged) {
		t.Fatalf("stale signal error = %v, want process changed", err)
	}
	if err := unix.Kill(pid, 0); err != nil {
		t.Fatalf("stale signal reached the process: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	if err := sendSignal(pid, stat.startTicks, unix.SIGTERM); err != nil {
		t.Fatalf("sendSignal = %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = child.Process.Kill()
		<-done
		t.Fatal("child did not exit")
	}

	if err := sendSignal(1<<30, 1, unix.SIGTERM); !errors.Is(err, errProcessNotFound) {
		t.Errorf("missing process error = %v, want not found", err)
	}
}

func TestRunProcessSignalOperation(t *testing.T) {
	child := startSleep(t)
	pid := child.Process.Pid
	stat, err := readProcStat(pid)
	if err != nil {
		t.Fatal(err)
	}

	result := runProcessSignalOperation(t.Context(), processSignalOperation{PID: pid, StartTicks: stat.startTicks, Signal: "SIGHUP"})
	if result.Status != http.StatusBadRequest {
		t.Errorf("invalid signal status = %d", result.Status)
	}
	result = runProcessSignalOperation(t.Context(), processSignalOperation{PID: 1, StartTicks: 1, Signal: "SIGTERM"})
	if result.Status != http.StatusForbidden {
		t.Errorf("pid 1 status = %d", result.Status)
	}
	result = runProcessSignalOperation(t.Context(), processSignalOperation{PID: pid, StartTicks: stat.startTicks + 1, Signal: "SIGTERM"})
	if result.Status != http.StatusConflict {
		t.Errorf("stale status = %d: %s", result.Status, result.Body)
	}
	var body errorBody
	json.Unmarshal(result.Body, &body)
	if body.Code != "process_changed" {
		t.Errorf("stale code = %q", body.Code)
	}

	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	result = runProcessSignalOperation(t.Context(), processSignalOperation{PID: pid, StartTicks: stat.startTicks, Signal: "SIGTERM"})
	if result.Status != http.StatusNoContent {
		t.Fatalf("signal status = %d: %s", result.Status, result.Body)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = child.Process.Kill()
		<-done
		t.Fatal("child did not exit")
	}
}

func TestSignalFailureMapping(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{errProcessNotFound, http.StatusNotFound, "process_not_found"},
		{errProcessChanged, http.StatusConflict, "process_changed"},
		{unix.EPERM, http.StatusForbidden, "permission_denied"},
		{unix.EACCES, http.StatusForbidden, "permission_denied"},
		{errors.New("boom"), http.StatusInternalServerError, "signal_failed"},
	}
	for _, test := range tests {
		result := signalFailure(test.err)
		if result.Status != test.status {
			t.Errorf("signalFailure(%v) status = %d, want %d", test.err, result.Status, test.status)
		}
		var body errorBody
		if err := json.Unmarshal(result.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Code != test.code {
			t.Errorf("signalFailure(%v) code = %q, want %q", test.err, body.Code, test.code)
		}
	}
}

func TestParseSignalName(t *testing.T) {
	if sig, err := parseSignalName("SIGTERM"); err != nil || sig != unix.SIGTERM {
		t.Errorf("SIGTERM = %v, %v", sig, err)
	}
	if sig, err := parseSignalName("SIGKILL"); err != nil || sig != unix.SIGKILL {
		t.Errorf("SIGKILL = %v, %v", sig, err)
	}
	if _, err := parseSignalName("SIGSTOP"); err == nil {
		t.Error("SIGSTOP should be rejected")
	}
}
