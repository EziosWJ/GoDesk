package services

import (
	"reflect"
	"testing"
)

func TestValidUnit(t *testing.T) {
	valid := []string{
		"ssh.service",
		"getty@tty1.service",
		"foo-bar_baz:1.service",
		`foo\x2dbar.service`,
	}
	for _, name := range valid {
		if !ValidUnit(name) {
			t.Errorf("ValidUnit(%q) = false, want true", name)
		}
	}
	invalid := []string{
		"",
		"-x.service",
		"ssh",
		"ssh.socket",
		"../ssh.service",
		"ssh service",
		"ssh.service --now",
		"a/b.service",
		"ssh.service\n",
	}
	for _, name := range invalid {
		if ValidUnit(name) {
			t.Errorf("ValidUnit(%q) = true, want false", name)
		}
	}
}

func TestActionsFor(t *testing.T) {
	all := Capabilities{Start: true, Stop: true, Restart: true, Enable: true, Disable: true, Logs: true, StateReliable: true}
	tests := []struct {
		name  string
		state State
		boot  BootState
		caps  Capabilities
		want  []Action
	}{
		{"running enabled", StateRunning, BootEnabled, all, []Action{ActionStop, ActionRestart, ActionDisable}},
		{"running disabled", StateRunning, BootDisabled, all, []Action{ActionStop, ActionRestart, ActionEnable}},
		{"completed static", StateCompleted, BootStatic, all, []Action{ActionStop, ActionRestart}},
		{"stopped disabled", StateStopped, BootDisabled, all, []Action{ActionStart, ActionEnable}},
		{"failed enabled", StateFailed, BootEnabled, all, []Action{ActionStart, ActionRestart, ActionDisable}},
		{"unknown runtime", StateUnknown, BootRuntime, all, []Action{ActionStart, ActionStop, ActionRestart}},
		{"stopped masked", StateStopped, BootMasked, all, []Action{}},
		{"running masked", StateRunning, BootMasked, all, []Action{ActionStop}},
		{"stopped static", StateStopped, BootStatic, all, []Action{ActionStart}},
		{"no capabilities", StateRunning, BootEnabled, Capabilities{}, []Action{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := actionsFor(tc.state, tc.boot, tc.caps)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("actionsFor(%s, %s) = %v, want %v", tc.state, tc.boot, got, tc.want)
			}
		})
	}
}
