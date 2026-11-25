package monitor

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestInheritedListenerStopOnlySelectedProcess(t *testing.T) {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	socket, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()

	child := exec.Command(os.Args[0], "-test.run=^TestListeningWorker$")
	child.Env = append(os.Environ(), "GODESK_TEST_WORKER=1")
	child.ExtraFiles = []*os.File{socket}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	defer func() {
		_ = child.Process.Kill()
		<-done
	}()
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	go func() { done <- child.Wait(); close(done) }()
	if err != nil || strings.TrimSpace(ready) != "ready" {
		t.Fatalf("worker failed to start: %q, %v", ready, err)
	}

	endpoint := Endpoint{Protocol: "tcp", Address: "127.0.0.1", Port: uint32(listener.Addr().(*net.TCPAddr).Port)}
	owners := func() []PortOwner {
		t.Helper()
		ports, err := ListPorts(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		for _, port := range ports {
			if port.Endpoint == endpoint {
				return port.Owners
			}
		}
		t.Fatalf("missing listener %+v", endpoint)
		return nil
	}

	shared := owners()
	if len(shared) != 2 || !slices.ContainsFunc(shared, func(owner PortOwner) bool { return owner.PID == os.Getpid() }) {
		t.Fatalf("expected two holders including test process, got %+v", shared)
	}
	index := slices.IndexFunc(shared, func(owner PortOwner) bool { return owner.PID == child.Process.Pid })
	if index == -1 {
		t.Fatalf("missing inherited listener in %+v", shared)
	}
	worker := shared[index]
	target := portTarget{Endpoint: endpoint, PID: worker.PID, StartTicks: worker.StartTicks}
	result := runPortOperation(t.Context(), portOperation{Action: "detail", Target: target, ServerPID: os.Getpid()})
	var detail portDetail
	if result.Status != http.StatusOK || json.Unmarshal(result.Body, &detail) != nil {
		t.Fatalf("detail returned %d: %s", result.Status, result.Body)
	}
	for node := detail.Tree; ; node = node.Children[0] {
		if node == nil {
			t.Fatal("missing process tree")
		}
		if node.PID == os.Getpid() {
			if len(node.Children) != 1 || node.Children[0].PID != worker.PID {
				t.Fatal("worker missing under test process")
			}
			break
		}
		if len(node.Children) != 1 {
			t.Fatal("missing parent chain")
		}
	}

	stale := target
	stale.StartTicks++
	if result := runPortOperation(t.Context(), portOperation{Action: "stop", Target: stale}); result.Status != http.StatusConflict {
		t.Fatalf("stale stop returned %d: %s", result.Status, result.Body)
	}
	// Tests can run under a systemd service themselves. Never stop that unit.
	if detail.Unit != "" {
		t.Skip("worker belongs to the test runner's service")
	}
	if result := runPortOperation(t.Context(), portOperation{Action: "stop", Target: target}); result.Status != http.StatusNoContent {
		t.Fatalf("stop returned %d: %s", result.Status, result.Body)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not exit")
	}
	if remaining := owners(); len(remaining) != 1 || remaining[0].PID != os.Getpid() {
		t.Fatalf("expected parent to retain the listener, got %+v", remaining)
	}
}

func TestListeningWorker(t *testing.T) {
	if os.Getenv("GODESK_TEST_WORKER") != "1" {
		return
	}
	_, _ = os.Stdout.WriteString("ready\n")
	// fd 3 remains open from exec; the parent owns this subprocess.
	time.Sleep(10 * time.Second)
}
