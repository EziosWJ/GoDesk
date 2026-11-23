package monitor

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (c *Collector) Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/system/metrics", requireSession(http.HandlerFunc(c.metricsHTTP)))
	mux.Handle("GET /api/v1/system/ports", requireSession(http.HandlerFunc(c.portsHTTP)))
}

func (c *Collector) metricsHTTP(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := c.Snapshot()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "metrics_unavailable", "系统指标尚未就绪")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (c *Collector) portsHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	ports, err := ListPorts(ctx)
	if err != nil {
		slog.Error("read listening ports", "error", err)
		writeError(w, http.StatusInternalServerError, "ports_unavailable", "无法读取端口信息")
		return
	}
	writeJSON(w, http.StatusOK, ports)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Code: code, Message: message})
}
