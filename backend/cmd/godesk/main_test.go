package main

import (
	"bytes"
	"os"
	"testing"

	"godesk/internal/buildinfo"
)

func setBuildInfo(t *testing.T, version, commit, date string) {
	t.Helper()
	oldVersion, oldCommit, oldDate := buildinfo.Version, buildinfo.Commit, buildinfo.Date
	buildinfo.Version, buildinfo.Commit, buildinfo.Date = version, commit, date
	t.Cleanup(func() {
		buildinfo.Version, buildinfo.Commit, buildinfo.Date = oldVersion, oldCommit, oldDate
	})
}

func TestVersionFlag(t *testing.T) {
	setBuildInfo(t, "v0.1.0", "abc1234", "2026-11-27T09:30:00Z")
	const want = "godesk v0.1.0 (abc1234, 2026-11-27T09:30:00Z)\n"
	for _, flag := range []string{"--version", "-version"} {
		var output bytes.Buffer
		if err := command(t.Context(), []string{flag}, &output); err != nil {
			t.Fatalf("%s: %v", flag, err)
		}
		if output.String() != want {
			t.Errorf("%s output = %q, want %q", flag, output.String(), want)
		}
	}
}

func TestVersionFlagDefaultsToDev(t *testing.T) {
	setBuildInfo(t, "dev", "", "")
	var output bytes.Buffer
	if err := command(t.Context(), []string{"--version"}, &output); err != nil {
		t.Fatal(err)
	}
	if want := "godesk dev\n"; output.String() != want {
		t.Errorf("output = %q, want %q", output.String(), want)
	}
}

func TestVersionFlagRejectsExtraArguments(t *testing.T) {
	var output bytes.Buffer
	if err := command(t.Context(), []string{"--version", "--listen", "127.0.0.1:0"}, &output); err == nil {
		t.Fatal("expected an error for extra arguments")
	}
	if output.Len() != 0 {
		t.Errorf("output = %q, want no output", output.String())
	}
}

func TestVersionFlagDoesNotCreateDataDirectory(t *testing.T) {
	t.Chdir(t.TempDir())
	var output bytes.Buffer
	if err := command(t.Context(), []string{"--version"}, &output); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("data"); !os.IsNotExist(err) {
		t.Fatalf("data directory was created or stat failed: %v", err)
	}
}
