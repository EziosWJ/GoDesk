package files

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"godesk/internal/privileges"
)

func (s *server) withElevation(operations *http.ServeMux) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query, err := url.ParseQuery(r.URL.RawQuery)
		mode := query["elevated"]
		if err != nil || len(mode) > 1 || len(mode) == 1 && mode[0] != "true" && mode[0] != "false" {
			failure(w, errPath)
			return
		}
		if len(mode) == 0 || mode[0] == "false" || os.Geteuid() == 0 {
			operations.ServeHTTP(w, r)
			return
		}
		if _, pattern := operations.Handler(r); pattern == "" {
			operations.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			s.mutations.Lock()
			defer s.mutations.Unlock()
		}
		query.Del("elevated")
		runElevated(w, r, query)
	}
}

type operationResponse struct {
	Status int
	Header http.Header
}

func runElevated(w http.ResponseWriter, r *http.Request, query url.Values) {
	path, err := os.Executable()
	if err != nil {
		failure(w, err)
		return
	}
	cmd := privileges.Command(r.Context(), path, "--file-operation")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		failure(w, err)
		return
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		failure(w, err)
		return
	}
	defer stdout.Close()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		elevationFailure(w, err, "")
		return
	}
	// HTTP framing lets the child stream uploads and detect a body interrupted
	// before its final byte, including chunked uploads.
	go func() {
		defer stdin.Close()
		request := &http.Request{
			Method: r.Method,
			URL:    &url.URL{Path: r.URL.Path, RawQuery: query.Encode()},
			Host:   "localhost", Body: r.Body, ContentLength: r.ContentLength,
			Header: http.Header{"Content-Type": r.Header.Values("Content-Type")},
		}
		_ = request.Write(stdin)
	}()
	reader := bufio.NewReaderSize(stdout, 8192)
	line, readErr := reader.ReadSlice('\n')
	var response operationResponse
	if readErr == nil {
		readErr = json.Unmarshal(line, &response)
	}
	if readErr != nil {
		stdout.Close()
		err := cmd.Wait()
		if err == nil {
			err = readErr
		}
		elevationFailure(w, err, strings.TrimSpace(stderr.String()))
		return
	}
	if response.Status < 200 || response.Status > 599 {
		stdout.Close()
		_ = cmd.Cancel()
		_ = cmd.Wait()
		failure(w, fmt.Errorf("管理员文件操作返回了无效的状态码"))
		return
	}
	for name, values := range response.Header {
		w.Header()[name] = values
	}
	w.WriteHeader(response.Status)
	_, copyErr := io.Copy(w, reader)
	if copyErr != nil {
		_ = cmd.Cancel()
		stdout.Close()
	}
	if err := cmd.Wait(); err != nil || copyErr != nil {
		panic(http.ErrAbortHandler)
	}
}

func elevationFailure(w http.ResponseWriter, err error, message string) {
	if privileges.Denied(err, message) {
		if message == "" {
			message = err.Error()
		}
		failure(w, fmt.Errorf("无法以管理员身份执行文件操作：%s: %w", message, os.ErrPermission))
		return
	}
	failure(w, fmt.Errorf("管理员文件操作失败: %w", err))
}

// RunElevated processes one request from the parent. It never opens a listener.
func RunElevated(ctx context.Context, input io.Reader, output io.Writer) error {
	if os.Geteuid() != 0 {
		return os.ErrPermission
	}
	return runOperation(ctx, input, output)
}

func runOperation(ctx context.Context, input io.Reader, output io.Writer) error {
	req, err := http.ReadRequest(bufio.NewReader(input))
	if err != nil {
		return err
	}
	// The helper owns stdin. Draining the rest of a rejected request here
	// would require the browser to finish an upload the handler cannot use.
	response := &operationWriter{output: output, header: make(http.Header)}
	(&server{}).operations().ServeHTTP(response, req.WithContext(ctx))
	return response.err
}

type operationWriter struct {
	output io.Writer
	header http.Header
	sent   bool
	err    error
}

func (w *operationWriter) Header() http.Header { return w.header }

func (w *operationWriter) WriteHeader(status int) {
	if !w.sent {
		w.sent = true
		w.err = json.NewEncoder(w.output).Encode(operationResponse{Status: status, Header: w.header})
	}
}

func (w *operationWriter) Write(data []byte) (int, error) {
	if !w.sent {
		w.WriteHeader(http.StatusOK)
	}
	if w.err != nil {
		return 0, w.err
	}
	n, err := w.output.Write(data)
	w.err = err
	return n, err
}
