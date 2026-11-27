package health

import (
	"context"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"godesk/internal/monitor"
)

// SchemaVersion is the response structure version of the health API.
const SchemaVersion = 1

const responseStaleAfter = 15 * time.Second

// swapUsageWarningPercent is the usage gate for the swap warning. It only
// applies together with sustained paging activity.
const swapUsageWarningPercent = 80

type Status string

const (
	StatusHealthy  Status = "healthy"
	StatusWarning  Status = "warning"
	StatusCritical Status = "critical"
	StatusUnknown  Status = "unknown"
)

type Reason string

const (
	ReasonOK                Reason = "ok"
	ReasonThresholdWarning  Reason = "threshold_warning"
	ReasonNoAddress         Reason = "no_address"
	ReasonThresholdCritical Reason = "threshold_critical"
	ReasonLinkDown          Reason = "link_down"
	ReasonCollectFailed     Reason = "collect_failed"
	ReasonStale             Reason = "stale"
	ReasonInitializing      Reason = "initializing"
	ReasonNotSupported      Reason = "not_supported"
	ReasonNoThreshold       Reason = "no_threshold"
	ReasonNoDefaultRoute    Reason = "no_default_route"
)

type Snapshot struct {
	SchemaVersion int       `json:"schemaVersion"`
	GeneratedAt   time.Time `json:"generatedAt"`
	Stale         bool      `json:"stale"`
	Overall       Status    `json:"overall"`
	Host          Host      `json:"host"`
	Summary       Summary   `json:"summary"`
	Checks        []Check   `json:"checks"`
}

type Host struct {
	Hostname      string `json:"hostname"`
	Platform      string `json:"platform"`
	Architecture  string `json:"architecture"`
	UptimeSeconds *int64 `json:"uptimeSeconds"`
}

type Summary struct {
	Total         int `json:"total"`
	Healthy       int `json:"healthy"`
	Warning       int `json:"warning"`
	Critical      int `json:"critical"`
	Unknown       int `json:"unknown"`
	NotApplicable int `json:"notApplicable"`
	IssueCount    int `json:"issueCount"`
}

type Thresholds struct {
	Warning  *float64 `json:"warning"`
	Critical *float64 `json:"critical"`
}

type Check struct {
	ID         string      `json:"id"`
	Category   string      `json:"category"`
	Label      string      `json:"label"`
	Status     Status      `json:"status"`
	Applicable bool        `json:"applicable"`
	Reason     Reason      `json:"reason"`
	Message    string      `json:"message"`
	ObservedAt time.Time   `json:"observedAt"`
	Since      *time.Time  `json:"since"`
	Stale      bool        `json:"stale"`
	Value      *float64    `json:"value"`
	Unit       *string     `json:"unit"`
	Thresholds *Thresholds `json:"thresholds"`
	Details    any         `json:"details"`
}

type CPUDetails struct {
	LogicalCores int `json:"logicalCores"`
}

type MemoryDetails struct {
	TotalBytes       uint64  `json:"totalBytes"`
	UsedBytes        uint64  `json:"usedBytes"`
	AvailableBytes   uint64  `json:"availableBytes"`
	AvailablePercent float64 `json:"availablePercent"`
}

type DiskDetails struct {
	Mountpoint          string   `json:"mountpoint"`
	Dimension           string   `json:"dimension"`
	CapacityUsedPercent float64  `json:"capacityUsedPercent"`
	InodeUsedPercent    *float64 `json:"inodeUsedPercent,omitempty"`
	TotalBytes          uint64   `json:"totalBytes"`
	UsedBytes           uint64   `json:"usedBytes"`
	AvailableBytes      uint64   `json:"availableBytes"`
}

type NetworkDetails struct {
	Interface        string   `json:"interface"`
	LinkUp           bool     `json:"linkUp"`
	IsDefaultRoute   bool     `json:"isDefaultRoute"`
	IPv4             []string `json:"ipv4"`
	IPv6             []string `json:"ipv6"`
	RxBytesPerSecond float64  `json:"rxBytesPerSecond"`
	TxBytesPerSecond float64  `json:"txBytesPerSecond"`
}

type LoadDetails struct {
	Load1        float64 `json:"load1"`
	Load5        float64 `json:"load5"`
	Load15       float64 `json:"load15"`
	LogicalCores int     `json:"logicalCores"`
	Load5PerCore float64 `json:"load5PerCore"`
}

type SwapDetails struct {
	TotalBytes    uint64  `json:"totalBytes"`
	UsedBytes     uint64  `json:"usedBytes"`
	UsedPercent   float64 `json:"usedPercent"`
	SwapInPerSec  float64 `json:"swapInPerSec"`
	SwapOutPerSec float64 `json:"swapOutPerSec"`
}

type TemperatureDetails struct {
	Sensor   string   `json:"sensor"`
	Chip     string   `json:"chip"`
	Celsius  float64  `json:"celsius"`
	Warning  *float64 `json:"warning"`
	Critical *float64 `json:"critical"`
}

type rule struct {
	warning        float64
	critical       float64
	recoverHealthy float64
	recoverWarning float64
	enterAfter     time.Duration
	recoverAfter   time.Duration
	enterSamples   int
	recoverSamples int
}

var defaultRules = map[string]rule{
	"cpu":    {warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: 5 * time.Minute, recoverAfter: time.Minute},
	"memory": {warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: 2 * time.Minute, recoverAfter: time.Minute},
	"disk":   {warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterSamples: 2, recoverSamples: 2},
	"load":   {warning: 1.5, critical: 3.0, recoverHealthy: 1.0, recoverWarning: 2.5, enterAfter: 5 * time.Minute, recoverAfter: time.Minute},
	// Swap evaluates a synthetic triggered/not-triggered value, not a percent.
	"swap": {warning: 1, critical: unreachableThreshold, recoverHealthy: 0.5, recoverWarning: unreachableThreshold, enterAfter: 2 * time.Minute, recoverAfter: time.Minute},
}

type source interface {
	Snapshot() (monitor.Snapshot, bool)
}

type thresholdState struct {
	initialized bool
	status      Status
	since       time.Time
	value       float64
	observedAt  time.Time
	lastAdvance time.Time

	pending        Status
	pendingSince   time.Time
	pendingElapsed time.Duration
	pendingSamples int

	unknownSince time.Time
	lastDisk     monitor.DiskStat
	lastMemory   monitor.MemoryStat
	lastLoad     monitor.LoadStat
	lastSwap     monitor.SwapStat
}

type networkState struct {
	status       Status
	since        time.Time
	observedAt   time.Time
	unknownSince time.Time
}

type Engine struct {
	source   source
	interval time.Duration
	now      func() time.Time
	rules    map[string]rule
	host     Host

	mu            sync.RWMutex
	snapshot      *Snapshot
	lastSample    monitor.Snapshot
	hasSample     bool
	lastSampledAt time.Time
	thresholds    map[string]*thresholdState
	network       networkState

	temperature          temperatureSampler
	temperatureInterval  time.Duration
	temperatureSampledAt time.Time
	temperatureSensors   []temperatureSensor
}

func newEngine(source source, interval time.Duration, now func() time.Time) *Engine {
	if interval <= 0 {
		interval = monitor.DefaultInterval
	}
	hostname, _ := os.Hostname()
	rules := make(map[string]rule, len(defaultRules))
	for category, value := range defaultRules {
		rules[category] = value
	}
	return &Engine{
		source:              source,
		interval:            interval,
		now:                 now,
		rules:               rules,
		host:                Host{Hostname: hostname, Architecture: runtime.GOARCH},
		thresholds:          make(map[string]*thresholdState),
		temperatureInterval: defaultTemperatureInterval,
	}
}

// Start evaluates the current collector snapshot and then follows new samples.
func Start(ctx context.Context, source source, interval time.Duration) *Engine {
	engine := newEngine(source, interval, time.Now)
	// The system temperature is sampled from sysfs by the health engine itself;
	// monitor.Collector does not collect it.
	engine.temperature = newSysfsTemperatureSampler()
	if sample, ok := source.Snapshot(); ok {
		engine.evaluateAt(sample, engine.now())
	}
	go engine.run(ctx)
	return engine
}

func (e *Engine) run(ctx context.Context) {
	ticker := time.NewTicker(e.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.poll()
		}
	}
}

func (e *Engine) poll() {
	sample, ok := e.source.Snapshot()
	if !ok {
		return
	}
	now := e.now()
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.hasSample || sample.SampledAt.After(e.lastSampledAt) {
		e.applySampleLocked(sample)
	}
	e.sampleTemperatureLocked(now)
	e.rebuildLocked(now)
}

func (e *Engine) evaluateAt(sample monitor.Snapshot, now time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.applySampleLocked(sample)
	e.sampleTemperatureLocked(now)
	e.rebuildLocked(now)
}

// evaluateTemperatureAt applies an explicit temperature sample. It exists so
// tests can drive the temperature state machine without sysfs or wall clock.
func (e *Engine) evaluateTemperatureAt(sensors []temperatureSensor, at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.applyTemperatureLocked(sensors, at)
	e.rebuildLocked(at)
}

// refreshAt regenerates the snapshot from the latest sample without applying a
// new one, updating freshness flags and the response timestamp.
func (e *Engine) refreshAt(now time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.hasSample {
		e.rebuildLocked(now)
	}
}

// Snapshot returns the latest health snapshot with the top-level freshness flag
// computed against the current time. The second result is false until the
// engine has produced its first snapshot.
func (e *Engine) Snapshot() (Snapshot, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.snapshot == nil {
		return Snapshot{}, false
	}
	snapshot := *e.snapshot
	snapshot.Checks = append([]Check{}, e.snapshot.Checks...)
	if e.now().Sub(snapshot.GeneratedAt) > responseStaleAfter {
		snapshot.Stale = true
	}
	return snapshot, true
}

func (e *Engine) staleWindow() time.Duration {
	window := 3 * e.interval
	if window < 5*time.Second {
		window = 5 * time.Second
	}
	return window
}

func (e *Engine) applySampleLocked(sample monitor.Snapshot) {
	e.lastSample = sample
	e.hasSample = true
	e.lastSampledAt = sample.SampledAt

	if !sample.Collection.CPUFailed && sample.CPU != nil {
		state := e.state("cpu")
		e.advanceThreshold(state, clampPercent(sample.CPU.Percent), sample.SampledAt, e.rules["cpu"])
	}
	if !sample.Collection.LoadFailed && sample.Load != nil && sample.Load.LogicalCores > 0 {
		state := e.state("load")
		state.lastLoad = *sample.Load
		e.advanceThreshold(state, load5PerCore(*sample.Load), sample.SampledAt, e.rules["load"])
	}
	if !sample.Collection.MemoryFailed && sample.Memory != nil {
		state := e.state("memory")
		state.lastMemory = *sample.Memory
		e.advanceThreshold(state, memoryUsedPercent(*sample.Memory), sample.SampledAt, e.rules["memory"])
	}
	if !sample.Collection.SwapFailed && sample.Swap != nil {
		if sample.Swap.Configured && sample.Swap.TotalBytes > 0 {
			state := e.state("swap")
			state.lastSwap = *sample.Swap
			e.advanceThreshold(state, swapTriggerValue(*sample.Swap), sample.SampledAt, e.rules["swap"])
		} else {
			delete(e.thresholds, "swap")
		}
	}
	if !sample.Collection.DisksFailed {
		if state, ok := e.thresholds["disk"]; ok {
			state.unknownSince = time.Time{}
		}
		seen := make(map[string]bool, len(sample.Disks))
		for _, disk := range sample.Disks {
			id := diskCheckID(disk.Mountpoint)
			seen[id] = true
			state := e.state(id)
			state.lastDisk = disk
			value, _ := diskValue(disk, e.rules["disk"])
			e.advanceThreshold(state, value, sample.SampledAt, e.rules["disk"])
		}
		for id := range e.thresholds {
			if strings.HasPrefix(id, "disk:") && !seen[id] {
				delete(e.thresholds, id)
			}
		}
	}
	if !sample.Collection.NetworkFailed {
		gap := sample.SampledAt.Sub(e.network.observedAt)
		if !e.network.observedAt.IsZero() && gap > e.staleWindow() {
			e.network.status = ""
			e.network.since = time.Time{}
		}
		if nic, ok := defaultNetwork(sample.Network); ok {
			status, _, _ := networkStatus(nic)
			if status != e.network.status {
				e.network.status = status
				if status == StatusHealthy {
					e.network.since = time.Time{}
				} else {
					e.network.since = sample.SampledAt
				}
			}
		} else {
			e.network.status = ""
			e.network.since = time.Time{}
		}
		e.network.observedAt = sample.SampledAt
		e.network.unknownSince = time.Time{}
	}
}

func (e *Engine) state(id string) *thresholdState {
	state, ok := e.thresholds[id]
	if !ok {
		state = &thresholdState{}
		e.thresholds[id] = state
	}
	return state
}

// sampleTemperatureLocked samples sysfs at most once per temperature interval.
// The caller must hold e.mu.
func (e *Engine) sampleTemperatureLocked(now time.Time) {
	if e.temperature == nil {
		return
	}
	if !e.temperatureSampledAt.IsZero() && now.Sub(e.temperatureSampledAt) < e.temperatureInterval {
		return
	}
	e.applyTemperatureLocked(e.temperature.Sample(), now)
}

func (e *Engine) applyTemperatureLocked(sensors []temperatureSensor, at time.Time) {
	e.temperatureSensors = sensors
	e.temperatureSampledAt = at

	seen := make(map[string]bool, len(sensors))
	for _, sensor := range sensors {
		r, ok := temperatureRule(sensor)
		if !ok {
			continue
		}
		state := e.state(sensor.ID)
		e.advanceThresholdWithin(state, sensor.Celsius, at, r, e.temperatureInterval, e.temperatureStaleWindow())
		seen[sensor.ID] = true
	}
	for id := range e.thresholds {
		if strings.HasPrefix(id, "temperature:") && !seen[id] {
			delete(e.thresholds, id)
		}
	}
}

func (e *Engine) advanceThreshold(state *thresholdState, value float64, at time.Time, r rule) {
	e.advanceThresholdWithin(state, value, at, r, e.interval, e.staleWindow())
}

// advanceThresholdWithin lets a check use its own sampling cadence and
// freshness window. Temperature, for example, is sampled every 5 seconds while
// the engine loop runs every second.
func (e *Engine) advanceThresholdWithin(state *thresholdState, value float64, at time.Time, r rule, sampleInterval, staleAfter time.Duration) {
	if !state.initialized {
		state.initialized = true
		state.status = StatusHealthy
		state.value = value
		state.observedAt = at
		state.lastAdvance = at
		state.unknownSince = time.Time{}
		target := thresholdTarget(StatusHealthy, value, r)
		state.pending = target
		state.pendingSince = at
		state.pendingElapsed = 0
		state.pendingSamples = 0
		if target != StatusHealthy && r.enterSamples > 0 {
			state.pendingSamples = 1
		}
		return
	}

	gap := at.Sub(state.lastAdvance)
	if gap > staleAfter {
		// The data gap exceeded the freshness window: previous accumulation is
		// discarded and evaluation starts again from a healthy baseline.
		state.status = StatusHealthy
		state.since = time.Time{}
		state.pending = ""
		state.pendingElapsed = 0
		state.pendingSamples = 0
		state.unknownSince = time.Time{}
		gap = 0
	}
	credit := gap
	if credit < 0 {
		credit = 0
	}
	if credit > sampleInterval {
		credit = sampleInterval
	}

	state.value = value
	state.observedAt = at
	state.lastAdvance = at
	state.unknownSince = time.Time{}

	target := thresholdTarget(state.status, value, r)
	if target == state.status {
		state.pending = ""
		state.pendingElapsed = 0
		state.pendingSamples = 0
		return
	}
	if state.pending != target {
		state.pending = target
		state.pendingSince = at
		state.pendingElapsed = 0
		state.pendingSamples = 0
	}

	if severity(target) < severity(state.status) {
		if r.recoverSamples > 0 {
			state.pendingSamples++
			if state.pendingSamples >= r.recoverSamples {
				state.apply(target)
			}
			return
		}
		state.pendingElapsed += credit
		if state.pendingElapsed >= r.recoverAfter {
			state.apply(target)
		}
		return
	}

	if r.enterSamples > 0 {
		state.pendingSamples++
		if state.pendingSamples >= r.enterSamples {
			state.apply(target)
		}
		return
	}
	state.pendingElapsed += credit
	if state.pendingElapsed >= r.enterAfter {
		state.apply(target)
	}
}

func (state *thresholdState) apply(target Status) {
	state.status = target
	if target == StatusHealthy {
		state.since = time.Time{}
	} else {
		state.since = state.pendingSince
	}
	state.pending = ""
	state.pendingElapsed = 0
	state.pendingSamples = 0
}

func thresholdTarget(current Status, value float64, r rule) Status {
	switch current {
	case StatusCritical:
		if value < r.recoverHealthy {
			return StatusHealthy
		}
		if value < r.recoverWarning {
			return StatusWarning
		}
		return StatusCritical
	case StatusWarning:
		if value < r.recoverHealthy {
			return StatusHealthy
		}
		if value >= r.critical {
			return StatusCritical
		}
		return StatusWarning
	default:
		if value >= r.critical {
			return StatusCritical
		}
		if value >= r.warning {
			return StatusWarning
		}
		return StatusHealthy
	}
}

func severity(status Status) int {
	switch status {
	case StatusCritical:
		return 4
	case StatusWarning:
		return 3
	case StatusUnknown:
		return 2
	case StatusHealthy:
		return 1
	default:
		return 0
	}
}

func (e *Engine) rebuildLocked(now time.Time) {
	if !e.hasSample {
		return
	}
	checks := make([]Check, 0, 6+len(e.lastSample.Disks)+len(e.temperatureSensors))
	checks = append(checks, e.cpuCheckLocked(now))
	checks = append(checks, e.loadCheckLocked(now))
	checks = append(checks, e.memoryCheckLocked(now))
	checks = append(checks, e.swapCheckLocked(now))
	checks = append(checks, e.diskChecksLocked(now)...)
	checks = append(checks, e.networkCheckLocked(now))
	checks = append(checks, e.temperatureChecksLocked(now)...)

	host := e.hostFacts()

	e.snapshot = &Snapshot{
		SchemaVersion: SchemaVersion,
		GeneratedAt:   now.UTC(),
		Overall:       overallOf(checks),
		Host:          host,
		Summary:       summarize(checks),
		Checks:        checks,
	}
}

func (e *Engine) cpuCheckLocked(now time.Time) Check {
	state := e.state("cpu")
	check := Check{
		ID:         "cpu",
		Category:   "cpu",
		Label:      "CPU",
		Applicable: true,
		Unit:       stringPointer("percent"),
		Thresholds: thresholdValues(e.rules["cpu"]),
		Details:    CPUDetails{LogicalCores: runtime.NumCPU()},
	}
	if !state.initialized {
		if e.lastSample.Collection.CPUFailed {
			since := ensureUnknownSince(state, now)
			check.ObservedAt = since.UTC()
			if now.Sub(since) > e.staleWindow() {
				check.Stale = true
				return unknownCheck(check, ReasonStale, "CPU 数据已过期", since)
			}
			return unknownCheck(check, ReasonCollectFailed, "CPU 采集失败", since)
		}
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonInitializing, "正在等待 CPU 数据", ensureUnknownSince(state, now))
	}
	check.Value = numberPointer(state.value)
	check.ObservedAt = state.observedAt.UTC()
	if now.Sub(state.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "CPU 数据已过期", ensureUnknownSince(state, state.observedAt.Add(e.staleWindow())))
	}
	if e.lastSample.Collection.CPUFailed {
		return unknownCheck(check, ReasonCollectFailed, "CPU 采集失败", ensureUnknownSince(state, now))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = "CPU 使用率持续偏高"
		check.Since = timePointer(state.since)
	case StatusCritical:
		check.Reason = ReasonThresholdCritical
		check.Message = "CPU 使用率持续过高"
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = "CPU 使用率正常"
	}
	return check
}

func (e *Engine) loadCheckLocked(now time.Time) Check {
	state := e.state("load")
	details := LoadDetails{}
	if state.initialized {
		details = loadDetails(state.lastLoad)
	}
	check := Check{
		ID:         "load",
		Category:   "load",
		Label:      "系统负载",
		Applicable: true,
		Thresholds: thresholdValues(e.rules["load"]),
		Details:    details,
	}

	load := e.lastSample.Load
	// A missing logical core count makes the per-core value meaningless.
	unavailable := e.lastSample.Collection.LoadFailed || (load != nil && load.LogicalCores <= 0)
	if !state.initialized {
		if unavailable {
			since := ensureUnknownSince(state, now)
			check.ObservedAt = since.UTC()
			if now.Sub(since) > e.staleWindow() {
				check.Stale = true
				return unknownCheck(check, ReasonStale, "系统负载数据已过期", since)
			}
			return unknownCheck(check, ReasonCollectFailed, "系统负载采集失败", since)
		}
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonInitializing, "正在等待系统负载数据", ensureUnknownSince(state, now))
	}

	check.Value = numberPointer(state.value)
	check.ObservedAt = state.observedAt.UTC()
	if now.Sub(state.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "系统负载数据已过期", ensureUnknownSince(state, state.observedAt.Add(e.staleWindow())))
	}
	if unavailable {
		return unknownCheck(check, ReasonCollectFailed, "系统负载采集失败", ensureUnknownSince(state, now))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = "系统负载持续偏高"
		check.Since = timePointer(state.since)
	case StatusCritical:
		check.Reason = ReasonThresholdCritical
		check.Message = "系统负载持续过高"
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = "系统负载正常"
	}
	return check
}

func (e *Engine) memoryCheckLocked(now time.Time) Check {
	state := e.state("memory")
	details := MemoryDetails{}
	if state.initialized {
		memory := state.lastMemory
		details = MemoryDetails{
			TotalBytes:       memory.Total,
			UsedBytes:        usedBytes(memory),
			AvailableBytes:   memory.Available,
			AvailablePercent: memoryAvailablePercent(memory),
		}
	}
	check := Check{
		ID:         "memory",
		Category:   "memory",
		Label:      "内存",
		Applicable: true,
		Unit:       stringPointer("percent"),
		Thresholds: thresholdValues(e.rules["memory"]),
		Details:    details,
	}
	if !state.initialized {
		if e.lastSample.Collection.MemoryFailed {
			since := ensureUnknownSince(state, now)
			check.ObservedAt = since.UTC()
			if now.Sub(since) > e.staleWindow() {
				check.Stale = true
				return unknownCheck(check, ReasonStale, "内存数据已过期", since)
			}
			return unknownCheck(check, ReasonCollectFailed, "内存采集失败", since)
		}
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonInitializing, "正在等待内存数据", ensureUnknownSince(state, now))
	}
	check.Value = numberPointer(state.value)
	check.ObservedAt = state.observedAt.UTC()
	if now.Sub(state.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "内存数据已过期", ensureUnknownSince(state, state.observedAt.Add(e.staleWindow())))
	}
	if e.lastSample.Collection.MemoryFailed {
		return unknownCheck(check, ReasonCollectFailed, "内存采集失败", ensureUnknownSince(state, now))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = "内存使用率持续偏高"
		check.Since = timePointer(state.since)
	case StatusCritical:
		check.Reason = ReasonThresholdCritical
		check.Message = "内存使用率持续过高"
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = "可用内存充足"
	}
	return check
}

func (e *Engine) swapCheckLocked(now time.Time) Check {
	if e.lastSample.Swap != nil && (!e.lastSample.Swap.Configured || e.lastSample.Swap.TotalBytes == 0) {
		// An unconfigured swap is not an issue; idle cold pages must never alert.
		return Check{
			ID:         "swap",
			Category:   "swap",
			Label:      "Swap",
			Status:     StatusUnknown,
			Applicable: false,
			Reason:     ReasonNotSupported,
			Message:    "未配置 Swap",
			ObservedAt: now.UTC(),
			Details:    swapDetails(*e.lastSample.Swap),
		}
	}

	state := e.state("swap")
	check := Check{
		ID:         "swap",
		Category:   "swap",
		Label:      "Swap",
		Applicable: true,
		Unit:       stringPointer("percent"),
		Thresholds: &Thresholds{Warning: numberPointer(swapUsageWarningPercent)},
		Details:    swapDetails(state.lastSwap),
	}
	if !state.initialized {
		if e.lastSample.Collection.SwapFailed {
			since := ensureUnknownSince(state, now)
			check.ObservedAt = since.UTC()
			if now.Sub(since) > e.staleWindow() {
				check.Stale = true
				return unknownCheck(check, ReasonStale, "Swap 数据已过期", since)
			}
			return unknownCheck(check, ReasonCollectFailed, "Swap 采集失败", since)
		}
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonInitializing, "正在等待 Swap 数据", ensureUnknownSince(state, now))
	}

	check.Value = numberPointer(state.lastSwap.UsedPercent)
	check.ObservedAt = state.observedAt.UTC()
	if now.Sub(state.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "Swap 数据已过期", ensureUnknownSince(state, state.observedAt.Add(e.staleWindow())))
	}
	if e.lastSample.Collection.SwapFailed {
		return unknownCheck(check, ReasonCollectFailed, "Swap 采集失败", ensureUnknownSince(state, now))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = "Swap 使用率高且存在换页活动"
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = "Swap 使用情况正常"
	}
	return check
}

func (e *Engine) diskChecksLocked(now time.Time) []Check {
	collection := e.lastSample.Collection
	if collection.DisksFailed {
		state := e.state("disk")
		since := ensureUnknownSince(state, now)
		return []Check{{
			ID:         "disk",
			Category:   "storage",
			Label:      "磁盘",
			Status:     StatusUnknown,
			Applicable: true,
			Reason:     ReasonCollectFailed,
			Message:    "磁盘采集失败",
			ObservedAt: since.UTC(),
			Since:      timePointer(since),
			Details:    DiskDetails{Dimension: "capacity"},
		}}
	}
	if len(e.lastSample.Disks) == 0 && len(collection.FailedMountpoints) == 0 {
		return []Check{{
			ID:         "disk",
			Category:   "storage",
			Label:      "磁盘",
			Status:     StatusUnknown,
			Applicable: false,
			Reason:     ReasonNotSupported,
			Message:    "没有可检查的真实文件系统",
			ObservedAt: now.UTC(),
			Details:    DiskDetails{Dimension: "capacity"},
		}}
	}

	checks := make([]Check, 0, len(e.lastSample.Disks)+len(collection.FailedMountpoints))
	seen := make(map[string]bool, len(e.lastSample.Disks)+len(collection.FailedMountpoints))
	for _, disk := range e.lastSample.Disks {
		id := diskCheckID(disk.Mountpoint)
		seen[id] = true
		checks = append(checks, e.diskCheckLocked(now, id, disk, e.state(id)))
	}
	for _, mountpoint := range collection.FailedMountpoints {
		id := diskCheckID(mountpoint)
		if seen[id] {
			continue
		}
		seen[id] = true
		checks = append(checks, e.failedDiskCheckLocked(now, id, mountpoint, e.state(id)))
	}
	sort.Slice(checks, func(i, j int) bool { return checks[i].ID < checks[j].ID })
	return checks
}

func (e *Engine) diskCheckLocked(now time.Time, id string, disk monitor.DiskStat, state *thresholdState) Check {
	value, dimension := diskValue(disk, e.rules["disk"])
	check := Check{
		ID:         id,
		Category:   "storage",
		Label:      diskLabel(disk.Mountpoint),
		Applicable: true,
		Value:      numberPointer(value),
		Unit:       stringPointer("percent"),
		Thresholds: thresholdValues(e.rules["disk"]),
		Details: DiskDetails{
			Mountpoint:          disk.Mountpoint,
			Dimension:           dimension,
			CapacityUsedPercent: disk.Percent,
			InodeUsedPercent:    copyFloatPointer(disk.InodeUsedPercent),
			TotalBytes:          disk.Total,
			UsedBytes:           disk.Used,
			AvailableBytes:      disk.Available,
		},
	}
	check.ObservedAt = state.observedAt.UTC()
	if state.observedAt.IsZero() {
		check.ObservedAt = now.UTC()
	}
	if now.Sub(state.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "挂载点数据已过期", ensureUnknownSince(state, state.observedAt.Add(e.staleWindow())))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	name := diskName(disk.Mountpoint)
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = fmt.Sprintf("%s%s使用率达到警告阈值", name, dimensionName(dimension))
		check.Since = timePointer(state.since)
	case StatusCritical:
		check.Reason = ReasonThresholdCritical
		check.Message = fmt.Sprintf("%s%s使用率达到严重阈值", name, dimensionName(dimension))
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = fmt.Sprintf("%s使用率正常", name)
	}
	return check
}

func (e *Engine) failedDiskCheckLocked(now time.Time, id, mountpoint string, state *thresholdState) Check {
	last := state.lastDisk
	check := Check{
		ID:         id,
		Category:   "storage",
		Label:      diskLabel(mountpoint),
		Applicable: true,
		Unit:       stringPointer("percent"),
		Thresholds: thresholdValues(e.rules["disk"]),
		Details: DiskDetails{
			Mountpoint:          mountpoint,
			Dimension:           "capacity",
			CapacityUsedPercent: last.Percent,
			InodeUsedPercent:    copyFloatPointer(last.InodeUsedPercent),
			TotalBytes:          last.Total,
			UsedBytes:           last.Used,
			AvailableBytes:      last.Available,
		},
	}
	if state.initialized {
		check.Value = numberPointer(state.value)
		check.ObservedAt = state.observedAt.UTC()
	}
	if check.ObservedAt.IsZero() {
		check.ObservedAt = ensureUnknownSince(state, now).UTC()
	}
	observed := state.observedAt
	if observed.IsZero() {
		observed = ensureUnknownSince(state, now)
	}
	if now.Sub(observed) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "挂载点数据已过期", ensureUnknownSince(state, observed.Add(e.staleWindow())))
	}
	return unknownCheck(check, ReasonCollectFailed, "无法读取挂载点数据", ensureUnknownSince(state, now))
}

func (e *Engine) networkCheckLocked(now time.Time) Check {
	collection := e.lastSample.Collection
	if collection.NetworkFailed {
		id := "network:default"
		label := "默认路由"
		details := NetworkDetails{}
		if nic, ok := defaultNetwork(e.lastSample.Network); ok {
			id = "network:" + nic.Name
			label = nic.Name
			details = networkDetails(nic)
		}
		observed := e.network.observedAt
		if observed.IsZero() {
			observed = ensureNetworkUnknown(&e.network, now)
		}
		check := Check{
			ID:         id,
			Category:   "network",
			Label:      label,
			Applicable: true,
			ObservedAt: observed.UTC(),
			Details:    details,
		}
		if now.Sub(observed) > e.staleWindow() {
			check.Stale = true
			return unknownCheck(check, ReasonStale, "网络数据已过期", ensureNetworkUnknown(&e.network, observed.Add(e.staleWindow())))
		}
		return unknownCheck(check, ReasonCollectFailed, "网络采集失败", ensureNetworkUnknown(&e.network, now))
	}

	nic, ok := defaultNetwork(e.lastSample.Network)
	if !ok {
		return Check{
			ID:         "network:default",
			Category:   "network",
			Label:      "默认路由",
			Status:     StatusUnknown,
			Applicable: false,
			Reason:     ReasonNoDefaultRoute,
			Message:    "未发现默认路由，不进行网络健康判定",
			ObservedAt: now.UTC(),
			Details:    NetworkDetails{IPv4: []string{}, IPv6: []string{}},
		}
	}
	check := Check{
		ID:         "network:" + nic.Name,
		Category:   "network",
		Label:      nic.Name,
		Applicable: true,
		ObservedAt: e.network.observedAt.UTC(),
		Details:    networkDetails(nic),
	}
	if now.Sub(e.network.observedAt) > e.staleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "网络数据已过期", ensureNetworkUnknown(&e.network, e.network.observedAt.Add(e.staleWindow())))
	}
	e.network.unknownSince = time.Time{}
	check.Status = e.network.status
	_, reason, message := networkStatus(nic)
	check.Reason = reason
	check.Message = message
	if check.Status != StatusHealthy {
		check.Since = timePointer(e.network.since)
	}
	return check
}

func (e *Engine) temperatureChecksLocked(now time.Time) []Check {
	if e.temperatureSampledAt.IsZero() {
		// The sampler has not produced a sample yet; the engine snapshot is not
		// exposed before the first monitor sample either.
		return nil
	}
	if len(e.temperatureSensors) == 0 {
		return []Check{{
			ID:         "temperature",
			Category:   "temperature",
			Label:      "温度",
			Status:     StatusUnknown,
			Applicable: false,
			Reason:     ReasonNotSupported,
			Message:    "未发现可用的温度传感器",
			ObservedAt: now.UTC(),
		}}
	}

	checks := make([]Check, 0, len(e.temperatureSensors))
	for _, sensor := range e.temperatureSensors {
		checks = append(checks, e.temperatureCheckLocked(now, sensor))
	}
	sort.Slice(checks, func(i, j int) bool { return checks[i].ID < checks[j].ID })
	return checks
}

func (e *Engine) temperatureCheckLocked(now time.Time, sensor temperatureSensor) Check {
	check := Check{
		ID:         sensor.ID,
		Category:   "temperature",
		Label:      sensor.Sensor,
		Applicable: true,
		Unit:       stringPointer("celsius"),
		Value:      numberPointer(sensor.Celsius),
		Details: TemperatureDetails{
			Sensor:   sensor.Sensor,
			Chip:     sensor.Chip,
			Celsius:  sensor.Celsius,
			Warning:  copyFloatPointer(sensor.Warning),
			Critical: copyFloatPointer(sensor.Critical),
		},
	}

	if sensor.Warning == nil && sensor.Critical == nil {
		// The reading is display-only: never invent a threshold and never alert.
		check.Applicable = false
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonNoThreshold, "传感器没有可信温度阈值，仅供参考", time.Time{})
	}

	state := e.state(sensor.ID)
	check.Thresholds = temperatureThresholdValues(sensor)
	check.ObservedAt = state.observedAt.UTC()
	if state.observedAt.IsZero() {
		check.ObservedAt = e.temperatureSampledAt.UTC()
	}
	if now.Sub(e.temperatureSampledAt) > e.temperatureStaleWindow() {
		check.Stale = true
		return unknownCheck(check, ReasonStale, "温度数据已过期", ensureUnknownSince(state, e.temperatureSampledAt.Add(e.temperatureStaleWindow())))
	}
	if !state.initialized {
		check.ObservedAt = now.UTC()
		return unknownCheck(check, ReasonInitializing, "正在等待温度数据", ensureUnknownSince(state, now))
	}
	state.unknownSince = time.Time{}
	check.Status = state.status
	switch state.status {
	case StatusWarning:
		check.Reason = ReasonThresholdWarning
		check.Message = "温度持续偏高"
		check.Since = timePointer(state.since)
	case StatusCritical:
		check.Reason = ReasonThresholdCritical
		check.Message = "温度持续过高"
		check.Since = timePointer(state.since)
	default:
		check.Reason = ReasonOK
		check.Message = "温度正常"
	}
	return check
}

func (e *Engine) temperatureStaleWindow() time.Duration {
	window := 3 * e.temperatureInterval
	if window < 5*time.Second {
		window = 5 * time.Second
	}
	return window
}

func (e *Engine) hostFacts() Host {
	host := e.host
	host.Platform = e.lastSample.Platform
	host.UptimeSeconds = uptimeSeconds()
	return host
}

func defaultNetwork(network []monitor.NetworkStat) (*monitor.NetworkStat, bool) {
	for i := range network {
		if network[i].IsDefaultRoute {
			return &network[i], true
		}
	}
	return nil, false
}

func networkStatus(nic *monitor.NetworkStat) (Status, Reason, string) {
	if !nic.LinkUp {
		return StatusCritical, ReasonLinkDown, fmt.Sprintf("%s 已断链", nic.Name)
	}
	if len(nic.IPv4) == 0 && len(nic.IPv6) == 0 {
		return StatusWarning, ReasonNoAddress, fmt.Sprintf("%s 没有可用地址", nic.Name)
	}
	return StatusHealthy, ReasonOK, "默认路由接口运行正常"
}

func networkDetails(nic *monitor.NetworkStat) NetworkDetails {
	return NetworkDetails{
		Interface:        nic.Name,
		LinkUp:           nic.LinkUp,
		IsDefaultRoute:   nic.IsDefaultRoute,
		IPv4:             append([]string{}, nic.IPv4...),
		IPv6:             append([]string{}, nic.IPv6...),
		RxBytesPerSecond: nic.RxRate,
		TxBytesPerSecond: nic.TxRate,
	}
}

func unknownCheck(check Check, reason Reason, message string, since time.Time) Check {
	check.Status = StatusUnknown
	check.Reason = reason
	check.Message = message
	if !since.IsZero() {
		check.Since = timePointer(since)
	}
	return check
}

func ensureUnknownSince(state *thresholdState, at time.Time) time.Time {
	if state.unknownSince.IsZero() {
		state.unknownSince = at
	}
	return state.unknownSince
}

func ensureNetworkUnknown(state *networkState, at time.Time) time.Time {
	if state.unknownSince.IsZero() {
		state.unknownSince = at
	}
	return state.unknownSince
}

func diskCheckID(mountpoint string) string {
	return "disk:" + mountpoint
}

func diskValue(disk monitor.DiskStat, r rule) (float64, string) {
	dimension := "capacity"
	value := clampPercent(disk.Percent)
	if disk.InodeUsedPercent == nil {
		return value, dimension
	}
	inode := clampPercent(*disk.InodeUsedPercent)
	if severityOfPercent(inode, r) > severityOfPercent(value, r) {
		return inode, "inode"
	}
	return value, dimension
}

func severityOfPercent(value float64, r rule) int {
	if value >= r.critical {
		return 3
	}
	if value >= r.warning {
		return 2
	}
	return 1
}

func diskLabel(mountpoint string) string {
	if mountpoint == "/" {
		return "根分区 /"
	}
	return "分区 " + mountpoint
}

func diskName(mountpoint string) string {
	if mountpoint == "/" {
		return "根分区"
	}
	return "分区 " + mountpoint
}

func dimensionName(dimension string) string {
	if dimension == "inode" {
		return " inode "
	}
	return "容量"
}

func memoryUsedPercent(memory monitor.MemoryStat) float64 {
	if memory.Total == 0 {
		return 0
	}
	return clampPercent(100 - float64(memory.Available)*100/float64(memory.Total))
}

func memoryAvailablePercent(memory monitor.MemoryStat) float64 {
	if memory.Total == 0 {
		return 0
	}
	return clampPercent(float64(memory.Available) * 100 / float64(memory.Total))
}

func usedBytes(memory monitor.MemoryStat) uint64 {
	if memory.Available >= memory.Total {
		return 0
	}
	return memory.Total - memory.Available
}

func load5PerCore(load monitor.LoadStat) float64 {
	if load.LogicalCores <= 0 {
		return 0
	}
	return load.Load5 / float64(load.LogicalCores)
}

func loadDetails(load monitor.LoadStat) LoadDetails {
	return LoadDetails{
		Load1:        load.Load1,
		Load5:        load.Load5,
		Load15:       load.Load15,
		LogicalCores: load.LogicalCores,
		Load5PerCore: load5PerCore(load),
	}
}

// swapTriggerValue collapses the compound "high usage AND active paging"
// condition into the engine's numeric state machine. The reported value stays
// the real used percentage.
func swapTriggerValue(swap monitor.SwapStat) float64 {
	highUsage := swap.UsedPercent >= swapUsageWarningPercent
	paging := swap.SwapInPerSec > 0 || swap.SwapOutPerSec > 0
	if highUsage && paging {
		return 1
	}
	return 0
}

func swapDetails(swap monitor.SwapStat) SwapDetails {
	return SwapDetails{
		TotalBytes:    swap.TotalBytes,
		UsedBytes:     swap.UsedBytes,
		UsedPercent:   swap.UsedPercent,
		SwapInPerSec:  swap.SwapInPerSec,
		SwapOutPerSec: swap.SwapOutPerSec,
	}
}

func clampPercent(value float64) float64 {
	if math.IsNaN(value) || value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func thresholdValues(r rule) *Thresholds {
	return &Thresholds{
		Warning:  numberPointer(r.warning),
		Critical: numberPointer(r.critical),
	}
}

func summarize(checks []Check) Summary {
	summary := Summary{Total: len(checks)}
	for _, check := range checks {
		if !check.Applicable {
			summary.NotApplicable++
			continue
		}
		switch check.Status {
		case StatusHealthy:
			summary.Healthy++
		case StatusWarning:
			summary.Warning++
		case StatusCritical:
			summary.Critical++
		default:
			summary.Unknown++
		}
	}
	summary.IssueCount = summary.Warning + summary.Critical
	return summary
}

func overallOf(checks []Check) Status {
	result := Status("")
	for _, check := range checks {
		if !check.Applicable {
			continue
		}
		if severity(check.Status) > severity(result) {
			result = check.Status
		}
	}
	if result == "" {
		return StatusUnknown
	}
	return result
}

func uptimeSeconds() *int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return nil
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || value < 0 {
		return nil
	}
	seconds := int64(value)
	return &seconds
}

func numberPointer(value float64) *float64 { return &value }
func stringPointer(value string) *string   { return &value }
func timePointer(value time.Time) *time.Time {
	return &value
}
func copyFloatPointer(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
