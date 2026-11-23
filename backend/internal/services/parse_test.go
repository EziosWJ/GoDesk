package services

import (
	"reflect"
	"testing"
)

const testUnitFiles = `
ssh.service enabled enabled
cron.service disabled disabled
apport.service static -
unloaded.service disabled disabled
foo@.service static -
`

const testRuntimeUnits = `
ssh.service                 loaded active   running OpenBSD Secure Shell server
cron.service                loaded inactive dead    Regular background program processing daemon
apport.service              loaded active   exited  Automatic crash report generation
run-r123.service            loaded active   running /run/user/1000/gdm/Xorg
getty@tty1.service          loaded failed   failed  Getty on tty1
`

func allCapabilities() Capabilities {
	return Capabilities{Start: true, Stop: true, Restart: true, Enable: true, Disable: true, Logs: true, StateReliable: true}
}

func TestParseUnitFiles(t *testing.T) {
	files := parseUnitFiles(testUnitFiles)
	want := []unitFile{
		{name: "ssh.service", state: "enabled"},
		{name: "cron.service", state: "disabled"},
		{name: "apport.service", state: "static"},
		{name: "unloaded.service", state: "disabled"},
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("parseUnitFiles() = %#v, want %#v", files, want)
	}
}

func TestParseRuntimeUnits(t *testing.T) {
	units := parseRuntimeUnits(testRuntimeUnits)
	if len(units) != 5 {
		t.Fatalf("parseRuntimeUnits() returned %d units, want 5", len(units))
	}
	if got := units[0].description; got != "OpenBSD Secure Shell server" {
		t.Errorf("ssh description = %q", got)
	}
	if got := units[4].active; got != "failed" {
		t.Errorf("getty active = %q, want failed", got)
	}
	if got := units[4].sub; got != "failed" {
		t.Errorf("getty sub = %q, want failed", got)
	}
}

func TestBuildServices(t *testing.T) {
	services := buildServices(testUnitFiles, testRuntimeUnits, allCapabilities())
	want := []struct {
		name        string
		description string
		state       State
		detail      string
		boot        BootState
		actions     []Action
	}{
		{"apport.service", "Automatic crash report generation", StateCompleted, "active (exited)", BootStatic, []Action{ActionStop, ActionRestart}},
		{"cron.service", "Regular background program processing daemon", StateStopped, "inactive (dead)", BootDisabled, []Action{ActionStart, ActionEnable}},
		{"getty@tty1.service", "Getty on tty1", StateFailed, "failed (failed)", BootNotApplicable, []Action{ActionStart, ActionRestart}},
		{"run-r123.service", "/run/user/1000/gdm/Xorg", StateRunning, "active (running)", BootNotApplicable, []Action{ActionStop, ActionRestart}},
		{"ssh.service", "OpenBSD Secure Shell server", StateRunning, "active (running)", BootEnabled, []Action{ActionStop, ActionRestart, ActionDisable}},
		{"unloaded.service", "", StateStopped, "", BootDisabled, []Action{ActionStart, ActionEnable}},
	}
	if len(services) != len(want) {
		t.Fatalf("buildServices() returned %d services, want %d", len(services), len(want))
	}
	for i, expected := range want {
		got := services[i]
		if got.Name != expected.name || got.Description != expected.description || got.State != expected.state ||
			got.StateDetail != expected.detail || got.BootState != expected.boot || !reflect.DeepEqual(got.Actions, expected.actions) {
			t.Errorf("service %d = %#v, want %#v", i, got, expected)
		}
	}
	for _, service := range services {
		if service.Name == "foo@.service" {
			t.Error("template unit was listed")
		}
	}
}

func TestStateFor(t *testing.T) {
	tests := []struct {
		unit runtimeUnit
		want State
	}{
		{runtimeUnit{load: "loaded", active: "active", sub: "running"}, StateRunning},
		{runtimeUnit{load: "loaded", active: "active", sub: "exited"}, StateCompleted},
		{runtimeUnit{load: "loaded", active: "inactive", sub: "dead"}, StateStopped},
		{runtimeUnit{load: "loaded", active: "failed", sub: "failed"}, StateFailed},
		{runtimeUnit{load: "loaded", active: "activating", sub: "start"}, StateUnknown},
		{runtimeUnit{load: "loaded", active: "deactivating", sub: "stop"}, StateUnknown},
		{runtimeUnit{load: "loaded", active: "reloading", sub: "reload"}, StateUnknown},
		{runtimeUnit{load: "not-found", active: "inactive", sub: "dead"}, StateUnknown},
	}
	for _, tc := range tests {
		if got := stateFor(tc.unit); got != tc.want {
			t.Errorf("stateFor(%+v) = %s, want %s", tc.unit, got, tc.want)
		}
	}
}

func TestBootStateFor(t *testing.T) {
	tests := map[string]BootState{
		"enabled":         BootEnabled,
		"disabled":        BootDisabled,
		"static":          BootStatic,
		"indirect":        BootStatic,
		"alias":           BootStatic,
		"masked":          BootMasked,
		"masked-runtime":  BootMasked,
		"enabled-runtime": BootRuntime,
		"linked-runtime":  BootRuntime,
		"linked":          BootEnabled,
		"generated":       BootNotApplicable,
		"transient":       BootNotApplicable,
		"bad":             BootNotApplicable,
		"":                BootNotApplicable,
	}
	for value, want := range tests {
		if got := bootStateFor(value); got != want {
			t.Errorf("bootStateFor(%q) = %s, want %s", value, got, want)
		}
	}
}

func TestSplitLines(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{"", []string{}},
		{"\n", []string{}},
		{"a\nb\n", []string{"a", "b"}},
		{"a\n\nb", []string{"a", "", "b"}},
	}
	for _, tc := range tests {
		if got := splitLines(tc.input); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("splitLines(%q) = %#v, want %#v", tc.input, got, tc.want)
		}
	}
}
