package host

import (
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"

	"godesk/internal/buildinfo"
)

func TestParseOSRelease(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{
			name: "pretty name",
			data: "NAME=\"Ubuntu\"\nVERSION=\"24.04.1 LTS (Noble Numbat)\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n",
			want: "Ubuntu 24.04.1 LTS",
		},
		{
			name: "name and version fallback",
			data: "NAME=\"Debian GNU/Linux\"\nVERSION=\"12 (bookworm)\"\nID=debian\n",
			want: "Debian GNU/Linux 12 (bookworm)",
		},
		{
			name: "single quotes and comments",
			data: "# comment\nNAME='Alpine Linux'\nVERSION='3.20'\n",
			want: "Alpine Linux 3.20",
		},
		{
			name: "name only",
			data: "NAME=\"Arch Linux\"\n",
			want: "Arch Linux",
		},
		{
			name: "empty",
			data: "",
			want: "",
		},
		{
			name: "malformed lines",
			data: "not a key value pair\n=missing-key\n",
			want: "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := parseOSRelease([]byte(test.data)); got != test.want {
				t.Errorf("parseOSRelease() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParseCPUModel(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{
			name: "x86 first model name",
			data: "processor\t: 0\nmodel name\t: AMD EPYC 7763 64-Core Processor\nprocessor\t: 1\nmodel name\t: AMD EPYC 7763 64-Core Processor\n",
			want: "AMD EPYC 7763 64-Core Processor",
		},
		{
			name: "arm hardware",
			data: "processor\t: 0\nHardware\t: BCM2835\nRevision\t: c03111\n",
			want: "BCM2835",
		},
		{
			name: "arm model",
			data: "processor\t: 0\nModel\t\t: Raspberry Pi 4 Model B Rev 1.4\n",
			want: "Raspberry Pi 4 Model B Rev 1.4",
		},
		{
			name: "model name wins over hardware",
			data: "Hardware\t: Generic SoC\nmodel name\t: Cortex-A72\n",
			want: "Cortex-A72",
		},
		{
			name: "empty",
			data: "",
			want: "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := parseCPUModel([]byte(test.data)); got != test.want {
				t.Errorf("parseCPUModel() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParseMemTotal(t *testing.T) {
	tests := []struct {
		name string
		data string
		want uint64
	}{
		{name: "typical", data: "MemTotal:       16316312 kB\nMemFree:         1234567 kB\n", want: 16316312 * 1024},
		{name: "no unit", data: "MemTotal: 1024\n", want: 1024 * 1024},
		{name: "malformed value", data: "MemTotal: lots kB\n", want: 0},
		{name: "missing", data: "MemFree: 1 kB\n", want: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := parseMemTotal([]byte(test.data)); got != test.want {
				t.Errorf("parseMemTotal() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestParseUptime(t *testing.T) {
	tests := []struct {
		name string
		data string
		want int64
	}{
		{name: "typical", data: "123456.78 456789.01\n", want: 123456},
		{name: "truncates", data: "1.99 2.00\n", want: 1},
		{name: "negative", data: "-1.00 2.00\n", want: 0},
		{name: "malformed", data: "not-a-number\n", want: 0},
		{name: "empty", data: "", want: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := parseUptime([]byte(test.data)); got != test.want {
				t.Errorf("parseUptime() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestParseTimezone(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{name: "typical", data: "Asia/Shanghai\n", want: "Asia/Shanghai"},
		{name: "trims whitespace", data: "  Europe/Berlin  \n", want: "Europe/Berlin"},
		{name: "empty", data: "\n", want: ""},
		{name: "parent traversal", data: "../../etc/passwd\n", want: ""},
		{name: "absolute", data: "/etc/passwd\n", want: ""},
		{name: "leading hyphen", data: "-Asia/Shanghai\n", want: ""},
		{name: "space", data: "Asia Shanghai\n", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := parseTimezone([]byte(test.data)); got != test.want {
				t.Errorf("parseTimezone() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestTimezoneFromLocaltime(t *testing.T) {
	tests := []struct {
		name   string
		target string
		want   string
	}{
		{name: "absolute", target: "/usr/share/zoneinfo/Asia/Shanghai", want: "Asia/Shanghai"},
		{name: "relative", target: "../usr/share/zoneinfo/Europe/Berlin", want: "Europe/Berlin"},
		{name: "relative without parent", target: "usr/share/zoneinfo/Etc/UTC", want: "Etc/UTC"},
		{name: "trailing whitespace", target: " /usr/share/zoneinfo/UTC\n", want: "UTC"},
		{name: "unknown target", target: "/etc/localtime", want: ""},
		{name: "traversal", target: "/usr/share/zoneinfo/../../../etc/passwd", want: ""},
		{name: "empty", target: "", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := timezoneFromLocaltime(test.target); got != test.want {
				t.Errorf("timezoneFromLocaltime(%q) = %q, want %q", test.target, got, test.want)
			}
		})
	}
}

func TestDetectTimezone(t *testing.T) {
	readFile := func(content string, err error) func(string) ([]byte, error) {
		return func(string) ([]byte, error) { return []byte(content), err }
	}
	readlink := func(target string, err error) func(string) (string, error) {
		return func(string) (string, error) { return target, err }
	}
	missing := errors.New("missing")

	// `timedatectl set-timezone` updates /etc/localtime, so a stale
	// /etc/timezone must not win during readback.
	t.Run("localtime symlink wins over stale timezone file", func(t *testing.T) {
		got := detectTimezone(readFile("Asia/Shanghai\n", nil), readlink("/usr/share/zoneinfo/Europe/Berlin", nil))
		if got != "Europe/Berlin" {
			t.Errorf("detectTimezone() = %q, want Europe/Berlin", got)
		}
	})
	t.Run("relative localtime symlink", func(t *testing.T) {
		got := detectTimezone(readFile("Asia/Shanghai\n", nil), readlink("../usr/share/zoneinfo/Europe/Berlin", nil))
		if got != "Europe/Berlin" {
			t.Errorf("detectTimezone() = %q, want Europe/Berlin", got)
		}
	})
	t.Run("timezone file fallback", func(t *testing.T) {
		got := detectTimezone(readFile("Asia/Shanghai\n", nil), readlink("", missing))
		if got != "Asia/Shanghai" {
			t.Errorf("detectTimezone() = %q, want Asia/Shanghai", got)
		}
	})
	t.Run("invalid localtime falls back to timezone file", func(t *testing.T) {
		got := detectTimezone(readFile("Asia/Shanghai\n", nil), readlink("/etc/localtime", nil))
		if got != "Asia/Shanghai" {
			t.Errorf("detectTimezone() = %q, want Asia/Shanghai", got)
		}
	})
	t.Run("runtime fallback is never empty", func(t *testing.T) {
		if got := detectTimezone(readFile("", missing), readlink("", missing)); got == "" {
			t.Error("detectTimezone() returned an empty zone")
		}
	})
}

func TestInspectEnvironment(t *testing.T) {
	found := func(name string) (string, error) { return "/usr/bin/" + name, nil }
	missing := func(string) (string, error) { return "", errors.New("not found") }

	tests := []struct {
		name         string
		lookPath     func(string) (string, error)
		systemd      bool
		want         Capabilities
		wantHostname string
		wantTime     string
	}{
		{
			name:         "available",
			lookPath:     found,
			systemd:      true,
			want:         Capabilities{SetHostname: true, SetTimezone: true},
			wantHostname: "/usr/bin/hostnamectl",
			wantTime:     "/usr/bin/timedatectl",
		},
		{
			name:     "systemd unavailable",
			lookPath: found,
			systemd:  false,
			want:     Capabilities{HostnameReason: "systemd_unavailable", TimezoneReason: "systemd_unavailable"},
		},
		{
			name:     "tools missing",
			lookPath: missing,
			systemd:  true,
			want:     Capabilities{HostnameReason: "unsupported", TimezoneReason: "unsupported"},
		},
		{
			name: "only hostnamectl",
			lookPath: func(name string) (string, error) {
				if name == "hostnamectl" {
					return "/usr/bin/hostnamectl", nil
				}
				return "", errors.New("not found")
			},
			systemd:      true,
			want:         Capabilities{SetHostname: true, TimezoneReason: "unsupported"},
			wantHostname: "/usr/bin/hostnamectl",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := inspectEnvironment(test.lookPath, test.systemd)
			if env.capabilities != test.want {
				t.Errorf("capabilities = %+v, want %+v", env.capabilities, test.want)
			}
			if env.hostnamectl != test.wantHostname {
				t.Errorf("hostnamectl = %q, want %q", env.hostnamectl, test.wantHostname)
			}
			if env.timedatectl != test.wantTime {
				t.Errorf("timedatectl = %q, want %q", env.timedatectl, test.wantTime)
			}
		})
	}
}

func TestValidHostname(t *testing.T) {
	longLabel := strings.Repeat("a", 63)
	tooLongLabel := strings.Repeat("a", 64)
	maxName := strings.Repeat("a.", 31) + "ab" // 64 characters
	overMax := strings.Repeat("a.", 32) + "a"  // 65 characters

	tests := []struct {
		name     string
		hostname string
		want     bool
	}{
		{name: "simple", hostname: "new-host", want: true},
		{name: "single character", hostname: "a", want: true},
		{name: "fqdn", hostname: "host.example.com", want: true},
		{name: "uppercase", hostname: "Host-01.Example.COM", want: true},
		{name: "digits", hostname: "123", want: true},
		{name: "63 character label", hostname: longLabel, want: true},
		{name: "64 characters", hostname: maxName, want: true},
		{name: "empty", hostname: "", want: false},
		{name: "leading hyphen", hostname: "-host", want: false},
		{name: "leading hyphen in label", hostname: "host.-name", want: false},
		{name: "trailing hyphen", hostname: "host-", want: false},
		{name: "underscore", hostname: "host_name", want: false},
		{name: "space", hostname: "host name", want: false},
		{name: "slash", hostname: "host/name", want: false},
		{name: "leading dot", hostname: ".host", want: false},
		{name: "trailing dot", hostname: "host.", want: false},
		{name: "double dot", hostname: "host..name", want: false},
		{name: "unicode", hostname: "héllo", want: false},
		{name: "newline", hostname: "host\nname", want: false},
		{name: "64 character label", hostname: tooLongLabel, want: false},
		{name: "65 characters", hostname: overMax, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validHostname(test.hostname); got != test.want {
				t.Errorf("validHostname(%q) = %v, want %v", test.hostname, got, test.want)
			}
		})
	}
}

func TestValidTimezoneFormat(t *testing.T) {
	tests := []struct {
		name     string
		timezone string
		want     bool
	}{
		{name: "iana", timezone: "Asia/Shanghai", want: true},
		{name: "nested", timezone: "America/Argentina/Buenos_Aires", want: true},
		{name: "etc gmt offset", timezone: "Etc/GMT+5", want: true},
		{name: "utc", timezone: "UTC", want: true},
		{name: "empty", timezone: "", want: false},
		{name: "parent traversal", timezone: "../../etc/passwd", want: false},
		{name: "absolute", timezone: "/etc/passwd", want: false},
		{name: "leading hyphen", timezone: "-Asia/Shanghai", want: false},
		{name: "space", timezone: "Asia Shanghai", want: false},
		{name: "nul", timezone: "Asia\x00Shanghai", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validTimezoneFormat(test.timezone); got != test.want {
				t.Errorf("validTimezoneFormat(%q) = %v, want %v", test.timezone, got, test.want)
			}
		})
	}
}

func TestCollect(t *testing.T) {
	info := Collect()
	if info.Arch != runtime.GOARCH {
		t.Errorf("Arch = %q, want %q", info.Arch, runtime.GOARCH)
	}
	if info.LogicalCores != runtime.NumCPU() {
		t.Errorf("LogicalCores = %d, want %d", info.LogicalCores, runtime.NumCPU())
	}
	if info.Version != buildinfo.Version || info.Commit != buildinfo.Commit || info.BuildDate != buildinfo.Date {
		t.Errorf("build info = %q/%q/%q, want %q/%q/%q", info.Version, info.Commit, info.BuildDate, buildinfo.Version, buildinfo.Commit, buildinfo.Date)
	}
	if info.User == "" {
		t.Error("User is empty")
	}
	if info.Timezone == "" {
		t.Error("Timezone is empty")
	}
	for _, capability := range []struct {
		name   string
		set    bool
		reason string
	}{
		{name: "hostname", set: info.Capabilities.SetHostname, reason: info.Capabilities.HostnameReason},
		{name: "timezone", set: info.Capabilities.SetTimezone, reason: info.Capabilities.TimezoneReason},
	} {
		if capability.set && capability.reason != "" {
			t.Errorf("%s capability is available but has reason %q", capability.name, capability.reason)
		}
		if !capability.set && capability.reason == "" {
			t.Errorf("%s capability is unavailable without a reason", capability.name)
		}
	}
	if info.IsRoot != (os.Geteuid() == 0) {
		t.Errorf("IsRoot = %v", info.IsRoot)
	}
}
