package terminal

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestSessionSurvivesDetachAndSharesOutputAcrossTakeover(t *testing.T) {
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
	summary, err := manager.start(defaults, "")
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
	if reason != 0 || !initial.Controller || !strings.Contains(initial.Output, "detached-marker") {
		t.Fatalf("resume did not restore control and output: %d, %+v", reason, initial)
	}
	second, initial, reason := session.attach("second", false)
	if reason != 0 || initial.Controller {
		t.Fatalf("second window should attach as a viewer: %d, %+v", reason, initial)
	}

	replacement, initial, reason := session.attach("first", false)
	if reason != 0 || !initial.Controller {
		t.Fatalf("same-window reconnect lost control: %d, %+v", reason, initial)
	}
	select {
	case <-first.done:
		if first.reason != closeReplace {
			t.Fatalf("old connection closed with %d", first.reason)
		}
	default:
		t.Fatal("old connection was not replaced")
	}
	session.detach(first)
	first = replacement
	session.resize(second, 45, 12)
	session.mu.Lock()
	cols, rows := session.display.Width(), session.display.Height()
	session.mu.Unlock()
	if cols != initial.Cols || rows != initial.Rows {
		t.Fatalf("viewer resized the session to %dx%d", cols, rows)
	}
	session.resize(first, 90, 31)
	wantResize := resizeEvent{Type: "resize", Cols: 90, Rows: 31}
	readEvent(t, first, wantResize)
	readEvent(t, second, wantResize)
	if err := session.input(t.Context(), first, []byte("echo shared-marker\r")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, first, "shared-marker")
	readUntil(t, second, "shared-marker")

	session.takeControl(second)
	readEvent(t, first, controlEvent{Type: "control", Controller: false})
	readEvent(t, second, controlEvent{Type: "control", Controller: true})
	active := manager.list()[0]
	if !active.Attached || active.ControllerClientID == nil || *active.ControllerClientID != "second" {
		t.Fatalf("list did not report new controller: %+v", active)
	}
	if err := session.input(t.Context(), first, []byte("exit\r")); err != nil {
		t.Fatalf("viewer input should be ignored without closing the connection: %v", err)
	}

	session.detach(second)
	active = manager.list()[0]
	if !active.Attached || active.ControllerClientID != nil {
		t.Fatalf("disconnect promoted a viewer: %+v", active)
	}
	second, initial, reason = session.attach("second", false)
	if reason != 0 || initial.Controller {
		t.Fatalf("reconnecting window should be read only with viewers present: %d, %+v", reason, initial)
	}
	session.takeControl(first)
	readEvent(t, first, controlEvent{Type: "control", Controller: true})
	if err := session.input(t.Context(), first, []byte("echo final-marker; exit\r")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, first, "final-marker")
	readUntil(t, second, "final-marker")
	for _, conn := range []*connection{first, second} {
		select {
		case <-conn.done:
			if conn.reason != closeEnded || len(manager.list()) != 0 {
				t.Fatal("exited Shell was not removed from active sessions")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("Shell exit did not end the session for all connections")
		}
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
			output.Write(chunk.output)
			if strings.Contains(output.String(), expected) {
				return
			}
		case <-deadline.C:
			t.Fatalf("did not receive %q: %q", expected, output.String())
		}
	}
}

func readEvent(t *testing.T, conn *connection, expected any) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case frame := <-conn.output:
			if frame.event != nil {
				if frame.event != expected {
					t.Fatalf("received event %#v, want %#v", frame.event, expected)
				}
				return
			}
		case <-deadline.C:
			t.Fatalf("did not receive event %#v", expected)
		}
	}
}
