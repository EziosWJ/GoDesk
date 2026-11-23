package monitor

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"syscall"

	gnet "github.com/shirou/gopsutil/v4/net"
)

type Port struct {
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     uint32 `json:"port"`
	PID      int32  `json:"pid,omitempty"`
	Process  string `json:"process,omitempty"`
}

// ListPorts returns TCP listeners and bound UDP sockets for the host network
// namespace. The process owner is included when the running account is allowed
// to discover it.
func ListPorts(ctx context.Context) ([]Port, error) {
	connections, err := gnet.ConnectionsWithContext(ctx, "all")
	if err != nil {
		return nil, err
	}

	ports := make([]Port, 0, len(connections))
	type key struct {
		protocol string
		address  string
		port     uint32
		pid      int32
	}
	seen := make(map[key]struct{}, len(connections))
	names := make(map[int32]string)

	for _, connection := range connections {
		if connection.Family != uint32(syscall.AF_INET) && connection.Family != uint32(syscall.AF_INET6) {
			continue
		}
		var protocol string
		switch connection.Type {
		case uint32(syscall.SOCK_STREAM):
			if connection.Status != "LISTEN" {
				continue
			}
			protocol = "tcp"
		case uint32(syscall.SOCK_DGRAM):
			protocol = "udp"
		default:
			continue
		}
		if connection.Laddr.Port == 0 {
			continue
		}

		port := Port{
			Protocol: protocol,
			Address:  connection.Laddr.IP,
			Port:     connection.Laddr.Port,
			PID:      connection.Pid,
		}
		if port.PID > 0 {
			port.Process = processName(port.PID, names)
		}
		identity := key{protocol: port.Protocol, address: port.Address, port: port.Port, pid: port.PID}
		if _, ok := seen[identity]; ok {
			continue
		}
		seen[identity] = struct{}{}
		ports = append(ports, port)
	}

	sort.Slice(ports, func(i, j int) bool {
		if ports[i].Port != ports[j].Port {
			return ports[i].Port < ports[j].Port
		}
		if ports[i].Protocol != ports[j].Protocol {
			return ports[i].Protocol < ports[j].Protocol
		}
		if ports[i].Address != ports[j].Address {
			return ports[i].Address < ports[j].Address
		}
		return ports[i].PID < ports[j].PID
	})
	return ports, nil
}

func processName(pid int32, cache map[int32]string) string {
	if name, ok := cache[pid]; ok {
		return name
	}
	name := ""
	if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid)); err == nil {
		name = strings.TrimSpace(string(data))
	}
	cache[pid] = name
	return name
}
