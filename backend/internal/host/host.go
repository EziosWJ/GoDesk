// Package host reports read-only host and runtime information and applies
// hostname and timezone changes through systemd.
package host

import (
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"time"

	"godesk/internal/buildinfo"
)

const (
	osReleasePath  = "/etc/os-release"
	cpuInfoPath    = "/proc/cpuinfo"
	memInfoPath    = "/proc/meminfo"
	uptimePath     = "/proc/uptime"
	kernelPath     = "/proc/sys/kernel/osrelease"
	timezonePath   = "/etc/timezone"
	localtimePath  = "/etc/localtime"
	systemdRunPath = "/run/systemd/system"

	reasonSystemdUnavailable = "systemd_unavailable"
	reasonUnsupported        = "unsupported"
)

// Info is the read-only host and runtime description returned by
// GET /api/v1/system/host.
type Info struct {
	Hostname         string       `json:"hostname"`
	Timezone         string       `json:"timezone"`
	OS               string       `json:"os"`
	Kernel           string       `json:"kernel"`
	Arch             string       `json:"arch"`
	CPUModel         string       `json:"cpuModel"`
	LogicalCores     int          `json:"logicalCores"`
	MemoryTotalBytes uint64       `json:"memoryTotalBytes"`
	UptimeSeconds    int64        `json:"uptimeSeconds"`
	Version          string       `json:"version"`
	Commit           string       `json:"commit"`
	BuildDate        string       `json:"buildDate"`
	User             string       `json:"user"`
	IsRoot           bool         `json:"isRoot"`
	Capabilities     Capabilities `json:"capabilities"`
}

// Capabilities reports whether hostname and timezone changes are supported.
// An empty reason means the operation is available.
type Capabilities struct {
	SetHostname    bool   `json:"setHostname"`
	SetTimezone    bool   `json:"setTimezone"`
	HostnameReason string `json:"hostnameReason"`
	TimezoneReason string `json:"timezoneReason"`
}

// environment bundles the capability flags with the tool paths used to run
// the privileged commands.
type environment struct {
	capabilities Capabilities
	hostnamectl  string
	timedatectl  string
}

// Collect reads the current host and runtime information. Failures to read a
// single source leave that field empty instead of failing the whole snapshot.
func Collect() Info {
	env := detectEnvironment()
	return Info{
		Hostname:         currentHostname(),
		Timezone:         detectTimezone(os.ReadFile, os.Readlink),
		OS:               parseOSRelease(readFile(osReleasePath)),
		Kernel:           strings.TrimSpace(string(readFile(kernelPath))),
		Arch:             runtime.GOARCH,
		CPUModel:         parseCPUModel(readFile(cpuInfoPath)),
		LogicalCores:     runtime.NumCPU(),
		MemoryTotalBytes: parseMemTotal(readFile(memInfoPath)),
		UptimeSeconds:    parseUptime(readFile(uptimePath)),
		Version:          buildinfo.Version,
		Commit:           buildinfo.Commit,
		BuildDate:        buildinfo.Date,
		User:             currentUser(),
		IsRoot:           os.Geteuid() == 0,
		Capabilities:     env.capabilities,
	}
}

func readFile(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return data
}

func currentHostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func currentUser() string {
	account, err := user.Current()
	if err != nil || account.Username == "" {
		return strconv.Itoa(os.Geteuid())
	}
	return account.Username
}

// detectEnvironment probes the host tools without running them.
func detectEnvironment() environment {
	return inspectEnvironment(exec.LookPath, systemdRunning())
}

func inspectEnvironment(lookPath func(string) (string, error), systemd bool) environment {
	env := environment{}
	if !systemd {
		env.capabilities.HostnameReason = reasonSystemdUnavailable
		env.capabilities.TimezoneReason = reasonSystemdUnavailable
		return env
	}
	if path, err := lookPath("hostnamectl"); err == nil {
		env.hostnamectl = path
		env.capabilities.SetHostname = true
	} else {
		env.capabilities.HostnameReason = reasonUnsupported
	}
	if path, err := lookPath("timedatectl"); err == nil {
		env.timedatectl = path
		env.capabilities.SetTimezone = true
	} else {
		env.capabilities.TimezoneReason = reasonUnsupported
	}
	return env
}

// systemdRunning uses the marker directory systemd creates at boot. WSL and
// containers without systemd do not have it.
func systemdRunning() bool {
	info, err := os.Stat(systemdRunPath)
	return err == nil && info.IsDir()
}

// parseOSRelease extracts PRETTY_NAME, falling back to NAME and VERSION, from
// /etc/os-release.
func parseOSRelease(data []byte) string {
	values := make(map[string]string)
	for line := range strings.Lines(string(data)) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	if pretty := strings.TrimSpace(values["PRETTY_NAME"]); pretty != "" {
		return pretty
	}
	name := strings.TrimSpace(values["NAME"])
	if name == "" {
		return ""
	}
	return strings.TrimSpace(name + " " + strings.TrimSpace(values["VERSION"]))
}

// parseCPUModel extracts the first model name from /proc/cpuinfo. ARM kernels
// expose Hardware or Model instead.
func parseCPUModel(data []byte) string {
	var hardware, model string
	for line := range strings.Lines(string(data)) {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "model name":
			if value != "" {
				return value
			}
		case "Hardware":
			if hardware == "" {
				hardware = value
			}
		case "Model":
			if model == "" {
				model = value
			}
		}
	}
	if hardware != "" {
		return hardware
	}
	return model
}

// parseMemTotal returns MemTotal from /proc/meminfo in bytes.
func parseMemTotal(data []byte) uint64 {
	for line := range strings.Lines(string(data)) {
		value, ok := strings.CutPrefix(strings.TrimSpace(line), "MemTotal:")
		if !ok {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			return 0
		}
		kibibytes, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return 0
		}
		return kibibytes * 1024
	}
	return 0
}

// parseUptime returns the whole seconds in the first field of /proc/uptime.
func parseUptime(data []byte) int64 {
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || seconds < 0 {
		return 0
	}
	return int64(seconds)
}

// detectTimezone prefers /etc/timezone and resolves the /etc/localtime
// symlink next. It falls back to the runtime zone name so the field is always
// present.
func detectTimezone(readFile func(string) ([]byte, error), readlink func(string) (string, error)) string {
	if data, err := readFile(timezonePath); err == nil {
		if zone := parseTimezone(data); zone != "" {
			return zone
		}
	}
	if target, err := readlink(localtimePath); err == nil {
		if zone := timezoneFromLocaltime(target); zone != "" {
			return zone
		}
	}
	if name, _ := time.Now().Zone(); name != "" {
		return name
	}
	return "UTC"
}

// parseTimezone validates the single-line IANA name stored in /etc/timezone.
func parseTimezone(data []byte) string {
	zone := strings.TrimSpace(string(data))
	return cleanZonePath(zone)
}

// timezoneFromLocaltime extracts the IANA zone from a /etc/localtime symlink
// target such as /usr/share/zoneinfo/Asia/Shanghai.
func timezoneFromLocaltime(target string) string {
	const marker = "/usr/share/zoneinfo/"
	index := strings.Index(strings.TrimSpace(target), marker)
	if index < 0 {
		return ""
	}
	return cleanZonePath(strings.TrimSpace(target)[index+len(marker):])
}

// cleanZonePath rejects values that could escape the zoneinfo tree or be read
// as command options.
func cleanZonePath(zone string) string {
	if zone == "" || len(zone) > 255 {
		return ""
	}
	if strings.HasPrefix(zone, "/") || strings.HasPrefix(zone, "-") || strings.Contains(zone, "..") {
		return ""
	}
	for _, char := range zone {
		switch {
		case char >= 'A' && char <= 'Z', char >= 'a' && char <= 'z', char >= '0' && char <= '9':
		case char == '/', char == '_', char == '-', char == '+':
		default:
			return ""
		}
	}
	return zone
}
