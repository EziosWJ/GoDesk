package monitor

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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

func TestIgnoredFilesystem(t *testing.T) {
	ignored := []string{
		"proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "ramfs", "cgroup", "cgroup2",
		"pstore", "bpf", "debugfs", "tracefs", "securityfs", "configfs", "fusectl",
		"mqueue", "hugetlbfs", "autofs", "binfmt_misc", "nsfs", "efivarfs", "rpc_pipefs",
		"overlay", "iso9660", "squashfs", "udf", "erofs",
	}
	for _, fstype := range ignored {
		if !ignoredFilesystem(fstype) {
			t.Errorf("%q should be ignored", fstype)
		}
	}
	for _, fstype := range []string{"ext4", "xfs", "btrfs", "vfat", "ntfs3", "nfs", "cifs"} {
		if ignoredFilesystem(fstype) {
			t.Errorf("%q should not be ignored", fstype)
		}
	}
}

func TestLoopDevice(t *testing.T) {
	for _, device := range []string{"/dev/loop0", "/dev/loop17"} {
		if !loopDevice(device) {
			t.Errorf("%q should be treated as a loop image", device)
		}
	}
	for _, device := range []string{"/dev/sda1", "/dev/nvme0n1p2", ""} {
		if loopDevice(device) {
			t.Errorf("%q should not be treated as a loop image", device)
		}
	}
}

func TestPreferredMount(t *testing.T) {
	tests := []struct {
		candidate string
		existing  string
		want      bool
	}{
		{"/", "/home", true},
		{"/home", "/", false},
		{"/var", "/var/lib", true},
		{"/var/lib", "/var", false},
	}
	for _, test := range tests {
		if got := preferredMount(test.candidate, test.existing); got != test.want {
			t.Errorf("preferredMount(%q, %q) = %v, want %v", test.candidate, test.existing, got, test.want)
		}
	}
}

func TestSelectDefaultRoute(t *testing.T) {
	candidates := []routeCandidate{
		{iface: "wlan0", metric: 600},
		{iface: "eth9", metric: 100, ipv6: true},
		{iface: "eth1", metric: 100},
		{iface: "eth0", metric: 100},
	}
	if got := selectDefaultRoute(candidates); got != "eth0" {
		t.Errorf("selectDefaultRoute = %q, want eth0", got)
	}
	if got := selectDefaultRoute(nil); got != "" {
		t.Errorf("selectDefaultRoute(nil) = %q, want empty", got)
	}
}

func TestParseIPv4Routes(t *testing.T) {
	table := strings.Join([]string{
		"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
		"eth0\t00000000\t0101A8C0\t0003\t0\t0\t0100\t00000000\t0\t0\t0",
		"wlan0\t00000000\t0101A8C0\t0003\t0\t0\t0064\t00000000\t0\t0\t0",
		"eth1\t0001A8C0\t00000000\t0001\t0\t0\t0000\t00FFFFFF\t0\t0\t0",
		"eth2\t00000000\t0101A8C0\t0002\t0\t0\t0000\t00000000\t0\t0\t0",
	}, "\n")
	candidates, err := parseIPv4Routes(strings.NewReader(table))
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d, want 2", len(candidates))
	}
	if got := selectDefaultRoute(candidates); got != "wlan0" {
		t.Errorf("selected %q, want wlan0", got)
	}
}

func TestParseIPv6Routes(t *testing.T) {
	zero := strings.Repeat("0", 32)
	table := strings.Join([]string{
		zero + " 00 " + zero + " 00 " + zero + " 00000100 00000001 00000000 00000001 eth0",
		zero + " 00 " + zero + " 00 " + zero + " 00000064 00000001 00000000 00000001 wlan0",
		zero + " 40 " + zero + " 00 " + zero + " 00000000 00000001 00000000 00000001 eth1",
		zero + " 00 " + zero + " 00 " + zero + " 00000000 00000001 00000000 00000002 eth2",
	}, "\n")
	candidates, err := parseIPv6Routes(strings.NewReader(table))
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d, want 2", len(candidates))
	}
	if got := selectDefaultRoute(candidates); got != "wlan0" {
		t.Errorf("selected %q, want wlan0", got)
	}
}

func TestCollectorSnapshotExtensions(t *testing.T) {
	collector := Start(t.Context(), 10*time.Millisecond)
	t.Cleanup(collector.Close)

	snapshot := waitForSnapshot(t, collector)
	if snapshot.Memory == nil {
		t.Fatal("memory is nil")
	}
	if snapshot.Memory.Available == 0 || snapshot.Memory.Available > snapshot.Memory.Total {
		t.Errorf("available = %d, total = %d", snapshot.Memory.Available, snapshot.Memory.Total)
	}
	defaultCount := 0
	for _, nic := range snapshot.Network {
		if nic.IsDefaultRoute {
			defaultCount++
		}
	}
	if defaultCount > 1 {
		t.Errorf("default route interfaces = %d, want at most 1", defaultCount)
	}
	if name, err := defaultRouteInterface(); err == nil && name != "" {
		found := false
		for _, nic := range snapshot.Network {
			if nic.Name != name {
				continue
			}
			found = true
			if !nic.IsDefaultRoute {
				t.Errorf("%q is the default route but isDefaultRoute is false", name)
			}
		}
		if !found {
			t.Errorf("default route interface %q missing from network snapshot", name)
		}
	}
}

func TestDiskDetailsHaveNoDuplicates(t *testing.T) {
	collector := Start(t.Context(), 10*time.Millisecond)
	t.Cleanup(collector.Close)

	snapshot := waitForSnapshot(t, collector)
	seen := make(map[string]bool)
	for _, disk := range snapshot.Disks {
		if seen[disk.Mountpoint] {
			t.Errorf("duplicate mountpoint %q", disk.Mountpoint)
		}
		seen[disk.Mountpoint] = true
		switch disk.Mountpoint {
		case "/proc", "/sys", "/dev", "/dev/pts":
			t.Errorf("pseudo filesystem %q should be filtered", disk.Mountpoint)
		}
		if disk.InodeUsedPercent != nil && *disk.InodeUsedPercent < 0 {
			t.Errorf("%q inode percentage = %v", disk.Mountpoint, *disk.InodeUsedPercent)
		}
	}
}
