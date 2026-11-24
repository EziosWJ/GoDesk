package files

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func getImage(w http.ResponseWriter, r *http.Request) {
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

	var sample [512]byte
	n, err := io.ReadFull(file, sample[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		failure(w, err)
		return
	}
	contentType := http.DetectContentType(sample[:n])
	if strings.EqualFold(filepath.Ext(path), ".svg") &&
		(strings.HasPrefix(contentType, "text/plain") || strings.HasPrefix(contentType, "text/xml")) {
		contentType = "image/svg+xml"
		// A directly navigated SVG must stay isolated from the application.
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	}
	if !strings.HasPrefix(contentType, "image/") {
		failure(w, errType)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		if _, err := w.Write(sample[:n]); err == nil {
			_, _ = io.Copy(w, file)
		}
	}
}
