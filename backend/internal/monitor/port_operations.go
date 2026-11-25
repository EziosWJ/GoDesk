package monitor

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"godesk/internal/services"

	"github.com/tklauser/go-sysconf"
	"golang.org/x/sys/unix"
)

const journalLines = 500

var errTargetChanged = errors.New("监听或进程已变化，请重新选择")

type portTarget struct {
	Endpoint
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
	Unit       string `json:"unit,omitempty"`
}

func (t portTarget) valid() bool {
	ip, err := netip.ParseAddr(t.Address)
	return err == nil && ip.Zone() == "" && (t.Protocol == "tcp" || t.Protocol == "udp") &&
		t.Port > 0 && t.Port <= 65535 && t.PID > 0 && (t.Unit == "" || services.ValidUnit(t.Unit))
}

func (t portTarget) resolve() (processRecord, error) {
	proc, err := readProcess(t.PID)
	if err != nil || proc.StartTicks != t.StartTicks {
		return processRecord{}, errTargetChanged
	}
	sockets, _, err := readPortSockets()
	if err != nil {
		return processRecord{}, err
	}
	for _, socket := range processSocketMatches(t.PID, sockets) {
		if socket.Endpoint == t.Endpoint {
			return proc, nil
		}
	}
	return processRecord{}, errTargetChanged
}

type portDetail struct {
	Tree       *ProcessNode `json:"tree"`
	Unit       string       `json:"unit,omitempty"`
	OtherPorts []Endpoint   `json:"otherPorts,omitempty"`
	StopsDesk  bool         `json:"stopsDesk,omitempty"`
}

func describePort(ctx context.Context, target portTarget, proc processRecord, serverPID int) (portDetail, error) {
	unit, group, err := owningService(ctx, target.PID)
	if err != nil {
		return portDetail{}, err
	}
	tree, err := processTree(ctx, proc)
	if err != nil {
		return portDetail{}, err
	}
	detail := portDetail{Tree: tree, Unit: unit, StopsDesk: target.PID == serverPID}
	if unit == "" {
		return detail, nil
	}

	deskGroup, _ := systemCgroup(serverPID)
	detail.StopsDesk = detail.StopsDesk || inCgroup(deskGroup, group)
	ports, err := ListPorts(ctx)
	if err != nil {
		return portDetail{}, err
	}
	membership := make(map[int]bool)
	for _, port := range ports {
		if port.Endpoint == target.Endpoint {
			continue
		}
		for _, owner := range port.Owners {
			belongs, seen := membership[owner.PID]
			if !seen {
				ownerGroup, _ := systemCgroup(owner.PID)
				belongs = inCgroup(ownerGroup, group)
				membership[owner.PID] = belongs
			}
			if belongs {
				detail.OtherPorts = append(detail.OtherPorts, port.Endpoint)
				break
			}
		}
	}
	return detail, nil
}

func systemCgroup(pid int) (string, error) {
	data, err := os.ReadFile(processFile(pid, "cgroup"))
	if err != nil {
		return "", err
	}
	var unified string
	for line := range strings.Lines(string(data)) {
		fields := strings.SplitN(strings.TrimSpace(line), ":", 3)
		if len(fields) != 3 {
			continue
		}
		if fields[1] == "name=systemd" {
			return fields[2], nil
		}
		if fields[0] == "0" && fields[1] == "" {
			unified = fields[2]
		}
	}
	return unified, nil
}

func inCgroup(path, group string) bool {
	return group != "" && (path == group || strings.HasPrefix(path, group+"/"))
}

func owningService(ctx context.Context, pid int) (string, string, error) {
	if _, err := os.Stat("/run/systemd/system"); os.IsNotExist(err) {
		return "", "", nil
	} else if err != nil {
		return "", "", err
	}
	group, err := systemCgroup(pid)
	if os.IsNotExist(err) {
		return "", "", errTargetChanged
	}
	if err != nil {
		return "", "", err
	}
	for segment := range strings.SplitSeq(strings.TrimPrefix(group, "/"), "/") {
		if !services.ValidUnit(segment) {
			continue
		}
		// The delegated user manager can contain its own services and scopes.
		// Stopping that manager would stop the entire user session.
		if strings.HasPrefix(segment, "user@") && !strings.HasSuffix(group, "/"+segment) {
			return "", "", nil
		}
		cmd := exec.CommandContext(ctx, "systemctl", "show", "--no-pager", "--value", "-p", "ControlGroup", "--", segment)
		output, err := cmd.Output()
		if err != nil {
			return "", "", fmt.Errorf("lookup systemd service %s: %w", segment, err)
		}
		path := strings.TrimSpace(string(output))
		if !inCgroup(group, path) {
			return "", "", errTargetChanged
		}
		return segment, path, nil
	}
	return "", "", nil
}

func stopPort(ctx context.Context, target portTarget) error {
	// Bind the signal to this process before reading /proc. A reused PID must
	// never turn this request into a signal to the replacement process.
	fd, err := unix.PidfdOpen(target.PID, 0)
	if errors.Is(err, unix.ESRCH) {
		return errTargetChanged
	}
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	if _, err := target.resolve(); err != nil {
		return err
	}
	unit, _, err := owningService(ctx, target.PID)
	if err != nil {
		return err
	}
	if unit != target.Unit {
		return errTargetChanged
	}
	if _, err := target.resolve(); err != nil {
		return err
	}

	if unit != "" {
		manager, err := services.Open("systemd")
		if err != nil {
			return err
		}
		return manager.Stop(ctx, unit)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := unix.PidfdSendSignal(fd, unix.SIGTERM, nil, 0); errors.Is(err, unix.ESRCH) {
		return errTargetChanged
	} else {
		return err
	}
}

func portLogs(ctx context.Context, target portTarget, unit string) ([]string, error) {
	args := []string{"-n", strconv.Itoa(journalLines), "--no-pager", "-o", "short-iso"}
	if unit != "" {
		args = append(args, "-u", unit)
	} else {
		startedAt, err := processStartTime(target.StartTicks)
		if err != nil {
			return nil, err
		}
		args = append(args, "-b", "--since", startedAt.Format("2006-01-02 15:04:05.000000 UTC"), "_PID="+strconv.Itoa(target.PID))
	}

	cmd := exec.CommandContext(ctx, "journalctl", args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	result := strings.TrimSuffix(string(output), "\n")
	if result == "" || result == "-- No entries --" {
		return []string{}, nil
	}
	lines := strings.Split(result, "\n")
	return lines[max(0, len(lines)-journalLines):], nil
}

func processStartTime(ticks uint64) (time.Time, error) {
	hz, err := sysconf.Sysconf(sysconf.SC_CLK_TCK)
	if err != nil {
		return time.Time{}, err
	}
	if hz <= 0 {
		return time.Time{}, errors.New("invalid process clock tick rate")
	}
	var uptime unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &uptime); err != nil {
		return time.Time{}, err
	}
	elapsed := time.Duration(ticks/uint64(hz))*time.Second + time.Duration(ticks%uint64(hz))*time.Second/time.Duration(hz)
	return time.Now().UTC().Add(elapsed - time.Duration(uptime.Nano())), nil
}
