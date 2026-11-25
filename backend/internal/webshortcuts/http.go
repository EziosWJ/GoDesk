package webshortcuts

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
)

func Register(mux *http.ServeMux, db *sql.DB, requireSession func(http.Handler) http.Handler) {
	h := handler{db: db}
	const path = "/api/v1/web-shortcuts"
	mux.Handle("GET "+path, requireSession(http.HandlerFunc(h.list)))
	mux.Handle("POST "+path, requireSession(http.HandlerFunc(h.create)))
	mux.Handle("PUT "+path+"/{id}", requireSession(http.HandlerFunc(h.update)))
	mux.Handle("DELETE "+path+"/{id}", requireSession(http.HandlerFunc(h.delete)))
	mux.Handle("GET "+path+"/{id}/open", requireSession(http.HandlerFunc(h.open)))
}

func (h handler) list(w http.ResponseWriter, r *http.Request) {
	shortcuts, err := h.shortcuts(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, shortcuts)
}

func (h handler) create(w http.ResponseWriter, r *http.Request) {
	form, ok := readForm(w, r)
	if !ok {
		return
	}
	item, err := h.insert(r.Context(), form)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (h handler) update(w http.ResponseWriter, r *http.Request) {
	id, ok := readID(w, r)
	if !ok {
		return
	}
	form, ok := readForm(w, r)
	if !ok {
		return
	}
	item, err := h.replace(r.Context(), id, form)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h handler) delete(w http.ResponseWriter, r *http.Request) {
	id, ok := readID(w, r)
	if !ok {
		return
	}
	if err := h.remove(r.Context(), id); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h handler) open(w http.ResponseWriter, r *http.Request) {
	id, ok := readID(w, r)
	if !ok {
		return
	}
	target, err := h.destination(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusFound)
}

func readID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		http.NotFound(w, r)
		return 0, false
	}
	return id, true
}

func readForm(w http.ResponseWriter, r *http.Request) (shortcutForm, bool) {
	var form shortcutForm
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "请求格式应为 JSON", http.StatusUnsupportedMediaType)
		return form, false
	}
	body := http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(body).Decode(&form); err != nil {
		http.Error(w, "无效的快捷方式配置", http.StatusBadRequest)
		return form, false
	}
	if err := form.validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return form, false
	}
	return form, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "网页快捷方式不存在", http.StatusNotFound)
	case errors.Is(err, errMissingSecret):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		slog.Error("web shortcut request failed", "error", err)
		http.Error(w, "无法处理网页快捷方式", http.StatusInternalServerError)
	}
}
