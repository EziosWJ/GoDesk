package monitor

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

type Endpoint struct {
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     uint32 `json:"port"`
}

type Port struct {
	Endpoint
	Owners       []PortOwner `json:"owners"`
	UnknownOwner bool        `json:"unknownOwner,omitempty"`
}

type PortOwner struct {
	PID        int    `json:"pid"`
	Process    string `json:"process"`
	StartTicks uint64 `json:"startTicks"`
}

type portSocket struct {
	*Port
	found bool
}

// ListPorts joins listening sockets to every process with a matching /proc
// file descriptor, including sockets inherited by multiple workers.
func ListPorts(ctx context.Context) ([]Port, error) {
	sockets, groups, err := readPortSockets()
	if err != nil {
		return nil, err
	}

	pids, err := processIDs()
	if err != nil {
		return nil, err
	}
	for _, pid := range pids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		matches := processSocketMatches(pid, sockets)
		if len(matches) == 0 {
			continue
		}
		proc, err := readProcess(pid)
		if err != nil {
			continue
		}
		seen := make(map[*Port]bool)
		for _, socket := range matches {
			socket.found = true
			if !seen[socket.Port] {
				socket.Owners = append(socket.Owners, proc.PortOwner)
				seen[socket.Port] = true
			}
		}
	}

	for _, socket := range sockets {
		socket.UnknownOwner = socket.UnknownOwner || !socket.found
	}
	ports := make([]Port, 0, len(groups))
	for _, port := range groups {
		ports = append(ports, *port)
	}
	slices.SortFunc(ports, func(a, b Port) int {
		if a.Port != b.Port {
			return int(a.Port) - int(b.Port)
		}
		if a.Protocol != b.Protocol {
			return strings.Compare(a.Protocol, b.Protocol)
		}
		return strings.Compare(a.Address, b.Address)
	})
	return ports, nil
}

func readPortSockets() (map[string]*portSocket, map[Endpoint]*Port, error) {
	sockets := make(map[string]*portSocket)
	groups := make(map[Endpoint]*Port)
	for _, table := range []string{"tcp", "tcp6", "udp", "udp6"} {
		if err := readSocketTable(table, sockets, groups); err != nil {
			return nil, nil, err
		}
	}
	return sockets, groups, nil
}

func readSocketTable(table string, sockets map[string]*portSocket, groups map[Endpoint]*Port) error {
	file, err := os.Open("/proc/net/" + table)
	if err != nil {
		if os.IsNotExist(err) && strings.HasSuffix(table, "6") {
			return nil
		}
		return err
	}
	defer file.Close()

	protocol := strings.TrimSuffix(table, "6")
	scanner := bufio.NewScanner(file)
	scanner.Scan() // column headers
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || (protocol == "tcp" && fields[3] != "0A") {
			continue
		}
		address, port, err := parseLocalAddress(fields[1])
		if err != nil {
			return fmt.Errorf("read %s address: %w", table, err)
		}
		if port == 0 {
			continue
		}
		endpoint := Endpoint{Protocol: protocol, Address: address, Port: port}
		group := groups[endpoint]
		if group == nil {
			group = &Port{Endpoint: endpoint, Owners: []PortOwner{}}
			groups[endpoint] = group
		}
		if fields[9] == "0" {
			group.UnknownOwner = true
			continue
		}
		sockets[fields[9]] = &portSocket{Port: group}
	}
	return scanner.Err()
}

func parseLocalAddress(value string) (string, uint32, error) {
	addrHex, portHex, _ := strings.Cut(value, ":")
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return "", 0, err
	}
	raw, err := hex.DecodeString(addrHex)
	if err != nil {
		return "", 0, err
	}
	if len(raw) != 4 && len(raw) != 16 {
		return "", 0, fmt.Errorf("invalid IP address width")
	}
	for offset := 0; offset < len(raw); offset += 4 {
		word := raw[offset : offset+4]
		binary.NativeEndian.PutUint32(word, binary.BigEndian.Uint32(word))
	}
	addr, _ := netip.AddrFromSlice(raw)
	return addr.String(), uint32(port), nil
}

func processSocketMatches(pid int, sockets map[string]*portSocket) []*portSocket {
	path := processFile(pid, "fd")
	fds, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	var matches []*portSocket
	for _, fd := range fds {
		link, err := os.Readlink(filepath.Join(path, fd.Name()))
		if err != nil || !strings.HasPrefix(link, "socket:[") || !strings.HasSuffix(link, "]") {
			continue
		}
		if socket := sockets[link[len("socket:["):len(link)-1]]; socket != nil {
			matches = append(matches, socket)
		}
	}
	return matches
}
