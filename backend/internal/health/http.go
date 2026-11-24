package health

import (
	"encoding/json"
	"net/http"
)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Engine) Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/system/status", requireSession(http.HandlerFunc(e.statusHTTP)))
}

func (e *Engine) statusHTTP(w http.ResponseWriter, _ *http.Request) {
	snapshot, ok := e.Snapshot()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "health_unavailable", "健康状态尚未就绪")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
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
