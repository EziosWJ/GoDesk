package services

import (
	"os/exec"
	"testing"
)

func TestOpen(t *testing.T) {
	tests := []struct {
		name    string
		choice  string
		dir     bool
		paths   map[string]string
		want    string
		wantLog bool
		wantErr bool
	}{
		{
			name:    "auto detects systemd",
			choice:  "auto",
			dir:     true,
			paths:   map[string]string{"systemctl": "/usr/bin/systemctl", "journalctl": "/usr/bin/journalctl"},
			want:    "systemd",
			wantLog: true,
		},
		{
			name:   "auto without systemd dir",
			choice: "auto",
			dir:    false,
			paths:  map[string]string{"systemctl": "/usr/bin/systemctl"},
			want:   "none",
		},
		{
			name:   "auto without systemctl",
			choice: "auto",
			dir:    true,
			want:   "none",
		},
		{
			name:   "forced systemd without detection",
			choice: "systemd",
			paths:  map[string]string{"systemctl": "/usr/bin/systemctl"},
			want:   "systemd",
		},
		{
			name:    "forced systemd missing binary",
			choice:  "systemd",
			wantErr: true,
		},
		{
			name:   "none",
			choice: "none",
			dir:    true,
			paths:  map[string]string{"systemctl": "/usr/bin/systemctl"},
			want:   "none",
		},
		{
			name:    "invalid choice",
			choice:  "upstart",
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := probe{
				systemdDir: func() bool { return tc.dir },
				lookPath: func(name string) (string, error) {
					if path, ok := tc.paths[name]; ok {
						return path, nil
					}
					return "", exec.ErrNotFound
				},
			}
			backend, err := open(tc.choice, p)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if backend.Name() != tc.want {
				t.Fatalf("backend = %q, want %q", backend.Name(), tc.want)
			}
			if backend.Capabilities().Logs != tc.wantLog {
				t.Errorf("capabilities.logs = %v, want %v", backend.Capabilities().Logs, tc.wantLog)
			}
		})
	}
}
