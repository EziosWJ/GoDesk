package services

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCommandError(t *testing.T) {
	tests := []struct {
		message string
		code    string
	}{
		{"Failed to stop ssh.service: Access denied", "permission"},
		{"Failed to stop ssh.service: Interactive authentication required.", "permission"},
		{"Permission denied", "permission"},
		{"Failed to start foo.service: Unit foo.service not found.", "not_found"},
		{"Unit foo.service not loaded.", "not_found"},
		{"Job failed. See \"systemctl status foo.service\" for details.", "operation_failed"},
	}
	for _, tc := range tests {
		err := commandError(errors.New("exit status 1"), tc.message)
		if err.Code != tc.code {
			t.Errorf("commandError(%q).Code = %q, want %q", tc.message, err.Code, tc.code)
		}
	}
	if got := commandError(errors.New("exit status 1"), ""); got.Message != "exit status 1" {
		t.Errorf("empty stderr message = %q", got.Message)
	}
}

func TestSystemdCapabilities(t *testing.T) {
	withoutJournal := newSystemd("/usr/bin/systemctl", "")
	if !withoutJournal.Capabilities().Start || withoutJournal.Capabilities().Logs {
		t.Errorf("unexpected capabilities without journalctl: %+v", withoutJournal.Capabilities())
	}
	withJournal := newSystemd("/usr/bin/systemctl", "/usr/bin/journalctl")
	if !withJournal.Capabilities().Logs {
		t.Error("logs capability should be true with journalctl")
	}
}

func TestSystemdListIntegration(t *testing.T) {
	if info, err := os.Stat("/run/systemd/system"); err != nil || !info.IsDir() {
		t.Skip("systemd is not running")
	}
	backend, err := Open("systemd")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	list, err := backend.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) == 0 {
		t.Fatal("expected at least one service unit")
	}
	for _, service := range list {
		if !ValidUnit(service.Name) {
			t.Errorf("invalid unit name %q", service.Name)
		}
		if strings.HasSuffix(service.Name, "@.service") {
			t.Errorf("template unit %q was listed", service.Name)
		}
		if service.State == "" {
			t.Errorf("unit %q has no state", service.Name)
		}
		if service.Actions == nil {
			t.Errorf("unit %q has nil actions", service.Name)
		}
	}
}
