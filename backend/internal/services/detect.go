package services

import (
	"fmt"
	"os"
	"os/exec"
)

type probe struct {
	systemdDir func() bool
	lookPath   func(string) (string, error)
}

func systemdProbe() probe {
	return probe{
		systemdDir: func() bool {
			info, err := os.Stat("/run/systemd/system")
			return err == nil && info.IsDir()
		},
		lookPath: exec.LookPath,
	}
}

func open(choice string, p probe) (Backend, error) {
	switch choice {
	case "", "auto":
		if p.systemdDir() {
			if systemctl, err := p.lookPath("systemctl"); err == nil {
				journalctl, _ := p.lookPath("journalctl")
				return newSystemd(systemctl, journalctl), nil
			}
		}
		return None(), nil
	case "systemd":
		systemctl, err := p.lookPath("systemctl")
		if err != nil {
			return nil, fmt.Errorf("service backend systemd: %w", err)
		}
		journalctl, _ := p.lookPath("journalctl")
		return newSystemd(systemctl, journalctl), nil
	case "none":
		return None(), nil
	default:
		return nil, fmt.Errorf("invalid -service-backend %q (want auto, systemd, or none)", choice)
	}
}

// Open selects a service backend. It is called once at startup.
func Open(choice string) (Backend, error) {
	return open(choice, systemdProbe())
}
