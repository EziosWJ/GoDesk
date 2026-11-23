package services

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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

type handler struct {
	backend       Backend
	listTimeout   time.Duration
	actionTimeout time.Duration
	logsTimeout   time.Duration
}

// Register mounts the service management HTTP routes behind requireSession.
func Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler, backend Backend) {
	h := &handler{
		backend:       backend,
		listTimeout:   5 * time.Second,
		actionTimeout: 120 * time.Second,
		logsTimeout:   10 * time.Second,
	}
	mux.Handle("GET /api/v1/services", requireSession(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/services/{unit}/{action}", requireSession(http.HandlerFunc(h.action)))
	mux.Handle("GET /api/v1/services/{unit}/logs", requireSession(http.HandlerFunc(h.logs)))
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
		case "logs_unavailable", "action_not_allowed":
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

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Code: code, Message: message})
}
