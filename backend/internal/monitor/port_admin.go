package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"syscall"
	"time"

	"godesk/internal/privileges"
)

type portOperation struct {
	Action    string     `json:"action"`
	Target    portTarget `json:"target"`
	ServerPID int        `json:"serverPid"`
}

type portResult struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type portExecutor func(context.Context, portOperation) portResult

func executePortOperation(ctx context.Context, operation portOperation) portResult {
	if os.Geteuid() == 0 {
		return runPortOperation(ctx, operation)
	}
	path, err := os.Executable()
	if err != nil {
		return portFailure(ctx, err, "ports_unavailable", "无法执行端口操作")
	}

	cmd := privileges.Command(ctx, path, "--port-operation")
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	input, err := json.Marshal(operation)
	if err != nil {
		return portFailure(ctx, err, "ports_unavailable", "无法执行端口操作")
	}
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if privileges.Denied(err, stderr.String()) {
			return portError(http.StatusForbidden, "admin_unavailable", "管理员权限不可用，请检查 GoDesk 的免密 sudo 授权")
		}
		return portFailure(ctx, err, "ports_unavailable", "无法以管理员身份执行端口操作")
	}
	var result portResult
	if err := json.Unmarshal(output, &result); err != nil {
		return portFailure(ctx, err, "ports_unavailable", "无法读取管理员端口操作结果")
	}
	return result
}

// RunPortOperation handles one fixed operation without starting a server.
func RunPortOperation(ctx context.Context, input io.Reader, output io.Writer) error {
	if os.Geteuid() != 0 {
		return os.ErrPermission
	}
	var operation portOperation
	if err := json.NewDecoder(input).Decode(&operation); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(runPortOperation(ctx, operation))
}

func runPortOperation(ctx context.Context, operation portOperation) portResult {
	if operation.Action == "list" {
		ports, err := ListPorts(ctx)
		if err != nil {
			return portFailure(ctx, err, "ports_unavailable", "无法读取端口信息")
		}
		return portResponse(http.StatusOK, ports)
	}

	target := operation.Target
	if !target.valid() {
		return portError(http.StatusBadRequest, "invalid_target", "端口或进程参数无效")
	}
	switch operation.Action {
	case "detail":
		proc, err := target.resolve()
		if err != nil {
			return portFailure(ctx, err, "detail_unavailable", "无法读取进程详情")
		}
		detail, err := describePort(ctx, target, proc, operation.ServerPID)
		if err != nil {
			return portFailure(ctx, err, "detail_unavailable", "无法读取进程详情")
		}
		return portResponse(http.StatusOK, detail)
	case "logs":
		if _, err := target.resolve(); err != nil {
			return portFailure(ctx, err, "logs_unavailable", "无法读取日志")
		}
		unit, _, err := owningService(ctx, target.PID)
		if err != nil {
			return portFailure(ctx, err, "logs_unavailable", "无法识别日志来源")
		}
		if unit != target.Unit {
			return portFailure(ctx, errTargetChanged, "", "")
		}
		lines, err := portLogs(ctx, target, unit)
		if err != nil {
			return portFailure(ctx, err, "logs_unavailable", "journal 日志不可用")
		}
		if unit == "" {
			if _, err := target.resolve(); err != nil {
				return portFailure(ctx, err, "logs_unavailable", "无法读取日志")
			}
		}
		return portResponse(http.StatusOK, struct {
			Lines []string `json:"lines"`
		}{lines})
	case "stop":
		if target.PID == 1 {
			return portError(http.StatusConflict, "stop_not_allowed", "系统管理器仅支持查看")
		}
		if err := stopPort(ctx, target); err != nil {
			return portFailure(ctx, err, "stop_failed", "无法停止所选目标")
		}
		return portResult{Status: http.StatusNoContent}
	default:
		return portError(http.StatusBadRequest, "invalid_action", "端口操作无效")
	}
}

func portResponse(status int, data any) portResult {
	body, err := json.Marshal(data)
	if err != nil {
		slog.Error("encode port response", "error", err)
		return portError(http.StatusInternalServerError, "response_failed", "无法生成端口操作结果")
	}
	return portResult{Status: status, Body: body}
}

func portError(status int, code, message string) portResult {
	return portResponse(status, errorBody{Code: code, Message: message})
}

func portFailure(ctx context.Context, err error, code, message string) portResult {
	switch {
	case errors.Is(err, errTargetChanged):
		return portError(http.StatusConflict, "target_changed", errTargetChanged.Error())
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return portError(http.StatusGatewayTimeout, "timeout", "端口操作超时")
	default:
		slog.Error("port operation", "code", code, "error", err)
		return portError(http.StatusInternalServerError, code, message)
	}
}
