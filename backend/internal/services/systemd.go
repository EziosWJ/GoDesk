package services

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type systemdBackend struct {
	systemctl  string
	journalctl string
}

func newSystemd(systemctl, journalctl string) Backend {
	return &systemdBackend{systemctl: systemctl, journalctl: journalctl}
}

func (b *systemdBackend) Name() string { return "systemd" }

func (b *systemdBackend) Capabilities() Capabilities {
	return Capabilities{
		Start:         true,
		Stop:          true,
		Restart:       true,
		Enable:        true,
		Disable:       true,
		Logs:          b.journalctl != "",
		StateReliable: true,
	}
}

func (b *systemdBackend) List(ctx context.Context) ([]Service, error) {
	files, err := b.run(ctx, b.systemctl, "list-unit-files", "--type=service", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, err
	}
	units, err := b.run(ctx, b.systemctl, "list-units", "--type=service", "--all", "--full", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, err
	}
	return buildServices(files, units, b.Capabilities()), nil
}

func (b *systemdBackend) Start(ctx context.Context, unit string) error {
	return b.action(ctx, ActionStart, unit)
}

func (b *systemdBackend) Stop(ctx context.Context, unit string) error {
	return b.action(ctx, ActionStop, unit)
}

func (b *systemdBackend) Restart(ctx context.Context, unit string) error {
	return b.action(ctx, ActionRestart, unit)
}

func (b *systemdBackend) Enable(ctx context.Context, unit string) error {
	return b.action(ctx, ActionEnable, unit)
}

func (b *systemdBackend) Disable(ctx context.Context, unit string) error {
	return b.action(ctx, ActionDisable, unit)
}

func (b *systemdBackend) action(ctx context.Context, action Action, unit string) error {
	_, err := b.run(ctx, b.systemctl, string(action), "--no-ask-password", "--", unit)
	return err
}

func (b *systemdBackend) Logs(ctx context.Context, unit string, lines int) ([]string, error) {
	if b.journalctl == "" {
		return nil, &Error{Code: "logs_unavailable", Message: "journalctl 不可用"}
	}
	cmd := exec.CommandContext(ctx, b.journalctl,
		"-u", unit, "-n", strconv.Itoa(lines), "--no-pager", "--quiet", "-o", "short-iso")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if strings.Contains(strings.ToLower(message), "no journal files were found") {
			return []string{}, nil
		}
		return nil, commandError(err, message)
	}
	return splitLines(stdout.String()), nil
}

func (b *systemdBackend) run(ctx context.Context, path string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", commandError(err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

func commandError(err error, message string) *Error {
	if message == "" {
		message = err.Error()
	}
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "access denied"),
		strings.Contains(lower, "permission denied"),
		strings.Contains(lower, "interactive authentication required"),
		strings.Contains(lower, "authentication is required"),
		strings.Contains(lower, "polkit"):
		return &Error{Code: "permission", Message: message}
	case strings.Contains(lower, "not found"),
		strings.Contains(lower, "not loaded"),
		strings.Contains(lower, "does not exist"):
		return &Error{Code: "not_found", Message: message}
	default:
		return &Error{Code: "operation_failed", Message: message}
	}
}

func splitLines(output string) []string {
	output = strings.TrimRight(output, "\n")
	if output == "" {
		return []string{}
	}
	return strings.Split(output, "\n")
}
