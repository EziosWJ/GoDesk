package files

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"
)

const textLimit = 5 << 20

type document struct {
	Path    string `json:"path"`
	Text    string `json:"text"`
	Version string `json:"version"`
}

func version(info fs.FileInfo, content []byte) string {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%x-%x-%x-%x", stat.Dev, stat.Ino, info.ModTime().UnixNano(), sha256.Sum256(content))
}

func readText(path string) (document, fs.FileInfo, error) {
	file, info, err := openRegular(path, os.O_RDONLY)
	if err != nil {
		return document{}, nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, textLimit+1))
	if err != nil {
		return document{}, nil, err
	}
	if len(content) > textLimit {
		return document{}, nil, errSize
	}
	// Unicode BOMs identify unsupported encodings even when they include NUL.
	if bytes.HasPrefix(content, []byte("\xff\xfe")) || bytes.HasPrefix(content, []byte("\xfe\xff")) ||
		bytes.HasPrefix(content, []byte("\x00\x00\xfe\xff")) {
		return document{}, nil, errEncoding
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return document{}, nil, errBinary
	}
	if !utf8.Valid(content) {
		return document{}, nil, errEncoding
	}
	return document{path, string(content), version(info, content)}, info, nil
}

func getText(w http.ResponseWriter, r *http.Request) {
	path, err := pathOf(r.URL.Query().Get("path"))
	if err != nil {
		failure(w, err)
		return
	}
	data, _, err := readText(path)
	if err != nil {
		failure(w, err)
		return
	}
	jsonResponse(w, data)
}

func ensureVersion(path, expected string) (fs.FileInfo, error) {
	current, info, err := readText(path)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errSize) || errors.Is(err, errBinary) || errors.Is(err, errEncoding) || errors.Is(err, errType) {
		return nil, errChanged
	}
	if err == nil && current.Version != expected {
		err = errChanged
	}
	return info, err
}

func (s *server) putText(w http.ResponseWriter, r *http.Request) {
	var form struct {
		Path, Text, Version, Conflict string
	}
	// JSON escapes may use six bytes per input byte.
	r.Body = http.MaxBytesReader(w, r.Body, 6*textLimit+65536)
	if !readJSON(w, r, &form) {
		return
	}
	path, err := pathOf(form.Path)
	if err != nil {
		failure(w, err)
		return
	}
	if len(form.Text) > textLimit {
		failure(w, errSize)
		return
	}
	if strings.ContainsRune(form.Text, 0) {
		failure(w, errBinary)
		return
	}

	s.mutations.Lock()
	defer s.mutations.Unlock()
	var info fs.FileInfo
	if form.Version == "" {
		if form.Conflict != "" && form.Conflict != "keep" {
			failure(w, errPath)
			return
		}
		outcome, err := stage(r.Context(), path, form.Conflict, false, func(target string) error {
			return writeStream(r.Context(), target, strings.NewReader(form.Text), 0666)
		})
		if err != nil {
			failure(w, err)
			return
		}
		path = outcome.Path
		info, err = os.Stat(path)
		if err != nil {
			failure(w, err)
			return
		}
	} else {
		info, err = saveText(r, path, form.Text, form.Version)
		if err != nil {
			failure(w, err)
			return
		}
	}
	jsonResponse(w, map[string]string{"path": path, "version": version(info, []byte(form.Text))})
}

func saveText(r *http.Request, path, text, expected string) (fs.FileInfo, error) {
	info, err := ensureVersion(path, expected)
	if err != nil {
		return nil, err
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	writable, actual, err := openRegular(target, os.O_WRONLY)
	if err != nil {
		return nil, err
	}
	writable.Close()
	if !os.SameFile(info, actual) {
		return nil, errChanged
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".godesk-text-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if _, err := io.WriteString(temp, text); err != nil {
		return nil, err
	}
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	latest, err := ensureVersion(path, expected)
	if err != nil {
		return nil, err
	}
	actualTarget, err := os.Stat(target)
	if err != nil || !os.SameFile(latest, actualTarget) {
		return nil, errChanged
	}
	if err := preserveOwnership(temp, actualTarget); err != nil {
		return nil, err
	}
	const permissionBits = fs.ModePerm | fs.ModeSetuid | fs.ModeSetgid | fs.ModeSticky
	if err := temp.Chmod(actualTarget.Mode() & permissionBits); err != nil {
		return nil, err
	}
	published, err := temp.Stat()
	if err != nil {
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(temp.Name(), target); err != nil {
		return nil, err
	}
	return published, nil
}
