package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"godesk/internal/privileges"

	"github.com/coder/websocket"
)

func (m *Manager) Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	routes := map[string]http.HandlerFunc{
		"GET /api/v1/terminal/sessions":              m.listHTTP,
		"POST /api/v1/terminal/sessions":             m.createHTTP,
		"PATCH /api/v1/terminal/sessions/{id}":       m.renameHTTP,
		"DELETE /api/v1/terminal/sessions/{id}":      m.endHTTP,
		"GET /api/v1/terminal/sessions/{id}/connect": m.connectHTTP,
		"GET /api/v1/terminal/sudo":                  sudoSetupHTTP,
		"GET /api/v1/settings/terminal":              m.settingsHTTP,
		"PUT /api/v1/settings/terminal":              m.updateSettingsHTTP,
	}
	for pattern, handler := range routes {
		mux.Handle(pattern, requireSession(handler))
	}
}

func sudoSetupHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	status := struct {
		SetupCommand string `json:"setupCommand,omitempty"`
	}{}
	if privileges.Probe(ctx) != nil {
		if ctx.Err() != nil {
			http.Error(w, "sudo status unavailable", http.StatusServiceUnavailable)
			return
		}
		path, err := os.Executable()
		if err != nil {
			failed(w, err)
			return
		}
		quotedPath := "'" + strings.ReplaceAll(path, "'", "'\"'\"'") + "'"
		status.SetupCommand = "sudo -u root -- " + quotedPath + " --setup-sudo"
	}
	writeJSON(w, http.StatusOK, status)
}

func (m *Manager) listHTTP(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, m.list())
}

func (m *Manager) createHTTP(w http.ResponseWriter, r *http.Request) {
	var form struct{}
	if !readJSON(w, r, &form) {
		return
	}
	settings, err := m.settings(r.Context())
	if err != nil {
		failed(w, err)
		return
	}
	summary, err := m.start(settings)
	if errors.Is(err, errShuttingDown) {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if err != nil {
		failed(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, summary)
}

func (m *Manager) renameHTTP(w http.ResponseWriter, r *http.Request) {
	var form struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &form) {
		return
	}
	name := strings.TrimSpace(form.Name)
	if name == "" {
		http.Error(w, "enter a session name", http.StatusBadRequest)
		return
	}
	if session := m.session(r.PathValue("id")); session != nil {
		if summary, ok := session.rename(name); ok {
			writeJSON(w, http.StatusOK, summary)
			return
		}
	}
	http.NotFound(w, r)
}

func (m *Manager) endHTTP(w http.ResponseWriter, r *http.Request) {
	session := m.session(r.PathValue("id"))
	if session == nil || !session.finish(true) {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (m *Manager) settingsHTTP(w http.ResponseWriter, r *http.Request) {
	settings, err := m.settings(r.Context())
	if err != nil {
		failed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (m *Manager) updateSettingsHTTP(w http.ResponseWriter, r *http.Request) {
	var form struct {
		ScrollbackLines *int32 `json:"scrollbackLines"`
	}
	if !readJSON(w, r, &form) {
		return
	}
	if form.ScrollbackLines == nil || *form.ScrollbackLines < 0 {
		http.Error(w, "provide a non-negative scrollback line count", http.StatusBadRequest)
		return
	}
	settings := Settings{ScrollbackLines: *form.ScrollbackLines}
	if err := m.saveSettings(r.Context(), settings); err != nil {
		failed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func readJSON(w http.ResponseWriter, r *http.Request, form any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(form); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func failed(w http.ResponseWriter, err error) {
	slog.Error("terminal request failed", "error", err)
	http.Error(w, "terminal unavailable", http.StatusInternalServerError)
}

func (m *Manager) connectHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()

	session := m.session(r.PathValue("id"))
	if session == nil {
		_ = ws.Close(closeEnded, "session ended")
		return
	}
	query := r.URL.Query()
	conn, initial, rejected := session.attach(query.Get("client"), query.Get("takeover") == "1")
	if rejected != 0 {
		_ = ws.Close(websocket.StatusCode(rejected), "session unavailable")
		return
	}
	defer session.detach(conn)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ws.SetReadLimit(1 << 20)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		session.readConnection(ctx, ws, conn)
	}()
	initialFrame, err := json.Marshal(initial)
	if err != nil || writeFrame(ctx, ws, websocket.MessageText, initialFrame) != nil {
		return
	}

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-conn.done:
			finishConnection(ctx, ws, conn)
			return
		default:
		}
		select {
		case <-conn.done:
			finishConnection(ctx, ws, conn)
			return
		case <-readerDone:
			// The session can end while a read is in flight.
			// Preserve its close status.
			select {
			case <-conn.done:
				finishConnection(ctx, ws, conn)
			default:
			}
			return
		case frame := <-conn.output:
			if writeTerminalFrame(ctx, ws, frame) != nil {
				return
			}
		case <-ping.C:
			pingCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			err := ws.Ping(pingCtx)
			stop()
			if err != nil {
				return
			}
		}
	}
}

func finishConnection(ctx context.Context, ws *websocket.Conn, conn *connection) {
	if conn.reason == closeEnded {
		// Deliver the final command output before reporting that the Shell ended.
		for len(conn.output) > 0 {
			if writeTerminalFrame(ctx, ws, <-conn.output) != nil {
				return
			}
		}
	}
	_ = ws.Close(websocket.StatusCode(conn.reason), "")
}

func writeTerminalFrame(ctx context.Context, ws *websocket.Conn, frame terminalFrame) error {
	if frame.event == nil {
		return writeFrame(ctx, ws, websocket.MessageBinary, frame.output)
	}
	data, err := json.Marshal(frame.event)
	if err != nil {
		return err
	}
	return writeFrame(ctx, ws, websocket.MessageText, data)
}

func writeFrame(ctx context.Context, ws *websocket.Conn, kind websocket.MessageType, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return ws.Write(ctx, kind, data)
}

func (s *session) readConnection(ctx context.Context, ws *websocket.Conn, conn *connection) {
	for {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if kind == websocket.MessageBinary {
			if err := s.input(ctx, conn, data); err != nil {
				return
			}
			continue
		}
		var message struct {
			Type string `json:"type"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(data, &message) != nil {
			continue
		}
		switch message.Type {
		case "resize":
			s.resize(conn, message.Cols, message.Rows)
		case "takeover":
			s.takeControl(conn)
		}
	}
}
