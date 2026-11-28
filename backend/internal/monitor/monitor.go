package monitor

import (
	"bufio"
	"context"
	"errors"
	"io"
	"math"
	"net"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
)

// DefaultInterval is the default period between metric samples.
const DefaultInterval = time.Second

const historySize = 60

type CPUStat struct {
	Percent float64   `json:"percent"`
	PerCore []float64 `json:"perCore"`
}

type MemoryStat struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
}

type DiskStat struct {
	Mountpoint       string   `json:"mountpoint"`
	Total            uint64   `json:"total"`
	Used             uint64   `json:"used"`
	Percent          float64  `json:"percent"`
	InodeUsedPercent *float64 `json:"inodeUsedPercent"`
	// Available is the free space reported by the filesystem. It is used by
	// the health engine and not part of the metrics JSON contract.
	Available uint64 `json:"-"`
}

type NetworkStat struct {
	Name           string   `json:"name"`
	MAC            string   `json:"mac"`
	IPv4           []string `json:"ipv4"`
	IPv6           []string `json:"ipv6"`
	RxRate         float64  `json:"rxRate"`
	TxRate         float64  `json:"txRate"`
	LinkUp         bool     `json:"linkUp"`
	IsDefaultRoute bool     `json:"isDefaultRoute"`
}

type NetworkSeries struct {
	Name string    `json:"name"`
	Rx   []float64 `json:"rx"`
	Tx   []float64 `json:"tx"`
}

type Series struct {
	CPU     []float64       `json:"cpu"`
	Memory  []float64       `json:"memory"`
	Network []NetworkSeries `json:"network"`
}

// Collection describes facts about a sample that the health engine needs but
// that are not part of the metrics JSON contract.
type Collection struct {
	CPUFailed         bool
	MemoryFailed      bool
	DisksFailed       bool
	NetworkFailed     bool
	LoadFailed        bool
	SwapFailed        bool
	DiskIOFailed      bool
	FailedMountpoints []string
}

type Snapshot struct {
	SampledAt  time.Time     `json:"sampledAt"`
	Platform   string        `json:"platform"`
	CPU        *CPUStat      `json:"cpu"`
	Load       *LoadStat     `json:"load"`
	Memory     *MemoryStat   `json:"memory"`
	Swap       *SwapStat     `json:"swap"`
	Disks      []DiskStat    `json:"disks"`
	DiskIO     *DiskIOStat   `json:"diskIO"`
	Network    []NetworkStat `json:"network"`
	Series     Series        `json:"series"`
	Collection Collection    `json:"-"`
}

type sample struct {
	takenAt    time.Time
	cpu        *CPUStat
	load       *LoadStat
	memory     *MemoryStat
	swap       *SwapStat
	disks      []DiskStat
	diskIO     *DiskIOStat
	network    []NetworkStat
	collection Collection
}

type counters struct {
	rx uint64
	tx uint64
}

type Collector struct {
	interval time.Duration
	platform string

	mu      sync.RWMutex
	samples []sample

	previous     map[string]counters
	previousTime time.Time

	swapPrevious swapCounters
	swapTime     time.Time

	diskIOPrevious map[string]diskIOCounters
	diskIOTime     time.Time

	processMu    sync.Mutex
	processTicks map[processKey]uint64
	processAt    time.Time

	cancel    context.CancelFunc
	done      chan struct{}
	started   bool
	closeOnce sync.Once
}

func newCollector(interval time.Duration) *Collector {
	if interval <= 0 {
		interval = DefaultInterval
	}
	return &Collector{
		interval: interval,
		platform: platformName(),
		previous: make(map[string]counters),
		done:     make(chan struct{}),
	}
}

// Start begins collecting metrics immediately and then at the given interval.
// Close stops collection and waits for the current sample to finish.
func Start(ctx context.Context, interval time.Duration) *Collector {
	collector := newCollector(interval)
	child, cancel := context.WithCancel(ctx)
	collector.cancel = cancel
	collector.collect(child)
	collector.started = true
	go collector.run(child)
	return collector
}

func (c *Collector) run(ctx context.Context) {
	defer close(c.done)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.collect(ctx)
		}
	}
}

// Close is safe to call more than once.
func (c *Collector) Close() {
	c.closeOnce.Do(func() {
		if c.cancel != nil {
			c.cancel()
		}
		if c.started {
			<-c.done
		}
	})
}

// Snapshot returns the latest sample and the retained series.
// The second result is false until the first sample has been collected.
func (c *Collector) Snapshot() (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.samples) == 0 {
		return Snapshot{}, false
	}

	last := c.samples[len(c.samples)-1]
	collection := last.collection
	collection.FailedMountpoints = append([]string{}, collection.FailedMountpoints...)
	snapshot := Snapshot{
		SampledAt:  last.takenAt,
		Platform:   c.platform,
		Disks:      append([]DiskStat{}, last.disks...),
		Network:    append([]NetworkStat{}, last.network...),
		Collection: collection,
		Series: Series{
			CPU:     make([]float64, 0, len(c.samples)),
			Memory:  make([]float64, 0, len(c.samples)),
			Network: make([]NetworkSeries, 0, len(last.network)),
		},
	}
	if last.cpu != nil {
		value := *last.cpu
		value.PerCore = append([]float64{}, value.PerCore...)
		snapshot.CPU = &value
	}
	if last.load != nil {
		value := *last.load
		snapshot.Load = &value
	}
	if last.memory != nil {
		value := *last.memory
		snapshot.Memory = &value
	}
	if last.swap != nil {
		value := *last.swap
		snapshot.Swap = &value
	}
	if last.diskIO != nil {
		value := *last.diskIO
		value.Devices = append([]DiskIODevice{}, value.Devices...)
		snapshot.DiskIO = &value
	}

	var lastCPU, lastMemory float64
	for _, current := range c.samples {
		if current.cpu != nil {
			lastCPU = current.cpu.Percent
		}
		if current.memory != nil {
			lastMemory = current.memory.Percent
		}
		snapshot.Series.CPU = append(snapshot.Series.CPU, lastCPU)
		snapshot.Series.Memory = append(snapshot.Series.Memory, lastMemory)
	}

	for _, nic := range last.network {
		series := NetworkSeries{
			Name: nic.Name,
			Rx:   make([]float64, 0, len(c.samples)),
			Tx:   make([]float64, 0, len(c.samples)),
		}
		var lastRx, lastTx float64
		for _, current := range c.samples {
			for _, candidate := range current.network {
				if candidate.Name == nic.Name {
					lastRx, lastTx = candidate.RxRate, candidate.TxRate
					break
				}
			}
			series.Rx = append(series.Rx, lastRx)
			series.Tx = append(series.Tx, lastTx)
		}
		snapshot.Series.Network = append(snapshot.Series.Network, series)
	}

	return snapshot, true
}

func (c *Collector) collect(ctx context.Context) {
	current := sample{takenAt: time.Now().UTC()}
	if stat, err := collectCPU(ctx); err == nil {
		current.cpu = stat
	} else {
		current.collection.CPUFailed = true
	}
	if stat, err := collectLoad(); err == nil {
		current.load = stat
	} else {
		current.collection.LoadFailed = true
	}
	if stat, err := collectMemory(ctx); err == nil {
		current.memory = stat
	} else {
		current.collection.MemoryFailed = true
	}
	if stat, previous, previousTime, err := collectSwap(current.takenAt, c.swapPrevious, c.swapTime); err == nil {
		current.swap = stat
		c.swapPrevious, c.swapTime = previous, previousTime
	} else {
		current.collection.SwapFailed = true
	}

	disks, failedMounts, err := collectDisks(ctx)
	if err != nil {
		current.collection.DisksFailed = true
	} else {
		current.disks = disks
		current.collection.FailedMountpoints = failedMounts
	}

	if stat, previous, previousTime, err := collectDiskIO(current.takenAt, c.diskIOPrevious, c.diskIOTime); err == nil {
		current.diskIO = stat
		c.diskIOPrevious, c.diskIOTime = previous, previousTime
	} else {
		current.collection.DiskIOFailed = true
	}

	network, previous, previousTime, networkFailed := collectNetwork(ctx, c.previous, c.previousTime, current.takenAt)
	current.network = network
	current.collection.NetworkFailed = networkFailed
	c.previous, c.previousTime = previous, previousTime

	c.mu.Lock()
	c.samples = append(c.samples, current)
	if len(c.samples) > historySize {
		c.samples = c.samples[len(c.samples)-historySize:]
	}
	c.mu.Unlock()
}

func collectCPU(ctx context.Context) (*CPUStat, error) {
	perCore, err := cpu.PercentWithContext(ctx, 0, true)
	if err != nil {
		return nil, err
	}
	if len(perCore) == 0 {
		return nil, errors.New("no CPU data")
	}
	var total float64
	for _, value := range perCore {
		total += value
	}
	return &CPUStat{Percent: total / float64(len(perCore)), PerCore: perCore}, nil
}

func collectMemory(ctx context.Context) (*MemoryStat, error) {
	stat, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, err
	}
	if stat.Total == 0 {
		return nil, errors.New("no memory data")
	}
	return &MemoryStat{Total: stat.Total, Used: stat.Used, Available: stat.Available, Percent: stat.UsedPercent}, nil
}

type failedMount struct {
	device     string
	mountpoint string
}

func collectDisks(ctx context.Context) ([]DiskStat, []string, error) {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	byDevice := make(map[string]DiskStat)
	order := make([]string, 0, len(partitions))
	var failed []failedMount
	for _, partition := range partitions {
		if ignoredFilesystem(partition.Fstype) || loopDevice(partition.Device) {
			continue
		}
		usage, err := disk.UsageWithContext(ctx, partition.Mountpoint)
		if err != nil || usage.Total == 0 {
			failed = append(failed, failedMount{device: partition.Device, mountpoint: partition.Mountpoint})
			continue
		}
		candidate := DiskStat{
			Mountpoint: partition.Mountpoint,
			Total:      usage.Total,
			Used:       usage.Used,
			Percent:    usage.UsedPercent,
			Available:  usage.Free,
		}
		if usage.InodesTotal > 0 {
			percent := usage.InodesUsedPercent
			if !math.IsNaN(percent) && !math.IsInf(percent, 0) {
				candidate.InodeUsedPercent = &percent
			}
		}
		key := partition.Device
		if key == "" {
			key = partition.Mountpoint
		}
		if existing, ok := byDevice[key]; !ok {
			byDevice[key] = candidate
			order = append(order, key)
		} else if preferredMount(candidate.Mountpoint, existing.Mountpoint) {
			byDevice[key] = candidate
		}
	}

	// A failed mount of a device that is represented by another successful
	// mountpoint must not produce a duplicate health check.
	seenFailed := make(map[string]bool)
	failedMountpoints := make([]string, 0, len(failed))
	for _, mount := range failed {
		if _, represented := byDevice[mount.device]; represented {
			continue
		}
		if seenFailed[mount.mountpoint] {
			continue
		}
		seenFailed[mount.mountpoint] = true
		failedMountpoints = append(failedMountpoints, mount.mountpoint)
	}
	sort.Strings(failedMountpoints)

	disks := make([]DiskStat, 0, len(order))
	for _, key := range order {
		disks = append(disks, byDevice[key])
	}
	sort.Slice(disks, func(i, j int) bool { return disks[i].Mountpoint < disks[j].Mountpoint })
	return disks, failedMountpoints, nil
}

func ignoredFilesystem(fstype string) bool {
	switch fstype {
	case "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "ramfs", "cgroup", "cgroup2",
		"pstore", "bpf", "debugfs", "tracefs", "securityfs", "configfs", "fusectl",
		"mqueue", "hugetlbfs", "autofs", "binfmt_misc", "nsfs", "efivarfs", "rpc_pipefs",
		"overlay", "iso9660", "squashfs", "udf", "erofs":
		return true
	default:
		return false
	}
}

func loopDevice(device string) bool {
	return strings.HasPrefix(device, "/dev/loop")
}

func preferredMount(candidate, existing string) bool {
	if candidate == "/" {
		return true
	}
	if existing == "/" {
		return false
	}
	return len(candidate) < len(existing)
}

type routeCandidate struct {
	iface  string
	metric uint64
	ipv6   bool
}

// defaultRouteInterface returns the interface carrying the default route.
// Multiple default routes are ordered by metric, then IPv4 before IPv6, then
// interface name.
func defaultRouteInterface() (string, error) {
	candidates, err := readDefaultRoutes()
	if err != nil {
		return "", err
	}
	return selectDefaultRoute(candidates), nil
}

func selectDefaultRoute(candidates []routeCandidate) string {
	if len(candidates) == 0 {
		return ""
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].metric != candidates[j].metric {
			return candidates[i].metric < candidates[j].metric
		}
		if candidates[i].ipv6 != candidates[j].ipv6 {
			return !candidates[i].ipv6
		}
		return candidates[i].iface < candidates[j].iface
	})
	return candidates[0].iface
}

func readDefaultRoutes() ([]routeCandidate, error) {
	var candidates []routeCandidate
	var ipv4Err, ipv6Err error
	if file, err := os.Open("/proc/net/route"); err != nil {
		ipv4Err = err
	} else {
		defer file.Close()
		var parsed []routeCandidate
		parsed, ipv4Err = parseIPv4Routes(file)
		candidates = append(candidates, parsed...)
	}
	if file, err := os.Open("/proc/net/ipv6_route"); err != nil {
		ipv6Err = err
	} else {
		defer file.Close()
		var parsed []routeCandidate
		parsed, ipv6Err = parseIPv6Routes(file)
		candidates = append(candidates, parsed...)
	}
	if ipv4Err != nil && ipv6Err != nil {
		return nil, ipv4Err
	}
	return candidates, nil
}

func parseIPv4Routes(r io.Reader) ([]routeCandidate, error) {
	scanner := bufio.NewScanner(r)
	var candidates []routeCandidate
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 || fields[0] == "Iface" {
			continue
		}
		// Destination and mask must both be the IPv4 default (0.0.0.0).
		if fields[1] != "00000000" || fields[7] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fields[3], 16, 32)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		metric, _ := strconv.ParseUint(fields[6], 16, 32)
		candidates = append(candidates, routeCandidate{iface: fields[0], metric: metric})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func parseIPv6Routes(r io.Reader) ([]routeCandidate, error) {
	const zeroAddress = "00000000000000000000000000000000"
	scanner := bufio.NewScanner(r)
	var candidates []routeCandidate
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		if fields[0] != zeroAddress || fields[1] != "00" || fields[9] == "" {
			continue
		}
		flags, err := strconv.ParseUint(fields[8], 16, 32)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		metric, _ := strconv.ParseUint(fields[5], 16, 32)
		candidates = append(candidates, routeCandidate{iface: fields[9], metric: metric, ipv6: true})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func collectNetwork(ctx context.Context, previous map[string]counters, previousTime, now time.Time) ([]NetworkStat, map[string]counters, time.Time, bool) {
	ioCounters, err := gnet.IOCountersWithContext(ctx, true)
	if err != nil {
		ioCounters = nil
	}
	current := make(map[string]counters, len(ioCounters))
	for _, item := range ioCounters {
		current[item.Name] = counters{rx: item.BytesRecv, tx: item.BytesSent}
	}

	defaultInterface := ""
	routeFailed := false
	if name, err := defaultRouteInterface(); err != nil {
		routeFailed = true
	} else {
		defaultInterface = name
	}

	interfaces, err := net.Interfaces()
	if err != nil {
		return []NetworkStat{}, current, now, true
	}
	elapsed := now.Sub(previousTime).Seconds()
	stats := make([]NetworkStat, 0, len(interfaces))
	for _, iface := range interfaces {
		isDefault := defaultInterface != "" && iface.Name == defaultInterface
		ipv4, ipv6 := interfaceAddresses(iface)
		if !isDefault {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			if len(ipv4) == 0 && len(ipv6) == 0 {
				continue
			}
		}
		stat := NetworkStat{
			Name:           iface.Name,
			MAC:            iface.HardwareAddr.String(),
			IPv4:           ipv4,
			IPv6:           ipv6,
			LinkUp:         linkStateUp(iface),
			IsDefaultRoute: isDefault,
		}
		if currentCounters, ok := current[iface.Name]; ok {
			if previousCounters, ok := previous[iface.Name]; ok && elapsed > 0 {
				if currentCounters.rx >= previousCounters.rx {
					stat.RxRate = float64(currentCounters.rx-previousCounters.rx) / elapsed
				}
				if currentCounters.tx >= previousCounters.tx {
					stat.TxRate = float64(currentCounters.tx-previousCounters.tx) / elapsed
				}
			}
		}
		stats = append(stats, stat)
	}
	sort.Slice(stats, func(i, j int) bool { return stats[i].Name < stats[j].Name })
	return stats, current, now, routeFailed
}

// linkStateUp distinguishes an administratively enabled interface from one
// whose link is explicitly down in sysfs.
func linkStateUp(iface net.Interface) bool {
	if iface.Flags&net.FlagUp == 0 {
		return false
	}
	data, err := os.ReadFile("/sys/class/net/" + iface.Name + "/operstate")
	if err != nil {
		return true
	}
	switch strings.TrimSpace(string(data)) {
	case "down", "lowerlayerdown", "notpresent":
		return false
	default:
		return true
	}
}

func interfaceAddresses(iface net.Interface) ([]string, []string) {
	ipv4 := []string{}
	ipv6 := []string{}
	addresses, err := iface.Addrs()
	if err != nil {
		return ipv4, ipv6
	}
	for _, address := range addresses {
		var ip net.IP
		switch value := address.(type) {
		case *net.IPNet:
			ip = value.IP
		case *net.IPAddr:
			ip = value.IP
		default:
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			ipv4 = append(ipv4, v4.String())
		} else {
			ipv6 = append(ipv6, ip.String())
		}
	}
	return ipv4, ipv6
}

func platformName() string {
	if runtime.GOOS != "linux" {
		return runtime.GOOS
	}
	version, err := os.ReadFile("/proc/version")
	if err == nil {
		value := strings.ToLower(string(version))
		if strings.Contains(value, "microsoft") || strings.Contains(value, "wsl") {
			return "Linux (WSL2)"
		}
	}
	return "Linux"
}
