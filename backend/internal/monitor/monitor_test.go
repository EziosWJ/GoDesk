package monitor

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func waitForSnapshot(t *testing.T, collector *Collector) Snapshot {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if snapshot, ok := collector.Snapshot(); ok && len(snapshot.Series.CPU) > 0 {
			return snapshot
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("collector did not produce a snapshot")
	return Snapshot{}
}

func TestCollectorProducesSnapshot(t *testing.T) {
	collector := Start(t.Context(), 10*time.Millisecond)
	t.Cleanup(collector.Close)

	snapshot := waitForSnapshot(t, collector)
	if snapshot.Platform == "" {
		t.Error("platform is empty")
	}
	if snapshot.CPU == nil {
		t.Error("cpu is nil")
	}
	if snapshot.Memory == nil || snapshot.Memory.Total == 0 {
		t.Error("memory is missing")
	}
	if len(snapshot.Series.CPU) == 0 || len(snapshot.Series.CPU) > historySize {
		t.Errorf("cpu series length = %d", len(snapshot.Series.CPU))
	}
	if len(snapshot.Series.Memory) != len(snapshot.Series.CPU) {
		t.Errorf("memory series length = %d, cpu series length = %d", len(snapshot.Series.Memory), len(snapshot.Series.CPU))
	}
	if snapshot.Disks == nil {
		t.Error("disks is nil")
	}
	if snapshot.Network == nil {
		t.Error("network is nil")
	}
}

func TestPortsIncludeOwnListeners(t *testing.T) {
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpListener.Close()
	udpListener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udpListener.Close()

	tcpPort := uint32(tcpListener.Addr().(*net.TCPAddr).Port)
	udpPort := uint32(udpListener.LocalAddr().(*net.UDPAddr).Port)

	ports, err := ListPorts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		protocol string
		port     uint32
	}{{"tcp", tcpPort}, {"udp", udpPort}} {
		found := false
		for _, port := range ports {
			if port.Protocol != want.protocol || port.Port != want.port {
				continue
			}
			found = true
			if port.PID != int32(os.Getpid()) {
				t.Errorf("%s:%d pid = %d, want %d", want.protocol, want.port, port.PID, os.Getpid())
			}
			if port.Process == "" {
				t.Errorf("%s:%d process name is empty", want.protocol, want.port)
			}
			break
		}
		if !found {
			t.Errorf("%s:%d not found in %d ports", want.protocol, want.port, len(ports))
		}
	}
}

func TestMetricsEndpoint(t *testing.T) {
	collector := Start(t.Context(), 10*time.Millisecond)
	t.Cleanup(collector.Close)
	waitForSnapshot(t, collector)

	mux := http.NewServeMux()
	collector.Register(mux, func(next http.Handler) http.Handler { return next })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics returned %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(recorder.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.CPU == nil {
		t.Error("decoded cpu is nil")
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/ports", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("ports returned %d, want %d", recorder.Code, http.StatusOK)
	}
	var ports []Port
	if err := json.Unmarshal(recorder.Body.Bytes(), &ports); err != nil {
		t.Fatal(err)
	}
}

func TestMetricsEndpointUnavailable(t *testing.T) {
	collector := newCollector(time.Second)
	mux := http.NewServeMux()
	collector.Register(mux, func(next http.Handler) http.Handler { return next })

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/metrics", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("metrics returned %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	var body errorBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "metrics_unavailable" {
		t.Errorf("code = %q, want metrics_unavailable", body.Code)
	}
}
