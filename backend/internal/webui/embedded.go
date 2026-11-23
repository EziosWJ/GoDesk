//go:build web

package webui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

//go:embed all:dist/packed
var assets embed.FS

func Handler() http.Handler {
	return http.HandlerFunc(serveAsset)
}

func serveAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	file, err := assets.Open("dist/packed/gzip/" + name)
	compressed := err == nil
	if !compressed {
		file, err = assets.Open("dist/packed/identity/" + name)
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	content, ok := file.(io.ReadSeeker)
	if !ok {
		http.NotFound(w, r)
		return
	}

	w.Header().Add("Vary", "Accept-Encoding")
	gzipPreferred, identityAllowed := negotiateEncoding(r.Header.Values("Accept-Encoding"))
	// Keep byte ranges relative to the original file when the client accepts it.
	if compressed && gzipPreferred && (r.Header.Get("Range") == "" || !identityAllowed) {
		info, err := file.Stat()
		if err != nil {
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		contentType := mime.TypeByExtension(path.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, file)
		}
		return
	}
	if !identityAllowed {
		http.Error(w, "asset encoding unavailable", http.StatusNotAcceptable)
		return
	}
	if compressed {
		original, err := decompress(file)
		if err != nil {
			http.Error(w, "asset unavailable", http.StatusInternalServerError)
			return
		}
		content = bytes.NewReader(original)
	}
	http.ServeContent(w, r, name, time.Time{}, content)
}

func decompress(file io.Reader) ([]byte, error) {
	reader, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func negotiateEncoding(headers []string) (gzipPreferred bool, identityAllowed bool) {
	quality := make(map[string]float64)
	for _, header := range headers {
		for _, value := range strings.Split(header, ",") {
			encoding, params, err := mime.ParseMediaType(strings.TrimSpace(value))
			if err != nil {
				continue
			}
			weight := 1.0
			if q, ok := params["q"]; ok {
				weight, err = strconv.ParseFloat(q, 64)
				if err != nil || !(weight >= 0 && weight <= 1) {
					continue
				}
			}
			quality[encoding] = weight
		}
	}
	gzipWeight, ok := quality["gzip"]
	if !ok {
		gzipWeight = quality["*"]
	}
	if identityWeight, explicit := quality["identity"]; explicit {
		return gzipWeight > 0 && gzipWeight >= identityWeight, identityWeight > 0
	}
	wildcard, explicit := quality["*"]
	return gzipWeight > 0, !explicit || wildcard > 0
}
