package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"syscall"
	"time"

	"godesk/internal/privileges"

	"golang.org/x/sys/unix"
)

var (
	errProcessNotFound  = errors.New("process not found")
	errProcessChanged   = errors.New("process changed")
	errPidfdUnsupported = errors.New("pidfd signaling is unavailable")
)

// pidfdOpen is a variable so tests can simulate kernels without pidfd_open.
var pidfdOpen = unix.PidfdOpen

type processSignalOperation struct {
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
	Signal     string `json:"signal"`
}

type processSignalResult struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type processSignalExecutor func(context.Context, processSignalOperation) processSignalResult

func parseSignalName(name string) (unix.Signal, error) {
	switch name {
	case "SIGTERM":
		return unix.SIGTERM, nil
	case "SIGKILL":
		return unix.SIGKILL, nil
	default:
		return 0, errors.New("invalid signal")
	}
}

// executeProcessSignal first signals as the running account. Only EPERM is
// retried through the administrator helper, matching the port stop flow.
func executeProcessSignal(ctx context.Context, operation processSignalOperation) processSignalResult {
	sig, err := parseSignalName(operation.Signal)
	if err != nil {
		return signalError(400, "invalid_signal", "不支持的信号")
	}
	if operation.PID <= 1 {
		return signalError(403, "forbidden_pid", "不能向 PID 1 或无效进程发送信号")
	}
	if operation.StartTicks == 0 {
		return signalError(400, "invalid_target", "进程参数无效")
	}
	if err := sendSignal(operation.PID, operation.StartTicks, sig); err == nil {
		return processSignalResult{Status: 204}
	} else if !errors.Is(err, unix.EPERM) {
		return signalFailure(err)
	}
	return executeElevatedProcessSignal(ctx, operation)
}

func sendSignal(pid int, startTicks uint64, sig unix.Signal) error {
	fd, err := pidfdOpen(pid, 0)
	if err != nil {
		switch {
		case errors.Is(err, unix.ESRCH):
			return errProcessNotFound
		case errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EINVAL):
			// Without pidfd there is no way to bind the signal to the verified
			// process instance: a numeric kill could hit a reused PID. Refuse
			// instead of falling back to kill(2).
			return errPidfdUnsupported
		default:
			return err
		}
	}
	defer unix.Close(fd)

	// The pidfd binds the signal to the process instance, so the start time is
	// only used to reject a stale UI selection.
	if err := verifyProcessIdentity(pid, startTicks); err != nil {
		return err
	}
	err = unix.PidfdSendSignal(fd, sig, nil, 0)
	if errors.Is(err, unix.ESRCH) {
		return errProcessNotFound
	}
	return err
}

func verifyProcessIdentity(pid int, startTicks uint64) error {
	stat, err := readProcStat(pid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) {
			return errProcessNotFound
		}
		return err
	}
	if stat.startTicks != startTicks {
		return errProcessChanged
	}
	return nil
}

func executeElevatedProcessSignal(ctx context.Context, operation processSignalOperation) processSignalResult {
	path, err := os.Executable()
	if err != nil {
		return signalFailure(err)
	}
	cmd := privileges.Command(ctx, path, "--process-operation")
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	input, err := json.Marshal(operation)
	if err != nil {
		return signalFailure(err)
	}
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if privileges.Denied(err, stderr.String()) {
			return signalError(403, "sudo_unavailable", "管理员权限不可用，请检查 GoDesk 的免密 sudo 授权")
		}
		return signalFailure(err)
	}
	var result processSignalResult
	if err := json.Unmarshal(output, &result); err != nil {
		return signalFailure(err)
	}
	return result
}

// RunProcessSignalOperation handles one fixed administrator signal operation
// without starting a server.
func RunProcessSignalOperation(ctx context.Context, input io.Reader, output io.Writer) error {
	if os.Geteuid() != 0 {
		return os.ErrPermission
	}
	var operation processSignalOperation
	if err := json.NewDecoder(input).Decode(&operation); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(runProcessSignalOperation(ctx, operation))
}

func runProcessSignalOperation(ctx context.Context, operation processSignalOperation) processSignalResult {
	if err := ctx.Err(); err != nil {
		return signalFailure(err)
	}
	sig, err := parseSignalName(operation.Signal)
	if err != nil {
		return signalError(400, "invalid_signal", "不支持的信号")
	}
	if operation.PID <= 1 {
		return signalError(403, "forbidden_pid", "不能向 PID 1 或无效进程发送信号")
	}
	if operation.StartTicks == 0 {
		return signalError(400, "invalid_target", "进程参数无效")
	}
	if err := sendSignal(operation.PID, operation.StartTicks, sig); err != nil {
		return signalFailure(err)
	}
	return processSignalResult{Status: 204}
}

func signalResponse(status int, data any) processSignalResult {
	body, err := json.Marshal(data)
	if err != nil {
		slog.Error("encode process signal response", "error", err)
		return signalError(500, "response_failed", "无法生成进程操作结果")
	}
	return processSignalResult{Status: status, Body: body}
}

func signalError(status int, code, message string) processSignalResult {
	return signalResponse(status, errorBody{Code: code, Message: message})
}

func signalFailure(err error) processSignalResult {
	switch {
	case errors.Is(err, errProcessNotFound):
		return signalError(404, "process_not_found", "进程不存在")
	case errors.Is(err, errProcessChanged):
		return signalError(409, "process_changed", "进程已变化，请重新加载")
	case errors.Is(err, errPidfdUnsupported):
		return signalError(501, "pidfd_unsupported", "当前内核不支持 pidfd_open，无法安全地向进程发送信号")
	case errors.Is(err, unix.EPERM), errors.Is(err, unix.EACCES):
		return signalError(403, "permission_denied", "权限不足，无法结束该进程")
	case errors.Is(err, context.DeadlineExceeded):
		return signalError(504, "timeout", "进程操作超时")
	case errors.Is(err, context.Canceled):
		return signalError(499, "canceled", "请求已取消")
	default:
		slog.Error("process signal", "error", err)
		return signalError(500, "signal_failed", "无法结束所选进程")
	}
}
