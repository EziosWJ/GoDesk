package host

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeZoneFile(t *testing.T, root, name string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("TZif"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAvailableTimezones(t *testing.T) {
	root := t.TempDir()
	for _, zone := range []string{
		"Asia/Shanghai",
		"Europe/Berlin",
		"America/New_York",
		"UTC",
		"Etc/UTC",
		"posix/UTC",
		"right/UTC",
	} {
		writeZoneFile(t, root, zone)
	}
	for _, file := range []string{
		"zone.tab",
		"zone1970.tab",
		"iso3166.tab",
		"leapseconds",
		"leap-seconds.list",
		"tzdata.zi",
		"SECURITY",
		"localtime",
		"posixrules",
	} {
		writeZoneFile(t, root, file)
	}

	want := []string{
		"America/New_York",
		"Asia/Shanghai",
		"Europe/Berlin",
		"UTC",
	}
	if got := availableTimezones(root); !reflect.DeepEqual(got, want) {
		t.Errorf("availableTimezones() = %v, want %v", got, want)
	}
}

func TestAvailableTimezonesIncludesSymlinkedZone(t *testing.T) {
	root := t.TempDir()
	writeZoneFile(t, root, "Etc/UTC")
	if err := os.Symlink(filepath.Join("Etc", "UTC"), filepath.Join(root, "UTC")); err != nil {
		t.Fatal(err)
	}
	want := []string{"UTC"}
	if got := availableTimezones(root); !reflect.DeepEqual(got, want) {
		t.Errorf("availableTimezones() = %v, want %v", got, want)
	}
}

func TestAvailableTimezonesFallback(t *testing.T) {
	for _, root := range []string{
		filepath.Join(t.TempDir(), "missing"),
		t.TempDir(),
	} {
		want := []string{"UTC"}
		if got := availableTimezones(root); !reflect.DeepEqual(got, want) {
			t.Errorf("availableTimezones(%q) = %v, want %v", root, got, want)
		}
	}
}

func TestTimezonesRealDatabase(t *testing.T) {
	zones := Timezones()
	if len(zones) == 0 {
		t.Fatal("Timezones() returned no zones")
	}
	for index := 1; index < len(zones); index++ {
		if zones[index-1] >= zones[index] {
			t.Fatalf("zones are not sorted and unique: %q then %q", zones[index-1], zones[index])
		}
	}
}
