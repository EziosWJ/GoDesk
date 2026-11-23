package terminal

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestSessionSurvivesDetachAndRestrictsInputAfterTakeover(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	manager, err := Open(t.Context(), db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)

	defaults, err := manager.settings(t.Context())
	if err != nil || defaults.ScrollbackLines != 5000 {
		t.Fatalf("defaults = %v, %v", defaults, err)
	}
	summary, err := manager.start(defaults)
	if err != nil {
		t.Fatal(err)
	}
	session := manager.session(summary.ID)
	first, _, reason := session.attach("first", false)
	if reason != 0 {
		t.Fatalf("initial attach rejected: %d", reason)
	}

	command := "stty -echo; printf '%s\\n' 'ready-'marker; sleep 0.1; printf '%s\\n' 'detached-'marker\r"
	if err := session.input(t.Context(), first, []byte(command)); err != nil {
		t.Fatal(err)
	}
	readUntil(t, first, "ready-marker")
	session.detach(first)

	deadline := time.Now().Add(3 * time.Second)
	var output string
	for time.Now().Before(deadline) {
		session.mu.Lock()
		output = session.display.snapshot().Output
		session.mu.Unlock()
		if strings.Contains(output, "detached-marker") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(output, "detached-marker") {
		t.Fatalf("detached output is missing: %q", output)
	}

	first, initial, reason := session.attach("first", false)
	if reason != 0 || !strings.Contains(initial.Output, "detached-marker") {
		t.Fatalf("resume rejected or missing output: %d, %q", reason, initial.Output)
	}
	if _, _, reason := session.attach("second", false); reason != closeBusy {
		t.Fatalf("competing connection = %d, want %d", reason, closeBusy)
	}
	second, _, reason := session.attach("second", true)
	if reason != 0 {
		t.Fatalf("takeover rejected: %d", reason)
	}
	<-first.done
	if first.reason != closeBusy {
		t.Fatalf("first connection closed with %d", first.reason)
	}
	if err := session.input(t.Context(), first, []byte("exit\r")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("revoked connection input: %v", err)
	}
	if err := session.input(t.Context(), second, []byte("echo final-marker; exit\r")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, second, "final-marker")
	select {
	case <-second.done:
		if second.reason != closeEnded || len(manager.list()) != 0 {
			t.Fatal("exited Shell was not removed from active sessions")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Shell exit did not end the session")
	}
}

func TestSnapshotKeepsCurrentScreenAndConfiguredHistory(t *testing.T) {
	display := newDisplay(2, func([]byte) {})
	defer display.close()
	for line := 1; line <= initialRows+5; line++ {
		display.write(fmt.Appendf(nil, "output-%02d\r\n", line), true)
	}
	output := display.snapshot().Output
	for _, line := range []string{"output-05", "output-06", "output-29"} {
		if !strings.Contains(output, line) {
			t.Errorf("snapshot is missing %s", line)
		}
	}
	if strings.Contains(output, "output-04") {
		t.Error("snapshot kept more than two scrollback rows")
	}
	display.resize(initialCols, initialRows-5)
	output = display.snapshot().Output
	if !strings.Contains(output, "output-29") {
		t.Error("shrinking the terminal dropped its last line")
	}
	if display.ScrollbackLen() != 2 {
		t.Error("shrinking the terminal exceeded its scrollback limit")
	}
}

func TestSnapshotRestoresAlternateAndNormalScreens(t *testing.T) {
	display := newDisplay(10, func([]byte) {})
	defer display.close()
	display.write([]byte("normal\x1b[?1049h\x1b[2J\x1b[Halternate\x1b[4;5H"), true)
	initial := display.snapshot()
	normal := strings.Index(initial.Output, "normal")
	alternateMode := strings.Index(initial.Output, "\x1b[?1049h")
	alternate := strings.Index(initial.Output, "alternate")
	if normal < 0 || alternateMode < normal || alternate < alternateMode {
		t.Fatalf("snapshot did not preserve both screens in order: %q", initial.Output)
	}
	if !strings.Contains(initial.Output[alternate:], "\x1b[4;5H") {
		t.Fatalf("alternate screen cursor was not restored: %q", initial.Output)
	}
}

func TestSnapshotKeepsWideHistoryAfterResize(t *testing.T) {
	display := newDisplay(2, func([]byte) {})
	defer display.close()
	line := strings.Repeat("x", 40) + "end-of-wide-row"
	display.write([]byte(line+strings.Repeat("\r\n", initialRows)), true)
	display.resize(20, initialRows)
	if !strings.Contains(display.snapshot().Output, "end-of-wide-row") {
		t.Fatal("narrowing the terminal dropped content from retained history")
	}
}

func readUntil(t *testing.T, conn *connection, expected string) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	var output strings.Builder
	for {
		select {
		case chunk := <-conn.output:
			output.Write(chunk)
			if strings.Contains(output.String(), expected) {
				return
			}
		case <-deadline.C:
			t.Fatalf("did not receive %q: %q", expected, output.String())
		}
	}
}
