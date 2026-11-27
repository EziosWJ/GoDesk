package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"godesk/internal/privileges"
)

const commandTimeout = 10 * time.Second

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type hostnameRequest struct {
	Hostname string `json:"hostname"`
}

type hostnameResponse struct {
	Hostname string `json:"hostname"`
}

type timezoneRequest struct {
	Timezone string `json:"timezone"`
}

type timezoneResponse struct {
	Timezone string `json:"timezone"`
}

type timezonesResponse struct {
	Timezones []string `json:"timezones"`
}

// commandRunner runs one privileged host command.
type commandRunner func(ctx context.Context, path string, args ...string) error

type handler struct {
	info        func() Info
	environment func() environment
	timezones   func() []string
	run         commandRunner
	timeout     time.Duration
}

// Register mounts the host information and host setting routes behind
// requireSession.
func Register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	h := &handler{
		info:        Collect,
		environment: detectEnvironment,
		timezones:   Timezones,
		run:         runCommand,
		timeout:     commandTimeout,
	}
	h.register(mux, requireSession)
}

func (h *handler) register(mux *http.ServeMux, requireSession func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/system/host", requireSession(http.HandlerFunc(h.hostHTTP)))
	mux.Handle("GET /api/v1/system/timezones", requireSession(http.HandlerFunc(h.timezonesHTTP)))
	mux.Handle("PUT /api/v1/system/host/hostname", requireSession(http.HandlerFunc(h.hostnameHTTP)))
	mux.Handle("PUT /api/v1/system/host/timezone", requireSession(http.HandlerFunc(h.timezoneHTTP)))
}

func (h *handler) hostHTTP(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.info())
}

func (h *handler) timezonesHTTP(w http.ResponseWriter, _ *http.Request) {
	zones := h.timezones()
	if zones == nil {
		zones = []string{}
	}
	writeJSON(w, http.StatusOK, timezonesResponse{Timezones: zones})
}

func (h *handler) hostnameHTTP(w http.ResponseWriter, r *http.Request) {
	var request hostnameRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if !validHostname(request.Hostname) {
		writeError(w, http.StatusBadRequest, "invalid_hostname", "主机名无效：请使用 1-63 个字母、数字或连字符组成的标签，且首尾必须是字母或数字")
		return
	}
	env := h.environment()
	if !env.capabilities.SetHostname || env.hostnamectl == "" {
		writeError(w, http.StatusConflict, "unsupported", unsupportedMessage(env.capabilities.HostnameReason))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	if err := h.run(ctx, env.hostnamectl, "set-hostname", "--", request.Hostname); err != nil {
		h.failed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, hostnameResponse{Hostname: request.Hostname})
}

func (h *handler) timezoneHTTP(w http.ResponseWriter, r *http.Request) {
	var request timezoneRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if !validTimezoneFormat(request.Timezone) || !slices.Contains(h.timezones(), request.Timezone) {
		writeError(w, http.StatusBadRequest, "invalid_timezone", "时区无效：请使用系统 zoneinfo 中存在的 IANA 时区名称")
		return
	}
	env := h.environment()
	if !env.capabilities.SetTimezone || env.timedatectl == "" {
		writeError(w, http.StatusConflict, "unsupported", unsupportedMessage(env.capabilities.TimezoneReason))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	if err := h.run(ctx, env.timedatectl, "set-timezone", "--", request.Timezone); err != nil {
		h.failed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, timezoneResponse{Timezone: request.Timezone})
}

// runCommand runs hostnamectl or timedatectl as root. privileges.Command
// uses the current process identity when it is already root and the
// non-interactive sudo path otherwise.
func runCommand(ctx context.Context, path string, args ...string) error {
	cmd := privileges.Command(ctx, path, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	if err := cmd.Run(); err != nil {
		return &commandError{err: err, stderr: stderr.String()}
	}
	return nil
}

// commandError keeps the command failure together with the captured stderr
// so sudo diagnostics can be told apart from the tool's own errors.
type commandError struct {
	err    error
	stderr string
}

func (e *commandError) Error() string {
	if message := strings.TrimSpace(e.stderr); message != "" {
		return message
	}
	return e.err.Error()
}

func (e *commandError) Unwrap() error {
	return e.err
}

func (h *handler) failed(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		writeError(w, http.StatusGatewayTimeout, "timeout", "操作超时")
		return
	}
	var failure *commandError
	if !errors.As(err, &failure) {
		writeError(w, http.StatusUnprocessableEntity, "operation_failed", err.Error())
		return
	}
	if sudoMissing(failure.err) {
		writeError(w, http.StatusForbidden, "sudo_unavailable", "未安装 sudo，无法获取管理员权限")
		return
	}
	if privileges.Denied(failure.err, failure.stderr) || sudoRefused(failure.stderr) {
		writeError(w, http.StatusForbidden, "permission_denied", "缺少管理员权限，请检查 GoDesk 的免密 sudo 授权")
		return
	}
	writeError(w, http.StatusUnprocessableEntity, "operation_failed", failure.Error())
}

// sudoMissing reports whether the failure was caused by the sudo binary not
// being startable, as opposed to sudo refusing the request.
func sudoMissing(err error) bool {
	var pathError *fs.PathError
	if errors.As(err, &pathError) && pathError.Path == "/usr/bin/sudo" {
		return true
	}
	var execError *exec.Error
	if errors.As(err, &execError) && execError.Name == "/usr/bin/sudo" {
		return true
	}
	return false
}

// sudoRefused recognizes the sudoers denial message, which unlike the other
// sudo diagnostics is not prefixed with "sudo:".
func sudoRefused(stderr string) bool {
	for line := range strings.Lines(stderr) {
		if strings.HasPrefix(line, "Sorry,") {
			return true
		}
	}
	return false
}

func unsupportedMessage(reason string) string {
	switch reason {
	case reasonSystemdUnavailable:
		return "当前系统未运行 systemd，无法修改主机设置"
	case reasonUnsupported:
		return "当前系统缺少 hostnamectl 或 timedatectl 命令，无法修改主机设置"
	default:
		return "当前系统不支持修改主机设置"
	}
}

// validHostname checks the RFC 1123 hostname form: dot-separated labels of
// 1-63 ASCII letters, digits and hyphens, with each label starting and ending
// in a letter or digit. The whole name stays within 253 characters.
func validHostname(name string) bool {
	if len(name) == 0 || len(name) > 253 {
		return false
	}
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if !alphanumeric(label[0]) || !alphanumeric(label[len(label)-1]) {
			return false
		}
		for index := 1; index < len(label)-1; index++ {
			if !alphanumeric(label[index]) && label[index] != '-' {
				return false
			}
		}
	}
	return true
}

func alphanumeric(char byte) bool {
	return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9'
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "invalid_content_type", "需要 application/json 请求")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_request", "请求内容无效")
		return false
	}
	return true
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
