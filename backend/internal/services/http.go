package services

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type listResponse struct {
	Backend      string       `json:"backend"`
	Capabilities Capabilities `json:"capabilities"`
	Services     []Service    `json:"services"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

const (
	// defaultSSEWriteTimeout bounds a single SSE write and flush so a stalled
	// client cannot block the log stream handler forever.
	defaultSSEWriteTimeout = 15 * time.Second
)

type handler struct {
	backend         Backend
	listTimeout     time.Duration
	detailTimeout   time.Duration
	actionTimeout   time.Duration
	logsTimeout     time.Duration
	sseWriteTimeout time.Duration
}

// Register mounts the service management HTTP routes behind requireSession.
func Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler, backend Backend) {
	h := &handler{
		backend:         backend,
		listTimeout:     5 * time.Second,
		detailTimeout:   10 * time.Second,
		actionTimeout:   120 * time.Second,
		logsTimeout:     10 * time.Second,
		sseWriteTimeout: defaultSSEWriteTimeout,
	}
	h.register(mux, requireSession)
}

func (h *handler) register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/services", requireSession(http.HandlerFunc(h.list)))
	mux.Handle("GET /api/v1/services/{unit}", requireSession(http.HandlerFunc(h.detail)))
	mux.Handle("POST /api/v1/services/daemon-reload", requireSession(http.HandlerFunc(h.daemonReload)))
	mux.Handle("POST /api/v1/services/{unit}/{action}", requireSession(http.HandlerFunc(h.action)))
	mux.Handle("GET /api/v1/services/{unit}/logs", requireSession(http.HandlerFunc(h.logs)))
	mux.Handle("GET /api/v1/services/{unit}/logs/stream", requireSession(http.HandlerFunc(h.streamLogs)))
}

func (h *handler) sseTimeout() time.Duration {
	if h.sseWriteTimeout <= 0 {
		return defaultSSEWriteTimeout
	}
	return h.sseWriteTimeout
}

func (h *handler) list(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), h.listTimeout)
	defer cancel()
	services, err := h.backend.List(ctx)
	if err != nil {
		failed(w, err)
		return
	}
	if services == nil {
		services = []Service{}
	}
	writeJSON(w, http.StatusOK, listResponse{
		Backend:      h.backend.Name(),
		Capabilities: h.backend.Capabilities(),
		Services:     services,
	})
}

func (h *handler) detail(w http.ResponseWriter, r *http.Request) {
	unit := r.PathValue("unit")
	if !ValidUnit(unit) {
		writeError(w, http.StatusBadRequest, "invalid_unit", "服务单元名无效")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.detailTimeout)
	defer cancel()
	detail, err := h.backend.Detail(ctx, unit)
	if err != nil {
		failed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (h *handler) action(w http.ResponseWriter, r *http.Request) {
	unit := r.PathValue("unit")
	action := Action(r.PathValue("action"))
	if !ValidUnit(unit) {
		writeError(w, http.StatusBadRequest, "invalid_unit", "服务单元名无效")
		return
	}
	if !validAction(action) {
		writeError(w, http.StatusBadRequest, "invalid_action", "服务动作无效")
		return
	}
	service, ok, err := h.find(r.Context(), unit)
	if err != nil {
		failed(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "服务不存在")
		return
	}
	if !containsAction(service.Actions, action) {
		writeError(w, http.StatusConflict, "action_not_allowed", "当前状态不允许该动作")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.actionTimeout)
	defer cancel()
	switch action {
	case ActionStart:
		err = h.backend.Start(ctx, unit)
	case ActionStop:
		err = h.backend.Stop(ctx, unit)
	case ActionRestart:
		err = h.backend.Restart(ctx, unit)
	case ActionReload:
		err = h.backend.Reload(ctx, unit)
	case ActionEnable:
		err = h.backend.Enable(ctx, unit)
	case ActionDisable:
		err = h.backend.Disable(ctx, unit)
	}
	if err != nil {
		failed(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) logs(w http.ResponseWriter, r *http.Request) {
	unit := r.PathValue("unit")
	if !ValidUnit(unit) {
		writeError(w, http.StatusBadRequest, "invalid_unit", "服务单元名无效")
		return
	}
	lines := 200
	if raw := r.URL.Query().Get("lines"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 1000 {
			writeError(w, http.StatusBadRequest, "invalid_lines", "日志行数必须在 1 到 1000 之间")
			return
		}
		lines = value
	}
	if _, ok, err := h.find(r.Context(), unit); err != nil {
		failed(w, err)
		return
	} else if !ok {
		writeError(w, http.StatusNotFound, "not_found", "服务不存在")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.logsTimeout)
	defer cancel()
	entries, err := h.backend.Logs(ctx, unit, lines)
	if err != nil {
		failed(w, err)
		return
	}
	if entries == nil {
		entries = []string{}
	}
	writeJSON(w, http.StatusOK, map[string][]string{"lines": entries})
}

// daemonReload asks systemd to re-read unit files. It is a backend-wide
// operation, so it has no unit path parameter.
func (h *handler) daemonReload(w http.ResponseWriter, r *http.Request) {
	if !h.backend.Capabilities().DaemonReload {
		writeError(w, http.StatusConflict, "unsupported", "当前服务后端不支持重新加载 systemd 配置")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.actionTimeout)
	defer cancel()
	if err := h.backend.DaemonReload(ctx); err != nil {
		failed(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// streamLogs follows journal output over Server-Sent Events.
//
// The SSE response is committed as soon as the request is validated because a
// service with no historical lines leaves `journalctl -f` silent until new
// output arrives; clients must see an open stream immediately instead of a
// hung HTTP request. Every log line is therefore an unnamed (message) event:
//
//	data: {"line":"..."}
//
// and failures after the stream is open are reported in-band as:
//
//	event: error
//	data: {"code":"permission","message":"..."}
//
// A leading `: connected` comment opens the stream before the first line.
func (h *handler) streamLogs(w http.ResponseWriter, r *http.Request) {
	unit := r.PathValue("unit")
	if !ValidUnit(unit) {
		writeError(w, http.StatusBadRequest, "invalid_unit", "服务单元名无效")
		return
	}
	lines := 200
	if raw := r.URL.Query().Get("lines"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 || value > 1000 {
			writeError(w, http.StatusBadRequest, "invalid_lines", "日志行数必须在 0 到 1000 之间")
			return
		}
		lines = value
	}
	if _, ok, err := h.find(r.Context(), unit); err != nil {
		failed(w, err)
		return
	} else if !ok {
		writeError(w, http.StatusNotFound, "not_found", "服务不存在")
		return
	}
	if !h.backend.Capabilities().Logs {
		writeError(w, http.StatusConflict, "logs_unavailable", "journal 日志不可用")
		return
	}

	rc := http.NewResponseController(w)
	// Long-lived streams must not inherit http.Server.WriteTimeout. Every
	// individual write below sets its own bounded deadline instead.
	if err := rc.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		slog.Warn("cannot clear service log stream write deadline", "error", err)
	}
	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	headers.Set("Cache-Control", "no-store")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	timeout := h.sseTimeout()
	if err := writeSSEChunk(w, rc, ": connected\n\n", timeout); err != nil {
		return
	}

	err := h.backend.StreamLogs(r.Context(), unit, lines, func(line string) error {
		return writeSSE(w, rc, "", streamLine{Line: line}, timeout)
	})
	if err == nil || r.Context().Err() != nil {
		return
	}
	// Headers are already committed, so the failure can only go in-band.
	_ = writeSSE(w, rc, "error", streamError(err), timeout)
}

func (h *handler) find(parent context.Context, unit string) (Service, bool, error) {
	ctx, cancel := context.WithTimeout(parent, h.listTimeout)
	defer cancel()
	list, err := h.backend.List(ctx)
	if err != nil {
		return Service{}, false, err
	}
	for _, service := range list {
		if service.Name == unit {
			return service, true, nil
		}
	}
	return Service{}, false, nil
}

func failed(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		writeError(w, http.StatusGatewayTimeout, "timeout", "操作超时")
		return
	}
	var serviceErr *Error
	if errors.As(err, &serviceErr) {
		switch serviceErr.Code {
		case "permission":
			writeError(w, http.StatusForbidden, serviceErr.Code, serviceErr.Message)
		case "not_found":
			writeError(w, http.StatusNotFound, serviceErr.Code, serviceErr.Message)
		case "logs_unavailable", "action_not_allowed", "unsupported":
			writeError(w, http.StatusConflict, serviceErr.Code, serviceErr.Message)
		default:
			slog.Error("service request failed", "error", err)
			writeError(w, http.StatusUnprocessableEntity, "operation_failed", serviceErr.Message)
		}
		return
	}
	slog.Error("service request failed", "error", err)
	writeError(w, http.StatusUnprocessableEntity, "operation_failed", err.Error())
}

// streamLine is one SSE message event payload. JSON encoding keeps newlines
// and other control characters out of the event framing.
type streamLine struct {
	Line string `json:"line"`
}

// streamError maps a backend failure to the in-band SSE error payload.
func streamError(err error) errorBody {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return errorBody{Code: "timeout", Message: "操作超时"}
	}
	var serviceErr *Error
	if errors.As(err, &serviceErr) {
		return errorBody{Code: serviceErr.Code, Message: serviceErr.Message}
	}
	return errorBody{Code: "operation_failed", Message: err.Error()}
}

// writeSSE serializes one event and flushes it to the client. An empty event
// name produces a default ("message") event.
func writeSSE(w http.ResponseWriter, rc *http.ResponseController, event string, value any, timeout time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var builder strings.Builder
	if event != "" {
		builder.WriteString("event: ")
		builder.WriteString(event)
		builder.WriteByte('\n')
	}
	builder.WriteString("data: ")
	builder.Write(data)
	builder.WriteString("\n\n")
	return writeSSEChunk(w, rc, builder.String(), timeout)
}

// writeSSEChunk writes one pre-framed SSE chunk under a bounded write
// deadline. The deadline is cleared afterwards so an idle stream waiting for
// the next journal line is not torn down by an expired deadline.
func writeSSEChunk(w http.ResponseWriter, rc *http.ResponseController, payload string, timeout time.Duration) error {
	if err := rc.SetWriteDeadline(time.Now().Add(timeout)); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		slog.Warn("cannot set service log stream write deadline", "error", err)
	}
	_, writeErr := io.WriteString(w, payload)
	if writeErr == nil {
		writeErr = rc.Flush()
	}
	if err := rc.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		slog.Warn("cannot clear service log stream write deadline", "error", err)
	}
	return writeErr
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Code: code, Message: message})
}
