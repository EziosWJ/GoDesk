package monitor

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"time"
)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (c *Collector) Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	c.register(mux, requireSession, executePortOperation, executeProcessSignal)
}

func (c *Collector) register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler, execute portExecutor, signal processSignalExecutor) {
	mux.Handle("GET /api/v1/system/metrics", requireSession(http.HandlerFunc(c.metricsHTTP)))
	mux.Handle("GET /api/v1/system/processes", requireSession(http.HandlerFunc(c.processListHTTP)))
	mux.Handle("GET /api/v1/system/processes/{pid}", requireSession(http.HandlerFunc(c.processDetailHTTP)))
	mux.Handle("POST /api/v1/system/processes/signal", requireSession(processSignalHTTP(signal)))
	mux.Handle("GET /api/v1/system/ports", requireSession(portHandler(execute, "list", 5*time.Second)))
	mux.Handle("GET /api/v1/system/ports/detail", requireSession(portHandler(execute, "detail", 10*time.Second)))
	mux.Handle("GET /api/v1/system/ports/logs", requireSession(portHandler(execute, "logs", 10*time.Second)))
	mux.Handle("POST /api/v1/system/ports/stop", requireSession(portHandler(execute, "stop", 120*time.Second)))
}

func (c *Collector) metricsHTTP(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := c.Snapshot()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "metrics_unavailable", "系统指标尚未就绪")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func portHandler(execute portExecutor, action string, timeout time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		operation := portOperation{Action: action, ServerPID: os.Getpid()}
		switch action {
		case "detail", "logs":
			query := r.URL.Query()
			port, _ := strconv.ParseUint(query.Get("port"), 10, 16)
			pid, _ := strconv.Atoi(query.Get("pid"))
			start, err := strconv.ParseUint(query.Get("startTicks"), 10, 64)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_target", "进程参数无效")
				return
			}
			operation.Target = portTarget{
				Endpoint: Endpoint{Protocol: query.Get("protocol"), Address: query.Get("address"), Port: uint32(port)},
				PID:      pid, StartTicks: start, Unit: query.Get("unit"),
			}
		case "stop":
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "invalid_content_type", "需要 application/json 请求")
				return
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
			if decoder.Decode(&operation.Target) != nil || decoder.Decode(new(any)) != io.EOF {
				writeError(w, http.StatusBadRequest, "invalid_target", "进程参数无效")
				return
			}
		}
		if action != "list" && !operation.Target.valid() {
			writeError(w, http.StatusBadRequest, "invalid_target", "端口或进程参数无效")
			return
		}
		parent := r.Context()
		if action == "stop" {
			parent = context.WithoutCancel(parent)
		}
		ctx, cancel := context.WithTimeout(parent, timeout)
		defer cancel()
		result := execute(ctx, operation)
		w.Header().Set("Cache-Control", "no-store")
		if result.Status == http.StatusNoContent {
			w.WriteHeader(result.Status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(result.Status)
		_, _ = w.Write(result.Body)
	}
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
