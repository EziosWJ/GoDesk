package terminal

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

const (
	initialCols = 80
	initialRows = 24
	maxSize     = 1000
)

var errShuttingDown = errors.New("terminal manager is shutting down")

type Summary struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	CreatedAt          time.Time  `json:"createdAt"`
	LastAttachedAt     *time.Time `json:"lastAttachedAt"`
	Attached           bool       `json:"attached"`
	ControllerClientID *string    `json:"controllerClientId"`
	ScrollbackLines    int32      `json:"scrollbackLines"`
}

type Manager struct {
	db       *sql.DB
	mu       sync.Mutex
	sessions map[string]*session
	next     int
	closed   bool
	workers  sync.WaitGroup
}

type session struct {
	mu          sync.Mutex
	summary     Summary
	cmd         *exec.Cmd
	pty         *os.File
	control     syscall.RawConn
	display     *display
	ended       bool
	connections map[string]*connection
	controller  *connection
}

type connection struct {
	clientID string
	output   chan terminalFrame
	done     chan struct{}
	reason   int
}

type terminalFrame struct {
	output []byte
	event  any
}

type controlEvent struct {
	Type       string `json:"type"`
	Controller bool   `json:"controller"`
}

type resizeEvent struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

const (
	closeEnded   = 4404
	closeRetry   = 1013
	closeReplace = 1000
)

func (c *connection) close(reason int) {
	c.reason = reason
	close(c.done)
}

func (m *Manager) list() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()

	list := make([]Summary, 0, len(m.sessions))
	for _, s := range m.sessions {
		s.mu.Lock()
		if !s.ended {
			list = append(list, s.summaryLocked())
		}
		s.mu.Unlock()
	}
	slices.SortFunc(list, func(a, b Summary) int {
		return a.CreatedAt.Compare(b.CreatedAt)
	})
	return list
}

func (m *Manager) session(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *Manager) start(settings Settings) (Summary, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Summary{}, errShuttingDown
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-i")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	if home, err := os.UserHomeDir(); err == nil {
		if info, err := os.Stat(home); err == nil && info.IsDir() {
			cmd.Dir = home
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: initialCols, Rows: initialRows})
	if err != nil {
		return Summary{}, err
	}
	file, control, err := pollablePTY(master)
	_ = master.Close()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return Summary{}, err
	}

	m.next++
	summary := Summary{
		ID: rand.Text(), Name: fmt.Sprintf("终端 %d", m.next),
		CreatedAt: time.Now().UTC(), ScrollbackLines: settings.ScrollbackLines,
	}
	s := &session{summary: summary, cmd: cmd, pty: file, control: control, connections: make(map[string]*connection)}
	s.display = newDisplay(int(settings.ScrollbackLines), s.reply)
	m.sessions[summary.ID] = s
	m.workers.Go(func() { m.run(s) })
	return summary, nil
}

// pty.StartWithSize uses an ioctl on the original descriptor. Open a pollable
// descriptor for the same master so Close can interrupt a pending Read.
func pollablePTY(master *os.File) (*os.File, syscall.RawConn, error) {
	fd, err := unix.FcntlInt(master.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), master.Name())
	control, err := file.SyscallConn()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	return file, control, nil
}

func (m *Manager) run(s *session) {
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		s.readOutput()
	}()
	_ = s.cmd.Wait()
	// A descendant may still hold the slave open after the Shell has exited.
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-outputDone:
	case <-timer.C:
		_ = s.pty.Close()
		<-outputDone
	}

	s.finish(false)
	m.mu.Lock()
	delete(m.sessions, s.summary.ID)
	m.mu.Unlock()
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	for _, s := range m.sessions {
		s.finish(true)
	}
	m.mu.Unlock()
	m.workers.Wait()
}

func (s *session) finish(kill bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return false
	}
	s.ended = true
	if kill {
		_ = unix.Kill(-s.cmd.Process.Pid, unix.SIGKILL)
	}
	_ = s.pty.Close()
	s.display.close()
	s.display = nil
	for _, conn := range s.connections {
		conn.close(closeEnded)
	}
	clear(s.connections)
	s.controller = nil
	return true
}

func (s *session) rename(name string) (Summary, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return Summary{}, false
	}
	s.summary.Name = name
	return s.summaryLocked(), true
}

func (s *session) summaryLocked() Summary {
	summary := s.summary
	summary.Attached = len(s.connections) > 0
	if s.controller != nil {
		summary.ControllerClientID = &s.controller.clientID
	}
	return summary
}

func (s *session) attach(clientID string, takeover bool) (*connection, snapshot, int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ended {
		return nil, snapshot{}, closeEnded
	}
	if clientID == "" {
		clientID = rand.Text()
	}
	previous := s.connections[clientID]
	controls := len(s.connections) == 0 || (previous != nil && previous == s.controller) || takeover
	if previous != nil {
		s.removeConnection(previous)
		previous.close(closeReplace)
	}
	conn := &connection{clientID: clientID, output: make(chan terminalFrame, 64), done: make(chan struct{})}
	s.connections[clientID] = conn
	if controls {
		s.setController(conn, false)
	}
	now := time.Now().UTC()
	s.summary.LastAttachedAt = &now
	initial := s.display.snapshot()
	initial.Controller = controls
	return conn, initial, 0
}

func (s *session) detach(conn *connection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeConnection(conn)
}

func (s *session) removeConnection(conn *connection) {
	if s.connections[conn.clientID] != conn {
		return
	}
	delete(s.connections, conn.clientID)
	if s.controller == conn {
		s.controller = nil
	}
}

func (s *session) takeControl(conn *connection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections[conn.clientID] == conn {
		s.setController(conn, true)
	}
}

func (s *session) setController(conn *connection, notify bool) {
	previous := s.controller
	if previous == conn {
		return
	}
	s.controller = conn
	if previous != nil {
		s.deliver(previous, terminalFrame{event: controlEvent{Type: "control", Controller: false}})
	}
	if notify {
		s.deliver(conn, terminalFrame{event: controlEvent{Type: "control", Controller: true}})
	}
}

func (s *session) deliver(conn *connection, frame terminalFrame) {
	select {
	case conn.output <- frame:
	default:
		s.removeConnection(conn)
		conn.close(closeRetry)
	}
}

func (s *session) readOutput() {
	buf := make([]byte, 8192)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			s.recordOutput(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (s *session) recordOutput(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return
	}
	s.display.write(data, s.controller == nil)
	if len(s.connections) > 0 {
		frame := terminalFrame{output: slices.Clone(data)}
		for _, conn := range s.connections {
			s.deliver(conn, frame)
		}
	}
}

// Terminal replies are short. A nonblocking write keeps the emulator's
// reply reader independent of PTY output and session state.
func (s *session) reply(data []byte) {
	_, _ = s.writePTY(data)
}

func (s *session) writePTY(data []byte) (n int, err error) {
	controlErr := s.control.Control(func(fd uintptr) {
		n, err = unix.Write(int(fd), data)
	})
	if controlErr != nil {
		return 0, controlErr
	}
	return n, err
}

func (s *session) input(ctx context.Context, conn *connection, data []byte) error {
	for len(data) > 0 {
		s.mu.Lock()
		if s.connections[conn.clientID] != conn {
			s.mu.Unlock()
			return io.ErrClosedPipe
		}
		if s.controller != conn {
			s.mu.Unlock()
			return nil
		}
		n, err := s.writePTY(data)
		s.mu.Unlock()
		if n > 0 {
			data = data[n:]
		}
		if err == nil || errors.Is(err, unix.EINTR) {
			continue
		}
		if !errors.Is(err, unix.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-conn.done:
			return io.ErrClosedPipe
		case <-time.After(5 * time.Millisecond):
		}
	}
	return nil
}

func (s *session) resize(conn *connection, cols, rows int) {
	if cols < 2 || rows < 1 || cols > maxSize || rows > maxSize {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.controller != conn || (cols == s.display.Width() && rows == s.display.Height()) {
		return
	}
	var resizeErr error
	if err := s.control.Control(func(fd uintptr) {
		resizeErr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Col: uint16(cols), Row: uint16(rows)})
	}); err == nil && resizeErr == nil {
		s.display.resize(cols, rows)
		frame := terminalFrame{event: resizeEvent{Type: "resize", Cols: cols, Rows: rows}}
		for _, viewer := range s.connections {
			s.deliver(viewer, frame)
		}
	}
}
