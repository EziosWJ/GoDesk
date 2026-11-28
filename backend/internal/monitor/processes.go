package monitor

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/tklauser/go-sysconf"
)

const (
	processCPUMaxAge = 60 * time.Second
	defaultClockTick = 100
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

// procStat holds the lightweight fields available from /proc/<pid>/stat.
type procStat struct {
	pid        int
	name       string
	state      string
	parent     int
	ticks      uint64
	startTicks uint64
	threads    int
	rssPages   int64
}

func readProcStat(pid int) (procStat, error) {
	data, err := os.ReadFile(processFile(pid, "stat"))
	if err != nil {
		return procStat{}, err
	}
	return parseProcStat(pid, string(data))
}

func parseProcStat(pid int, value string) (procStat, error) {
	open, close := strings.IndexByte(value, '('), strings.LastIndexByte(value, ')')
	if open < 0 || close <= open {
		return procStat{}, fmt.Errorf("invalid process stat for PID %d", pid)
	}
	fields := strings.Fields(value[close+1:])
	// state, ppid, ... utime, stime, ... num_threads, ... starttime, vsize, rss
	if len(fields) < 22 {
		return procStat{}, fmt.Errorf("incomplete process stat for PID %d", pid)
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return procStat{}, err
	}
	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	threads, err := strconv.Atoi(fields[17])
	if err != nil {
		return procStat{}, err
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	rss, err := strconv.ParseInt(fields[21], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	if rss < 0 {
		rss = 0
	}
	return procStat{
		pid:        pid,
		name:       value[open+1 : close],
		state:      fields[0],
		parent:     parent,
		ticks:      utime + stime,
		startTicks: start,
		threads:    threads,
		rssPages:   rss,
	}, nil
}

func parseProcessStat(pid int, value string) (processRecord, error) {
	stat, err := parseProcStat(pid, value)
	if err != nil {
		return processRecord{}, err
	}
	return processRecord{
		PortOwner: PortOwner{PID: pid, Process: stat.name, StartTicks: stat.startTicks},
		parent:    stat.parent,
	}, nil
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

// ProcessInfo is one row of the on-demand process list. CPUPercent is measured
// against the previous list request; the first request reports zero.
type ProcessInfo struct {
	PID        int     `json:"pid"`
	PPID       int     `json:"ppid"`
	StartTicks uint64  `json:"startTicks"`
	Name       string  `json:"name"`
	State      string  `json:"state"`
	User       string  `json:"user"`
	CPUPercent float64 `json:"cpuPercent"`
	RSSBytes   uint64  `json:"rssBytes"`
}

type ProcessList struct {
	CollectedAt   time.Time     `json:"collectedAt"`
	SelfPID       int           `json:"selfPid"`
	ProtectedPIDs []int         `json:"protectedPids"`
	Total         int           `json:"total"`
	Processes     []ProcessInfo `json:"processes"`
}

type ProcessDetail struct {
	PID              int          `json:"pid"`
	PPID             int          `json:"ppid"`
	StartTicks       uint64       `json:"startTicks"`
	Name             string       `json:"name"`
	State            string       `json:"state"`
	User             string       `json:"user"`
	RSSBytes         uint64       `json:"rssBytes"`
	Cmdline          []string     `json:"cmdline"`
	CWD              string       `json:"cwd"`
	StartedAt        time.Time    `json:"startedAt"`
	Threads          int          `json:"threads"`
	Tree             *ProcessNode `json:"tree"`
	IsProtected      bool         `json:"isProtected"`
	IsSelfOrAncestor bool         `json:"isSelfOrAncestor"`
}

type processKey struct {
	pid        int
	startTicks uint64
}

type procSample struct {
	pid        int
	parent     int
	startTicks uint64
	name       string
	state      string
	user       string
	ticks      uint64
	rssBytes   uint64
}

// listProcesses scans /proc only when called. The CPU cache is updated from
// this scan so the next request can compute deltas, but no background poller
// ever touches process state.
func (c *Collector) listProcesses(ctx context.Context) (ProcessList, error) {
	c.processMu.Lock()
	defer c.processMu.Unlock()

	samples, err := scanProcessSamples(ctx)
	if err != nil {
		return ProcessList{}, err
	}
	now := time.Now().UTC()
	hz := clockTickRate()
	cores := runtime.NumCPU()
	if cores < 1 {
		cores = 1
	}

	previous := c.processTicks
	if previous == nil || c.processAt.IsZero() || now.Sub(c.processAt) > processCPUMaxAge {
		previous = nil
	}
	infos := buildProcessInfos(samples, previous, c.processAt, now, hz, cores)

	ticks := make(map[processKey]uint64, len(samples))
	for _, sample := range samples {
		ticks[processKey{pid: sample.pid, startTicks: sample.startTicks}] = sample.ticks
	}
	c.processTicks, c.processAt = ticks, now

	self := os.Getpid()
	return ProcessList{
		CollectedAt:   now,
		SelfPID:       self,
		ProtectedPIDs: protectedProcessIDs(samples, self),
		Processes:     infos,
	}, nil
}

func scanProcessSamples(ctx context.Context) ([]procSample, error) {
	pids, err := processIDs()
	if err != nil {
		return nil, err
	}
	users := make(map[uint32]string)
	pageSize := uint64(os.Getpagesize())
	samples := make([]procSample, 0, len(pids))
	for _, pid := range pids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		stat, err := readProcStat(pid)
		if err != nil {
			continue
		}
		samples = append(samples, procSample{
			pid:        pid,
			parent:     stat.parent,
			startTicks: stat.startTicks,
			name:       stat.name,
			state:      stat.state,
			user:       processOwner(pid, users),
			ticks:      stat.ticks,
			rssBytes:   uint64(stat.rssPages) * pageSize,
		})
	}
	return samples, nil
}

// processOwner resolves the process owner from the /proc/<pid> directory rather
// than reading /proc/<pid>/status on every list scan.
func processOwner(pid int, users map[uint32]string) string {
	info, err := os.Stat(processFile(pid, ""))
	if err != nil {
		return ""
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	uid := stat.Uid
	if name, ok := users[uid]; ok {
		return name
	}
	name := strconv.FormatUint(uint64(uid), 10)
	if account, err := user.LookupId(name); err == nil {
		name = account.Username
	}
	users[uid] = name
	return name
}

func buildProcessInfos(samples []procSample, previous map[processKey]uint64, previousAt, now time.Time, hz uint64, cores int) []ProcessInfo {
	infos := make([]ProcessInfo, 0, len(samples))
	elapsed := now.Sub(previousAt).Seconds()
	for _, sample := range samples {
		percent := 0.0
		if previous != nil && elapsed > 0 {
			if old, ok := previous[processKey{pid: sample.pid, startTicks: sample.startTicks}]; ok && sample.ticks >= old {
				percent = processCPUPercent(sample.ticks-old, elapsed, hz, cores)
			}
		}
		infos = append(infos, ProcessInfo{
			PID:        sample.pid,
			PPID:       sample.parent,
			StartTicks: sample.startTicks,
			Name:       sample.name,
			State:      sample.state,
			User:       sample.user,
			CPUPercent: percent,
			RSSBytes:   sample.rssBytes,
		})
	}
	return infos
}

func processCPUPercent(deltaTicks uint64, elapsed float64, hz uint64, cores int) float64 {
	if elapsed <= 0 || hz == 0 || cores < 1 {
		return 0
	}
	budget := elapsed * float64(hz) * float64(cores)
	if budget <= 0 {
		return 0
	}
	percent := float64(deltaTicks) / budget * 100
	if percent > 100 {
		return 100
	}
	return percent
}

func filterProcesses(processes []ProcessInfo, query string) []ProcessInfo {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return processes
	}
	filtered := make([]ProcessInfo, 0, len(processes))
	for _, process := range processes {
		if strings.Contains(strings.ToLower(process.Name), query) ||
			strings.Contains(strings.ToLower(process.User), query) ||
			strings.Contains(strconv.Itoa(process.PID), query) {
			filtered = append(filtered, process)
		}
	}
	return filtered
}

func sortProcesses(processes []ProcessInfo, key, order string) {
	slices.SortFunc(processes, func(a, b ProcessInfo) int {
		var result int
		switch key {
		case "memory":
			result = cmp.Compare(a.RSSBytes, b.RSSBytes)
		case "pid":
			result = cmp.Compare(a.PID, b.PID)
		case "name":
			result = cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
		default:
			result = cmp.Compare(a.CPUPercent, b.CPUPercent)
		}
		if result == 0 {
			result = cmp.Compare(a.PID, b.PID)
		}
		if order == "desc" {
			return -result
		}
		return result
	})
}

func defaultProcessOrder(key string) string {
	if key == "pid" || key == "name" {
		return "asc"
	}
	return "desc"
}

func validProcessSort(key string) bool {
	switch key {
	case "cpu", "memory", "pid", "name":
		return true
	default:
		return false
	}
}

func protectedProcessIDs(samples []procSample, self int) []int {
	byPID := make(map[int]procSample, len(samples))
	for _, sample := range samples {
		byPID[sample.pid] = sample
	}
	protected := map[int]bool{1: true}
	for pid := self; pid > 0 && !protected[pid]; {
		protected[pid] = true
		sample, ok := byPID[pid]
		if !ok {
			break
		}
		pid = sample.parent
	}
	ids := make([]int, 0, len(protected))
	for id := range protected {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (c *Collector) describeProcess(ctx context.Context, pid int, startTicks *uint64) (ProcessDetail, error) {
	stat, err := readProcStat(pid)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) {
			return ProcessDetail{}, errProcessNotFound
		}
		return ProcessDetail{}, err
	}
	if startTicks != nil && *startTicks != stat.startTicks {
		return ProcessDetail{}, errProcessChanged
	}

	detail := ProcessDetail{
		PID:              pid,
		PPID:             stat.parent,
		StartTicks:       stat.startTicks,
		Name:             stat.name,
		State:            stat.state,
		User:             processOwner(pid, map[uint32]string{}),
		RSSBytes:         uint64(stat.rssPages) * uint64(os.Getpagesize()),
		Cmdline:          processCmdline(pid),
		CWD:              processCWD(pid),
		Threads:          stat.threads,
		IsProtected:      pid == 1,
		IsSelfOrAncestor: selfAndAncestors()[pid],
	}
	if startedAt, err := processStartTime(stat.startTicks); err == nil {
		detail.StartedAt = startedAt
	}

	tree, err := processTree(ctx, processRecord{
		PortOwner: PortOwner{PID: pid, Process: stat.name, StartTicks: stat.startTicks},
		parent:    stat.parent,
	})
	if err != nil {
		if errors.Is(err, errTargetChanged) {
			return ProcessDetail{}, errProcessChanged
		}
		return ProcessDetail{}, err
	}
	detail.Tree = tree
	return detail, nil
}

func processCmdline(pid int) []string {
	data, err := os.ReadFile(processFile(pid, "cmdline"))
	if err != nil {
		return []string{}
	}
	parts := strings.Split(string(data), "\x00")
	for len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func processCWD(pid int) string {
	cwd, err := os.Readlink(processFile(pid, "cwd"))
	if err != nil {
		return ""
	}
	return cwd
}

func selfAndAncestors() map[int]bool {
	chain := make(map[int]bool)
	for pid := os.Getpid(); pid > 0 && !chain[pid]; {
		chain[pid] = true
		stat, err := readProcStat(pid)
		if err != nil {
			break
		}
		pid = stat.parent
	}
	return chain
}

func clockTickRate() uint64 {
	hz, err := sysconf.Sysconf(sysconf.SC_CLK_TCK)
	if err != nil || hz <= 0 {
		return defaultClockTick
	}
	return uint64(hz)
}
