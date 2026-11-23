package files

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"sync"
)

type server struct {
	mutations sync.Mutex
}

func Register(mux *http.ServeMux) {
	s := &server{}
	mux.HandleFunc("GET /directory", directory)
	mux.HandleFunc("POST /action", s.action)
	mux.HandleFunc("POST /upload", s.upload)
	mux.HandleFunc("GET /download", download)
	mux.HandleFunc("GET /text", getText)
	mux.HandleFunc("PUT /text", s.putText)
}

func jsonResponse(w http.ResponseWriter, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func failure(w http.ResponseWriter, err error) {
	status, code := http.StatusUnprocessableEntity, "operation_failed"
	var path string
	var cleanup *cleanupError
	var maxBytes *http.MaxBytesError
	switch {
	case errors.As(err, &cleanup):
		code, path = "source_cleanup_failed", cleanup.path
	case errors.Is(err, errPath):
		status, code = http.StatusBadRequest, "invalid_request"
	case errors.Is(err, errType), errors.Is(err, errEncoding):
		status, code = http.StatusUnsupportedMediaType, "unsupported_type"
	case errors.Is(err, errSize), errors.As(err, &maxBytes):
		status, code = http.StatusRequestEntityTooLarge, "text_too_large"
	case errors.Is(err, errChanged):
		status, code = http.StatusConflict, "changed"
	case errors.Is(err, fs.ErrExist):
		status, code = http.StatusConflict, "exists"
	case errors.Is(err, fs.ErrNotExist):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, fs.ErrPermission):
		status, code = http.StatusForbidden, "permission"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Path    string `json:"path,omitempty"`
	}{code, err.Error(), path})
}

func directory(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		account, err := user.Current()
		if err != nil {
			failure(w, err)
			return
		}
		home = account.HomeDir
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = home
	}
	path, err = pathOf(path)
	if err != nil {
		failure(w, err)
		return
	}
	items, err := list(path)
	if err != nil {
		failure(w, err)
		return
	}
	jsonResponse(w, struct {
		Path    string  `json:"path"`
		Home    string  `json:"home"`
		Entries []entry `json:"entries"`
	}{path, home, items})
}

func readJSON(w http.ResponseWriter, r *http.Request, data any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		failure(w, errType)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(data); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			failure(w, err)
		} else {
			failure(w, errPath)
		}
		return false
	}
	return true
}

func (s *server) action(w http.ResponseWriter, r *http.Request) {
	var form struct {
		Operation, Path, Destination, Name, Conflict string
	}
	if !readJSON(w, r, &form) {
		return
	}
	path, err := pathOf(form.Path)
	if err != nil {
		failure(w, err)
		return
	}
	if path == "/" && form.Operation != "mkdir" {
		failure(w, errPath)
		return
	}
	s.mutations.Lock()
	defer s.mutations.Unlock()

	outcome := result{Path: path}
	switch form.Operation {
	case "mkdir":
		if !validName(form.Name) {
			err = errPath
			break
		}
		outcome.Path = filepath.Join(path, form.Name)
		err = os.Mkdir(outcome.Path, 0777)
	case "rename", "delete":
		var info fs.FileInfo
		info, err = os.Lstat(path)
		if err != nil {
			break
		}
		switch fileKind(info.Mode()) {
		case "directory", "file", "symlink":
		default:
			err = errType
		}
		if err != nil {
			break
		}
		if form.Operation == "delete" {
			err = os.RemoveAll(path)
		} else if !validName(form.Name) {
			err = errPath
		} else {
			outcome.Path = filepath.Join(filepath.Dir(path), form.Name)
			if outcome.Path != path {
				err = renameExclusive(path, outcome.Path)
			}
		}
	case "copy", "move":
		var destination string
		destination, err = pathOf(form.Destination)
		if err == nil {
			outcome, err = transfer(r.Context(), path, destination, form.Conflict, form.Operation == "move")
		}
	default:
		err = errPath
	}
	if err != nil {
		failure(w, err)
		return
	}
	jsonResponse(w, outcome)
}

func (s *server) upload(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	parent, err := pathOf(query.Get("directory"))
	name := query.Get("name")
	if err != nil || !validName(name) {
		failure(w, errPath)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/octet-stream" {
		failure(w, errType)
		return
	}
	s.mutations.Lock()
	defer s.mutations.Unlock()
	outcome, err := stage(r.Context(), filepath.Join(parent, name), query.Get("conflict"), false, func(path string) error {
		return writeStream(r.Context(), path, r.Body, 0666)
	})
	if err != nil {
		failure(w, err)
		return
	}
	jsonResponse(w, outcome)
}

func download(w http.ResponseWriter, r *http.Request) {
	path, err := pathOf(r.URL.Query().Get("path"))
	if err != nil {
		failure(w, err)
		return
	}
	file, _, err := openRegular(path, os.O_RDONLY)
	if err != nil {
		failure(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, file)
	}
}
