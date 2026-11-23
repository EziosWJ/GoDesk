package monitor

import (
	"context"
	"errors"
	"net"
	"os"
	"runtime"
	"sort"
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
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

type DiskStat struct {
	Mountpoint string  `json:"mountpoint"`
	Total      uint64  `json:"total"`
	Used       uint64  `json:"used"`
	Percent    float64 `json:"percent"`
}

type NetworkStat struct {
	Name   string   `json:"name"`
	MAC    string   `json:"mac"`
	IPv4   []string `json:"ipv4"`
	IPv6   []string `json:"ipv6"`
	RxRate float64  `json:"rxRate"`
	TxRate float64  `json:"txRate"`
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

type Snapshot struct {
	SampledAt time.Time     `json:"sampledAt"`
	Platform  string        `json:"platform"`
	CPU       *CPUStat      `json:"cpu"`
	Memory    *MemoryStat   `json:"memory"`
	Disks     []DiskStat    `json:"disks"`
	Network   []NetworkStat `json:"network"`
	Series    Series        `json:"series"`
}

type sample struct {
	takenAt time.Time
	cpu     *CPUStat
	memory  *MemoryStat
	disks   []DiskStat
	network []NetworkStat
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
	snapshot := Snapshot{
		SampledAt: last.takenAt,
		Platform:  c.platform,
		Disks:     append([]DiskStat{}, last.disks...),
		Network:   append([]NetworkStat{}, last.network...),
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
	if last.memory != nil {
		value := *last.memory
		snapshot.Memory = &value
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
	}
	if stat, err := collectMemory(ctx); err == nil {
		current.memory = stat
	}
	current.disks = collectDisks(ctx)
	current.network, c.previous, c.previousTime = collectNetwork(ctx, c.previous, c.previousTime, current.takenAt)

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
	return &MemoryStat{Total: stat.Total, Used: stat.Used, Percent: stat.UsedPercent}, nil
}

func collectDisks(ctx context.Context) []DiskStat {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return []DiskStat{}
	}
	byDevice := make(map[string]DiskStat)
	order := make([]string, 0, len(partitions))
	for _, partition := range partitions {
		if ignoredFilesystem(partition.Fstype) {
			continue
		}
		usage, err := disk.UsageWithContext(ctx, partition.Mountpoint)
		if err != nil || usage.Total == 0 {
			continue
		}
		key := partition.Device
		if key == "" {
			key = partition.Mountpoint
		}
		candidate := DiskStat{
			Mountpoint: partition.Mountpoint,
			Total:      usage.Total,
			Used:       usage.Used,
			Percent:    usage.UsedPercent,
		}
		if existing, ok := byDevice[key]; !ok {
			byDevice[key] = candidate
			order = append(order, key)
		} else if preferredMount(candidate.Mountpoint, existing.Mountpoint) {
			byDevice[key] = candidate
		}
	}
	if len(byDevice) == 0 {
		if usage, err := disk.UsageWithContext(ctx, "/"); err == nil && usage.Total > 0 {
			return []DiskStat{{
				Mountpoint: "/",
				Total:      usage.Total,
				Used:       usage.Used,
				Percent:    usage.UsedPercent,
			}}
		}
	}
	disks := make([]DiskStat, 0, len(order))
	for _, key := range order {
		disks = append(disks, byDevice[key])
	}
	sort.Slice(disks, func(i, j int) bool { return disks[i].Mountpoint < disks[j].Mountpoint })
	return disks
}

func ignoredFilesystem(fstype string) bool {
	switch fstype {
	case "iso9660", "squashfs", "udf":
		return true
	default:
		return false
	}
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

func collectNetwork(ctx context.Context, previous map[string]counters, previousTime, now time.Time) ([]NetworkStat, map[string]counters, time.Time) {
	ioCounters, err := gnet.IOCountersWithContext(ctx, true)
	if err != nil {
		return []NetworkStat{}, previous, previousTime
	}
	current := make(map[string]counters, len(ioCounters))
	for _, item := range ioCounters {
		current[item.Name] = counters{rx: item.BytesRecv, tx: item.BytesSent}
	}

	interfaces, err := net.Interfaces()
	if err != nil {
		return []NetworkStat{}, current, now
	}
	elapsed := now.Sub(previousTime).Seconds()
	stats := make([]NetworkStat, 0, len(interfaces))
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		ipv4, ipv6 := interfaceAddresses(iface)
		if len(ipv4) == 0 && len(ipv6) == 0 {
			continue
		}
		stat := NetworkStat{
			Name: iface.Name,
			MAC:  iface.HardwareAddr.String(),
			IPv4: ipv4,
			IPv6: ipv6,
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
	return stats, current, now
}

func interfaceAddresses(iface net.Interface) ([]string, []string) {
	addresses, err := iface.Addrs()
	if err != nil {
		return nil, nil
	}
	var ipv4, ipv6 []string
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
