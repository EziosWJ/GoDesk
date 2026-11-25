package monitor

import (
	"context"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

type ProcessNode struct {
	PortOwner
	User     string         `json:"user"`
	Children []*ProcessNode `json:"children,omitempty"`
}

type processRecord struct {
	PortOwner
	parent int
}

func processIDs() ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, entry := range entries {
		if pid, err := strconv.Atoi(entry.Name()); entry.IsDir() && err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	slices.Sort(pids)
	return pids, nil
}

func processFile(pid int, name string) string {
	return filepath.Join("/proc", strconv.Itoa(pid), name)
}

func readProcess(pid int) (processRecord, error) {
	data, err := os.ReadFile(processFile(pid, "stat"))
	if err != nil {
		return processRecord{}, err
	}
	return parseProcessStat(pid, string(data))
}

func parseProcessStat(pid int, value string) (processRecord, error) {
	open, close := strings.IndexByte(value, '('), strings.LastIndexByte(value, ')')
	if open < 0 || close <= open {
		return processRecord{}, fmt.Errorf("invalid process stat for PID %d", pid)
	}
	fields := strings.Fields(value[close+1:])
	if len(fields) < 20 {
		return processRecord{}, fmt.Errorf("incomplete process stat for PID %d", pid)
	}
	parent, err := strconv.Atoi(fields[1]) // ppid, field 4
	if err != nil {
		return processRecord{}, err
	}
	start, err := strconv.ParseUint(fields[19], 10, 64) // starttime, field 22
	if err != nil {
		return processRecord{}, err
	}
	return processRecord{PortOwner: PortOwner{PID: pid, Process: value[open+1 : close], StartTicks: start}, parent: parent}, nil
}

func processTree(ctx context.Context, target processRecord) (*ProcessNode, error) {
	pids, err := processIDs()
	if err != nil {
		return nil, err
	}
	records := make(map[int]processRecord, len(pids))
	children := make(map[int][]int)
	for _, pid := range pids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if proc, err := readProcess(pid); err == nil {
			records[pid] = proc
			children[proc.parent] = append(children[proc.parent], pid)
		}
	}
	current, ok := records[target.PID]
	if !ok || current.StartTicks != target.StartTicks {
		return nil, errTargetChanged
	}

	users := make(map[string]string)
	buildNode := func(proc processRecord) *ProcessNode {
		return &ProcessNode{PortOwner: proc.PortOwner, User: processUser(proc.PID, users)}
	}
	visited := make(map[int]bool)
	var descendants func(processRecord) *ProcessNode
	descendants = func(proc processRecord) *ProcessNode {
		visited[proc.PID] = true
		node := buildNode(proc)
		for _, pid := range children[proc.PID] {
			child := records[pid]
			if !visited[pid] && child.StartTicks >= proc.StartTicks {
				node.Children = append(node.Children, descendants(child))
			}
		}
		return node
	}
	root := descendants(current)
	for current.parent > 0 && !visited[current.parent] {
		parent, ok := records[current.parent]
		if !ok || parent.StartTicks > current.StartTicks {
			break
		}
		visited[parent.PID] = true
		node := buildNode(parent)
		node.Children = []*ProcessNode{root}
		root = node
		current = parent
	}
	return root, nil
}

func processUser(pid int, users map[string]string) string {
	status, err := os.ReadFile(processFile(pid, "status"))
	if err != nil {
		return ""
	}
	for line := range strings.Lines(string(status)) {
		value, ok := strings.CutPrefix(line, "Uid:")
		fields := strings.Fields(value)
		if !ok || len(fields) < 2 {
			continue
		}
		uid := fields[1]
		if name, ok := users[uid]; ok {
			return name
		}
		name := uid
		if account, err := user.LookupId(uid); err == nil {
			name = account.Username
		}
		users[uid] = name
		return name
	}
	return ""
}
