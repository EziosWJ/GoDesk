package health

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"godesk/internal/monitor"
)

var baseTime = time.Date(2026, 11, 24, 1, 0, 0, 0, time.UTC)

type fakeClock struct {
	at time.Time
}

func (c *fakeClock) Now() time.Time { return c.at }

func newTestEngine() (*Engine, *fakeClock) {
	clock := &fakeClock{at: baseTime}
	return newEngine(nil, time.Second, clock.Now), clock
}

func healthySnapshot(at time.Time) monitor.Snapshot {
	return monitor.Snapshot{
		SampledAt: at,
		Platform:  "Linux",
		CPU:       &monitor.CPUStat{Percent: 10, PerCore: []float64{10}},
		Load:      &monitor.LoadStat{Load1: 0.2, Load5: 0.3, Load15: 0.4, LogicalCores: 4},
		Memory:    &monitor.MemoryStat{Total: 100, Used: 50, Available: 50, Percent: 50},
		Swap:      &monitor.SwapStat{TotalBytes: 100, UsedBytes: 10, UsedPercent: 10, Configured: true, PagingAvailable: true},
		Disks: []monitor.DiskStat{
			{Mountpoint: "/", Total: 100, Used: 10, Percent: 10, Available: 90},
		},
		Network: []monitor.NetworkStat{
			{Name: "eth0", IPv4: []string{"192.0.2.10"}, IPv6: []string{}, LinkUp: true, IsDefaultRoute: true},
		},
	}
}

func evaluate(engine *Engine, clock *fakeClock, sample monitor.Snapshot) Snapshot {
	clock.at = sample.SampledAt
	engine.evaluateAt(sample, sample.SampledAt)
	snapshot, ok := engine.Snapshot()
	if !ok {
		return Snapshot{}
	}
	return snapshot
}

func findCheck(t *testing.T, snapshot Snapshot, id string) Check {
	t.Helper()
	for _, check := range snapshot.Checks {
		if check.ID == id {
			return check
		}
	}
	t.Fatalf("check %q not found in %v", id, checkIDs(snapshot))
	return Check{}
}

func thresholdEquals(value *float64, want float64) bool {
	return value != nil && *value == want
}

func checkIDs(snapshot Snapshot) []string {
	ids := make([]string, 0, len(snapshot.Checks))
	for _, check := range snapshot.Checks {
		ids = append(ids, check.ID)
	}
	return ids
}

func cpuSample(engine *Engine, clock *fakeClock, at time.Time, percent float64) Snapshot {
	sample := healthySnapshot(at)
	sample.CPU.Percent = percent
	sample.CPU.PerCore = []float64{percent}
	return evaluate(engine, clock, sample)
}

func memorySample(engine *Engine, clock *fakeClock, at time.Time, available uint64) Snapshot {
	sample := healthySnapshot(at)
	sample.Memory = &monitor.MemoryStat{Total: 100, Used: 100 - available, Available: available, Percent: float64(100 - available)}
	return evaluate(engine, clock, sample)
}

func cpuRule(enter, recover time.Duration) rule {
	return rule{warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: enter, recoverAfter: recover}
}

func TestCPUWarningNeedsSustainedWindow(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(10*time.Second, 3*time.Second)

	at := baseTime
	snapshot := cpuSample(engine, clock, at, 90)
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusHealthy {
		t.Fatalf("first sample status = %q, want healthy", check.Status)
	}
	if check.Value == nil || *check.Value != 90 {
		t.Fatalf("first sample value = %v, want 90", check.Value)
	}

	for i := 1; i < 10; i++ {
		snapshot = cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 90)
	}
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status before window = %q, want healthy", check.Status)
	}

	snapshot = cpuSample(engine, clock, at.Add(10*time.Second), 90)
	check = findCheck(t, snapshot, "cpu")
	if check.Status != StatusWarning || check.Reason != ReasonThresholdWarning {
		t.Fatalf("status = %q/%q, want warning/threshold_warning", check.Status, check.Reason)
	}
	if check.Since == nil || !check.Since.Equal(at) {
		t.Errorf("since = %v, want %v", check.Since, at)
	}
	if check.Thresholds == nil || !thresholdEquals(check.Thresholds.Warning, 85) || !thresholdEquals(check.Thresholds.Critical, 95) {
		t.Errorf("thresholds = %+v", check.Thresholds)
	}
	if snapshot.Summary.Warning != 1 || snapshot.Summary.IssueCount != 1 || snapshot.Overall != StatusWarning {
		t.Errorf("summary = %+v, overall = %q", snapshot.Summary, snapshot.Overall)
	}
}

func TestCPUCritical(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(5*time.Second, 2*time.Second)

	at := baseTime
	for i := 0; i <= 5; i++ {
		snapshot := cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 96)
		check := findCheck(t, snapshot, "cpu")
		if i < 5 && check.Status != StatusHealthy {
			t.Fatalf("sample %d status = %q, want healthy", i, check.Status)
		}
		if i == 5 {
			if check.Status != StatusCritical || check.Reason != ReasonThresholdCritical {
				t.Fatalf("status = %q/%q, want critical/threshold_critical", check.Status, check.Reason)
			}
			if check.Since == nil || !check.Since.Equal(at) {
				t.Errorf("since = %v, want %v", check.Since, at)
			}
		}
	}
}

func TestRecoveryHysteresis(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(time.Second, 3*time.Second)

	at := baseTime
	cpuSample(engine, clock, at, 96)
	snapshot := cpuSample(engine, clock, at.Add(time.Second), 96)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusCritical {
		t.Fatalf("status = %q, want critical", check.Status)
	}

	// 85% is below the critical recovery threshold (90) but not below the
	// warning recovery threshold (80), so it recovers to warning.
	snapshot = cpuSample(engine, clock, at.Add(2*time.Second), 85)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusCritical {
		t.Fatalf("status during recovery = %q, want critical", check.Status)
	}
	for i := 3; i <= 4; i++ {
		snapshot = cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 85)
	}
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusWarning {
		t.Fatalf("status after warning recovery = %q, want warning", check.Status)
	}
	if check.Since == nil || !check.Since.Equal(at.Add(2*time.Second)) {
		t.Errorf("warning since = %v, want %v", check.Since, at.Add(2*time.Second))
	}

	// 70% is below the healthy recovery threshold (80): warning -> healthy.
	for i := 5; i <= 7; i++ {
		snapshot = cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 70)
	}
	check = findCheck(t, snapshot, "cpu")
	if check.Status != StatusHealthy || check.Since != nil {
		t.Fatalf("status = %q, since = %v, want healthy/nil", check.Status, check.Since)
	}
}

func TestRecoveryCanSkipWarning(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(time.Second, 3*time.Second)

	at := baseTime
	cpuSample(engine, clock, at, 96)
	snapshot := cpuSample(engine, clock, at.Add(time.Second), 96)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusCritical {
		t.Fatalf("status = %q, want critical", check.Status)
	}
	for i := 2; i <= 4; i++ {
		snapshot = cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 70)
	}
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status = %q, want healthy", check.Status)
	}
}

func TestGapPausesAndResetsAccumulation(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(10*time.Second, 3*time.Second)

	at := baseTime
	for i := 0; i <= 4; i++ {
		cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 90)
	}
	// A 5 second gap only pauses; it does not reset the accumulated window.
	snapshot := cpuSample(engine, clock, at.Add(9*time.Second), 90)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status after short gap = %q, want healthy", check.Status)
	}

	// A gap longer than the freshness window discards prior accumulation.
	snapshot = cpuSample(engine, clock, at.Add(16*time.Second), 90)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status after long gap = %q, want healthy", check.Status)
	}
	for i := 17; i <= 25; i++ {
		snapshot = cpuSample(engine, clock, at.Add(time.Duration(i)*time.Second), 90)
	}
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status before new window = %q, want healthy", check.Status)
	}
	snapshot = cpuSample(engine, clock, at.Add(26*time.Second), 90)
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusWarning {
		t.Fatalf("status after new window = %q, want warning", check.Status)
	}
	if check.Since == nil || !check.Since.Equal(at.Add(16*time.Second)) {
		t.Errorf("since = %v, want %v", check.Since, at.Add(16*time.Second))
	}
}

func TestChecksBecomeStaleWithoutSamples(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	clock.at = at.Add(6 * time.Second)
	engine.refreshAt(clock.at)
	snapshot, ok := engine.Snapshot()
	if !ok {
		t.Fatal("snapshot unavailable")
	}
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusUnknown || check.Reason != ReasonStale || !check.Stale {
		t.Fatalf("status = %q/%q stale=%v, want unknown/stale stale=true", check.Status, check.Reason, check.Stale)
	}
	if check.Value == nil || *check.Value != 10 {
		t.Errorf("value = %v, want last value 10", check.Value)
	}
	if check.Since == nil || !check.Since.Equal(at.Add(5*time.Second)) {
		t.Errorf("since = %v, want %v", check.Since, at.Add(5*time.Second))
	}
	if snapshot.Overall != StatusUnknown {
		t.Errorf("overall = %q, want unknown", snapshot.Overall)
	}
	if snapshot.Stale {
		t.Error("top-level stale should be false while the engine refreshes")
	}
}

func TestStaleRecoveryRequiresNewEntryWindow(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(time.Second, 2*time.Second)
	at := baseTime
	cpuSample(engine, clock, at, 90)
	snapshot := cpuSample(engine, clock, at.Add(time.Second), 90)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusWarning {
		t.Fatalf("status = %q, want warning", check.Status)
	}

	clock.at = at.Add(7 * time.Second)
	engine.refreshAt(clock.at)
	snapshot, _ = engine.Snapshot()
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusUnknown || check.Reason != ReasonStale {
		t.Fatalf("status = %q/%q, want unknown/stale", check.Status, check.Reason)
	}

	snapshot = cpuSample(engine, clock, at.Add(8*time.Second), 90)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusHealthy {
		t.Fatalf("status after stale recovery = %q, want healthy", check.Status)
	}
	snapshot = cpuSample(engine, clock, at.Add(9*time.Second), 90)
	if check := findCheck(t, snapshot, "cpu"); check.Status != StatusWarning {
		t.Fatalf("status after re-accumulation = %q, want warning", check.Status)
	}
}

func TestCollectFailureAndStaleSinceIsPreserved(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	sample := healthySnapshot(at)
	sample.CPU = nil
	sample.Collection.CPUFailed = true
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusUnknown || check.Reason != ReasonCollectFailed || check.Value != nil {
		t.Fatalf("status = %q/%q value=%v, want unknown/collect_failed nil", check.Status, check.Reason, check.Value)
	}
	if check.Since == nil || !check.Since.Equal(at) {
		t.Errorf("since = %v, want %v", check.Since, at)
	}

	sample = healthySnapshot(at.Add(6 * time.Second))
	sample.CPU = nil
	sample.Collection.CPUFailed = true
	snapshot = evaluate(engine, clock, sample)
	check = findCheck(t, snapshot, "cpu")
	if check.Status != StatusUnknown || check.Reason != ReasonStale || !check.Stale {
		t.Fatalf("status = %q/%q stale=%v, want unknown/stale", check.Status, check.Reason, check.Stale)
	}
	if check.Since == nil || !check.Since.Equal(at) {
		t.Errorf("since = %v, want preserved %v", check.Since, at)
	}
}

func TestInitializingCheck(t *testing.T) {
	engine, clock := newTestEngine()
	sample := healthySnapshot(baseTime)
	sample.CPU = nil
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "cpu")
	if check.Status != StatusUnknown || check.Reason != ReasonInitializing {
		t.Fatalf("status = %q/%q, want unknown/initializing", check.Status, check.Reason)
	}
}

func TestMemoryUsesAvailableMemory(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["memory"] = rule{warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: 2 * time.Second, recoverAfter: time.Second}

	at := baseTime
	memorySample(engine, clock, at, 10)
	snapshot := memorySample(engine, clock, at.Add(time.Second), 10)
	if check := findCheck(t, snapshot, "memory"); check.Status != StatusHealthy {
		t.Fatalf("status before window = %q, want healthy", check.Status)
	}
	snapshot = memorySample(engine, clock, at.Add(2*time.Second), 10)
	check := findCheck(t, snapshot, "memory")
	if check.Status != StatusWarning {
		t.Fatalf("status = %q, want warning", check.Status)
	}
	if check.Value == nil || *check.Value != 90 {
		t.Errorf("value = %v, want 90", check.Value)
	}
	details, ok := check.Details.(MemoryDetails)
	if !ok {
		t.Fatalf("details type = %T", check.Details)
	}
	if details.AvailableBytes != 10 || details.AvailablePercent != 10 || details.UsedBytes != 90 {
		t.Errorf("details = %+v", details)
	}
}

func TestDiskEntryAndRecoveryUseSamples(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	diskSample := func(at time.Time, percent float64) Snapshot {
		sample := healthySnapshot(at)
		sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: uint64(percent), Percent: percent, Available: uint64(100 - int(percent))}}
		return evaluate(engine, clock, sample)
	}

	snapshot := diskSample(at, 86)
	if check := findCheck(t, snapshot, "disk:/"); check.Status != StatusHealthy {
		t.Fatalf("first sample status = %q, want healthy", check.Status)
	}
	snapshot = diskSample(at.Add(time.Second), 86)
	check := findCheck(t, snapshot, "disk:/")
	if check.Status != StatusWarning {
		t.Fatalf("second sample status = %q, want warning", check.Status)
	}
	if check.Since == nil || !check.Since.Equal(at) {
		t.Errorf("since = %v, want %v", check.Since, at)
	}
	if check.Label != "根分区 /" {
		t.Errorf("label = %q", check.Label)
	}
	details := check.Details.(DiskDetails)
	if details.Dimension != "capacity" || details.CapacityUsedPercent != 86 {
		t.Errorf("details = %+v", details)
	}

	snapshot = diskSample(at.Add(2*time.Second), 79)
	if check := findCheck(t, snapshot, "disk:/"); check.Status != StatusWarning {
		t.Fatalf("status during recovery = %q, want warning", check.Status)
	}
	snapshot = diskSample(at.Add(3*time.Second), 79)
	if check := findCheck(t, snapshot, "disk:/"); check.Status != StatusHealthy {
		t.Fatalf("status after recovery = %q, want healthy", check.Status)
	}
}

func TestDiskUsesWorseDimension(t *testing.T) {
	engine, clock := newTestEngine()
	inode := 96.0
	sample := healthySnapshot(baseTime)
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 10, Percent: 10, Available: 90, InodeUsedPercent: &inode}}
	first := evaluate(engine, clock, sample)
	if check := findCheck(t, first, "disk:/"); check.Status != StatusHealthy {
		t.Fatalf("first sample status = %q, want healthy", check.Status)
	}
	sample = healthySnapshot(baseTime.Add(time.Second))
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 10, Percent: 10, Available: 90, InodeUsedPercent: &inode}}
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "disk:/")
	if check.Status != StatusCritical {
		t.Fatalf("status = %q, want critical", check.Status)
	}
	if check.Value == nil || *check.Value != 96 {
		t.Errorf("value = %v, want inode 96", check.Value)
	}
	details := check.Details.(DiskDetails)
	if details.Dimension != "inode" || details.InodeUsedPercent == nil || *details.InodeUsedPercent != 96 {
		t.Errorf("details = %+v", details)
	}
}

func TestDiskTiePrefersCapacityAndMissingInode(t *testing.T) {
	engine, clock := newTestEngine()
	inode := 96.0
	sample := healthySnapshot(baseTime)
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 96, Percent: 96, Available: 4, InodeUsedPercent: &inode}}
	evaluate(engine, clock, sample)
	sample = healthySnapshot(baseTime.Add(time.Second))
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 96, Percent: 96, Available: 4, InodeUsedPercent: &inode}}
	snapshot := evaluate(engine, clock, sample)
	if details := findCheck(t, snapshot, "disk:/").Details.(DiskDetails); details.Dimension != "capacity" {
		t.Errorf("dimension = %q, want capacity", details.Dimension)
	}

	engine, clock = newTestEngine()
	sample = healthySnapshot(baseTime)
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 90, Percent: 90, Available: 10}}
	evaluate(engine, clock, sample)
	sample = healthySnapshot(baseTime.Add(time.Second))
	sample.Disks = []monitor.DiskStat{{Mountpoint: "/", Total: 100, Used: 90, Percent: 90, Available: 10}}
	snapshot = evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "disk:/")
	if check.Status != StatusWarning {
		t.Fatalf("status = %q, want warning", check.Status)
	}
	details := check.Details.(DiskDetails)
	if details.InodeUsedPercent != nil || details.Dimension != "capacity" {
		t.Errorf("details = %+v", details)
	}
}

func TestDiskFailureAndNotApplicable(t *testing.T) {
	engine, clock := newTestEngine()
	sample := healthySnapshot(baseTime)
	sample.Disks = nil
	sample.Collection.FailedMountpoints = []string{"/data"}
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "disk:/data")
	if check.Status != StatusUnknown || check.Reason != ReasonCollectFailed || !check.Applicable {
		t.Fatalf("status = %q/%q applicable=%v", check.Status, check.Reason, check.Applicable)
	}
	if snapshot.Summary.Unknown != 1 || snapshot.Summary.IssueCount != 0 {
		t.Errorf("summary = %+v", snapshot.Summary)
	}

	engine, clock = newTestEngine()
	sample = healthySnapshot(baseTime)
	sample.Disks = nil
	snapshot = evaluate(engine, clock, sample)
	check = findCheck(t, snapshot, "disk")
	if check.Applicable || check.Reason != ReasonNotSupported {
		t.Fatalf("disk applicable=%v reason=%q, want not supported", check.Applicable, check.Reason)
	}
	if snapshot.Summary.NotApplicable != 1 {
		t.Errorf("notApplicable = %d, want 1", snapshot.Summary.NotApplicable)
	}
	if snapshot.Overall != StatusHealthy {
		t.Errorf("overall = %q, want healthy", snapshot.Overall)
	}

	engine, clock = newTestEngine()
	sample = healthySnapshot(baseTime)
	sample.Disks = nil
	sample.Collection.DisksFailed = true
	snapshot = evaluate(engine, clock, sample)
	check = findCheck(t, snapshot, "disk")
	if !check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("disk applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}
	if check.Since == nil {
		t.Error("disk failure since is nil")
	}
}

func TestNetworkRules(t *testing.T) {
	tests := []struct {
		name       string
		network    []monitor.NetworkStat
		status     Status
		reason     Reason
		applicable bool
	}{
		{
			name:       "link down",
			network:    []monitor.NetworkStat{{Name: "eth0", LinkUp: false, IsDefaultRoute: true, IPv4: []string{}, IPv6: []string{}}},
			status:     StatusCritical,
			reason:     ReasonLinkDown,
			applicable: true,
		},
		{
			name:       "no address",
			network:    []monitor.NetworkStat{{Name: "eth0", LinkUp: true, IsDefaultRoute: true, IPv4: []string{}, IPv6: []string{}}},
			status:     StatusWarning,
			reason:     ReasonNoAddress,
			applicable: true,
		},
		{
			name:       "healthy",
			network:    []monitor.NetworkStat{{Name: "eth0", LinkUp: true, IsDefaultRoute: true, IPv4: []string{"192.0.2.10"}, IPv6: []string{}}},
			status:     StatusHealthy,
			reason:     ReasonOK,
			applicable: true,
		},
		{
			name:       "no default route",
			network:    []monitor.NetworkStat{{Name: "eth1", LinkUp: true, IsDefaultRoute: false, IPv4: []string{"192.0.2.11"}}},
			status:     StatusUnknown,
			reason:     ReasonNoDefaultRoute,
			applicable: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			engine, clock := newTestEngine()
			sample := healthySnapshot(baseTime)
			sample.Network = test.network
			snapshot := evaluate(engine, clock, sample)
			id := "network:eth0"
			if !test.applicable {
				id = "network:default"
			}
			check := findCheck(t, snapshot, id)
			if check.Status != test.status || check.Reason != test.reason || check.Applicable != test.applicable {
				t.Fatalf("status=%q reason=%q applicable=%v", check.Status, check.Reason, check.Applicable)
			}
			if test.applicable && test.status != StatusHealthy && check.Since == nil {
				t.Error("issue since is nil")
			}
			if test.applicable && check.Value != nil {
				t.Errorf("network value = %v, want null", check.Value)
			}
		})
	}
}

func TestNetworkCollectFailure(t *testing.T) {
	engine, clock := newTestEngine()
	sample := healthySnapshot(baseTime)
	sample.Network = nil
	sample.Collection.NetworkFailed = true
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "network:default")
	if !check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("status=%q reason=%q applicable=%v", check.Status, check.Reason, check.Applicable)
	}
}

func TestSummaryInvariantsAndOrdering(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["memory"] = rule{warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: time.Second, recoverAfter: time.Second}

	at := baseTime
	sample := healthySnapshot(at)
	sample.Memory = &monitor.MemoryStat{Total: 100, Used: 90, Available: 10, Percent: 90}
	sample.Disks = []monitor.DiskStat{
		{Mountpoint: "/home", Total: 100, Used: 10, Percent: 10, Available: 90},
		{Mountpoint: "/", Total: 100, Used: 10, Percent: 10, Available: 90},
	}
	sample.Collection.FailedMountpoints = []string{"/data"}
	evaluate(engine, clock, sample)

	sample = healthySnapshot(at.Add(time.Second))
	sample.Memory = &monitor.MemoryStat{Total: 100, Used: 90, Available: 10, Percent: 90}
	sample.Disks = []monitor.DiskStat{
		{Mountpoint: "/home", Total: 100, Used: 10, Percent: 10, Available: 90},
		{Mountpoint: "/", Total: 100, Used: 10, Percent: 10, Available: 90},
	}
	sample.Collection.FailedMountpoints = []string{"/data"}
	snapshot := evaluate(engine, clock, sample)

	wantIDs := []string{"cpu", "load", "memory", "swap", "disk:/", "disk:/data", "disk:/home", "network:eth0"}
	gotIDs := checkIDs(snapshot)
	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("ids = %v, want %v", gotIDs, wantIDs)
	}
	for i := range wantIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Fatalf("ids = %v, want %v", gotIDs, wantIDs)
		}
	}

	summary := snapshot.Summary
	if summary.Total != len(snapshot.Checks) {
		t.Errorf("total = %d, checks = %d", summary.Total, len(snapshot.Checks))
	}
	if summary.Total != summary.Healthy+summary.Warning+summary.Critical+summary.Unknown+summary.NotApplicable {
		t.Errorf("summary counts do not add up: %+v", summary)
	}
	if summary.Warning != 1 || summary.Unknown != 1 || summary.IssueCount != 1 {
		t.Errorf("summary = %+v", summary)
	}
	if snapshot.Overall != StatusWarning {
		t.Errorf("overall = %q, want warning even with unknown checks", snapshot.Overall)
	}
}

func TestTopLevelStale(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	clock.at = at.Add(16 * time.Second)
	snapshot, ok := engine.Snapshot()
	if !ok {
		t.Fatal("snapshot unavailable")
	}
	if !snapshot.Stale {
		t.Error("stale = false, want true")
	}
	if !snapshot.GeneratedAt.Equal(at) {
		t.Errorf("generatedAt = %v, want %v", snapshot.GeneratedAt, at)
	}
}

func TestStatusEndpoint(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	mux := http.NewServeMux()
	engine.Register(mux, func(next http.Handler) http.Handler { return next })
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/status", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if raw["schemaVersion"] != float64(1) {
		t.Errorf("schemaVersion = %v", raw["schemaVersion"])
	}
	if generated, ok := raw["generatedAt"].(string); !ok {
		t.Errorf("generatedAt = %v", raw["generatedAt"])
	} else if _, err := time.Parse(time.RFC3339, generated); err != nil {
		t.Errorf("generatedAt %q is not RFC 3339: %v", generated, err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(recorder.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Overall != StatusHealthy || snapshot.Host.Architecture == "" {
		t.Errorf("snapshot = %+v", snapshot)
	}
	if snapshot.Host.UptimeSeconds != nil && *snapshot.Host.UptimeSeconds <= 0 {
		t.Errorf("uptime = %v", *snapshot.Host.UptimeSeconds)
	}
}

func TestStatusEndpointUnavailable(t *testing.T) {
	engine := newEngine(nil, time.Second, time.Now)
	mux := http.NewServeMux()
	engine.Register(mux, func(next http.Handler) http.Handler { return next })
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/status", nil))

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var body errorBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "health_unavailable" {
		t.Errorf("code = %q, want health_unavailable", body.Code)
	}
}

func TestStatusEndpointRequiresSession(t *testing.T) {
	engine := newEngine(nil, time.Second, time.Now)
	mux := http.NewServeMux()
	engine.Register(mux, func(http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "login required", http.StatusUnauthorized)
		})
	})
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/system/status", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestClampPercent(t *testing.T) {
	if got := clampPercent(math.NaN()); got != 0 {
		t.Errorf("NaN = %v", got)
	}
	if got := clampPercent(-1); got != 0 {
		t.Errorf("-1 = %v", got)
	}
	if got := clampPercent(120); got != 100 {
		t.Errorf("120 = %v", got)
	}
}

func TestEngineWithRealCollector(t *testing.T) {
	collector := monitor.Start(t.Context(), 10*time.Millisecond)
	t.Cleanup(collector.Close)
	engine := Start(t.Context(), collector, 10*time.Millisecond)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, ok := engine.Snapshot()
		if ok && len(snapshot.Checks) >= 3 {
			if snapshot.SchemaVersion != SchemaVersion {
				t.Errorf("schemaVersion = %d", snapshot.SchemaVersion)
			}
			if snapshot.GeneratedAt.IsZero() {
				t.Error("generatedAt is zero")
			}
			ids := checkIDs(snapshot)
			for _, want := range []string{"cpu", "memory"} {
				found := false
				for _, id := range ids {
					if id == want {
						found = true
					}
				}
				if !found {
					t.Errorf("check %q missing from %v", want, ids)
				}
			}
			summary := snapshot.Summary
			if summary.Total != summary.Healthy+summary.Warning+summary.Critical+summary.Unknown+summary.NotApplicable {
				t.Errorf("summary counts do not add up: %+v", summary)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("health engine did not produce a snapshot")
}

// --- V2: temperature ---

func tempSensors(celsius float64, warning, critical *float64) []temperatureSensor {
	return []temperatureSensor{{
		ID:       temperatureCheckID("test/sensor0"),
		Sensor:   "sensor0",
		Chip:     "test",
		Celsius:  celsius,
		Warning:  warning,
		Critical: critical,
	}}
}

func TestTemperatureThresholdsAndHysteresis(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	warning, critical := 80.0, 95.0
	ts := at
	step := func(delta time.Duration, celsius float64) Snapshot {
		ts = ts.Add(delta)
		clock.at = ts
		engine.evaluateTemperatureAt(tempSensors(celsius, &warning, &critical), ts)
		snapshot, _ := engine.Snapshot()
		return snapshot
	}

	snapshot := step(0, 70)
	check := findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusHealthy || check.Reason != ReasonOK {
		t.Fatalf("initial status = %q/%q, want healthy/ok", check.Status, check.Reason)
	}
	if check.Value == nil || *check.Value != 70 || check.Unit == nil || *check.Unit != "celsius" {
		t.Fatalf("value/unit = %v/%v, want 70/celsius", check.Value, check.Unit)
	}
	if !thresholdEquals(check.Thresholds.Warning, 80) || !thresholdEquals(check.Thresholds.Critical, 95) {
		t.Fatalf("thresholds = %+v", check.Thresholds)
	}
	details, ok := check.Details.(TemperatureDetails)
	if !ok || details.Sensor != "sensor0" || details.Chip != "test" || details.Celsius != 70 {
		t.Fatalf("details = %#v", check.Details)
	}

	// Sustained warning above 80 for the 2 minute window (5s samples).
	for i := 0; i < 24; i++ {
		snapshot = step(5*time.Second, 85)
	}
	check = findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusWarning || check.Reason != ReasonThresholdWarning {
		t.Fatalf("status = %q/%q, want warning/threshold_warning", check.Status, check.Reason)
	}
	if check.Since == nil || !check.Since.Equal(at.Add(5*time.Second)) {
		t.Errorf("warning since = %v, want %v", check.Since, at.Add(5*time.Second))
	}

	// Sustained critical above 95.
	for i := 0; i < 24; i++ {
		snapshot = step(5*time.Second, 100)
	}
	check = findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusCritical || check.Reason != ReasonThresholdCritical {
		t.Fatalf("status = %q/%q, want critical/threshold_critical", check.Status, check.Reason)
	}

	// 85 is below the critical recovery threshold (90) but above the warning
	// recovery threshold (75), so the check falls back to warning.
	for i := 0; i < 12; i++ {
		snapshot = step(5*time.Second, 85)
	}
	check = findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusWarning {
		t.Fatalf("status during warning recovery = %q, want warning", check.Status)
	}

	// 70 is below the recovery threshold: warning -> healthy.
	for i := 0; i < 12; i++ {
		snapshot = step(5*time.Second, 70)
	}
	check = findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusHealthy || check.Since != nil {
		t.Fatalf("status = %q, since = %v, want healthy/nil", check.Status, check.Since)
	}
}

func TestTemperatureOnlyCriticalThreshold(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	critical := 90.0
	ts := at
	step := func(celsius float64) Snapshot {
		ts = ts.Add(5 * time.Second)
		clock.at = ts
		engine.evaluateTemperatureAt(tempSensors(celsius, nil, &critical), ts)
		snapshot, _ := engine.Snapshot()
		return snapshot
	}

	// Initialise below the critical threshold.
	stepped := step(60)
	check := findCheck(t, stepped, "temperature:test/sensor0")
	if check.Thresholds.Warning != nil || !thresholdEquals(check.Thresholds.Critical, 90) {
		t.Fatalf("thresholds = %+v, want warning=null critical=90", check.Thresholds)
	}
	for i := 0; i < 24; i++ {
		stepped = step(95)
	}
	check = findCheck(t, stepped, "temperature:test/sensor0")
	if check.Status != StatusCritical {
		t.Fatalf("status = %q, want critical", check.Status)
	}
	// 80 is more than 5 degrees below the critical threshold: direct recovery.
	for i := 0; i < 12; i++ {
		stepped = step(80)
	}
	check = findCheck(t, stepped, "temperature:test/sensor0")
	if check.Status != StatusHealthy {
		t.Fatalf("status after recovery = %q, want healthy", check.Status)
	}
}

func TestTemperatureOnlyWarningThreshold(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))

	warning := 80.0
	ts := at
	step := func(celsius float64) Snapshot {
		ts = ts.Add(5 * time.Second)
		clock.at = ts
		engine.evaluateTemperatureAt(tempSensors(celsius, &warning, nil), ts)
		snapshot, _ := engine.Snapshot()
		return snapshot
	}

	step(70)
	for i := 0; i < 24; i++ {
		step(85)
	}
	snapshot := step(150)
	check := findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusWarning {
		t.Fatalf("status = %q, want warning", check.Status)
	}
	if check.Thresholds.Critical != nil {
		t.Errorf("critical threshold = %v, want null", check.Thresholds.Critical)
	}
}

func TestTemperatureWithoutThresholdIsNotApplicable(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))
	engine.evaluateTemperatureAt(tempSensors(55, nil, nil), at.Add(time.Second))
	snapshot, _ := engine.Snapshot()

	check := findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonNoThreshold {
		t.Fatalf("applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}
	if check.Value == nil || *check.Value != 55 {
		t.Errorf("value = %v, want preserved 55", check.Value)
	}
	details := check.Details.(TemperatureDetails)
	if details.Celsius != 55 {
		t.Errorf("details celsius = %v, want 55", details.Celsius)
	}
	if check.Thresholds != nil || check.Since != nil || check.Stale {
		t.Errorf("thresholds=%v since=%v stale=%v", check.Thresholds, check.Since, check.Stale)
	}
	if snapshot.Summary.NotApplicable != 1 || snapshot.Summary.IssueCount != 0 || snapshot.Summary.Unknown != 0 {
		t.Errorf("summary = %+v", snapshot.Summary)
	}
	if snapshot.Overall != StatusHealthy {
		t.Errorf("overall = %q, want healthy", snapshot.Overall)
	}
}

func TestTemperatureNotSupported(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))
	engine.evaluateTemperatureAt(nil, at.Add(time.Second))
	snapshot, _ := engine.Snapshot()

	check := findCheck(t, snapshot, "temperature")
	if check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonNotSupported {
		t.Fatalf("applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}
	if check.Category != "temperature" || check.Value != nil || check.Stale {
		t.Errorf("category=%q value=%v stale=%v", check.Category, check.Value, check.Stale)
	}
	if snapshot.Summary.NotApplicable != 1 || snapshot.Summary.IssueCount != 0 {
		t.Errorf("summary = %+v", snapshot.Summary)
	}
	if snapshot.Overall != StatusHealthy {
		t.Errorf("overall = %q, want healthy", snapshot.Overall)
	}
}

func TestTemperatureBecomesStale(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))
	warning, critical := 80.0, 95.0
	engine.evaluateTemperatureAt(tempSensors(70, &warning, &critical), at)

	clock.at = at.Add(16 * time.Second)
	engine.refreshAt(clock.at)
	snapshot, _ := engine.Snapshot()
	check := findCheck(t, snapshot, "temperature:test/sensor0")
	if check.Status != StatusUnknown || check.Reason != ReasonStale || !check.Stale {
		t.Fatalf("status=%q reason=%q stale=%v, want unknown/stale stale=true", check.Status, check.Reason, check.Stale)
	}
	if check.Value == nil || *check.Value != 70 {
		t.Errorf("value = %v, want last reading 70", check.Value)
	}
}

func TestSysfsTemperatureSampler(t *testing.T) {
	root := t.TempDir()
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/name"), "coretemp")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp1_input"), "45000")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp1_label"), "Package id 0")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp1_max"), "80000")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp1_crit"), "100000")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp2_input"), "-1000")
	writeSysFile(t, filepath.Join(root, "sys/class/hwmon/hwmon0/temp3_input"), "50000")

	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/type"), "x86_pkg_temp")
	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/temp"), "47000")
	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/trip_point_0_type"), "passive")
	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/trip_point_0_temp"), "85000")
	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/trip_point_1_type"), "critical")
	writeSysFile(t, filepath.Join(root, "sys/class/thermal/thermal_zone0/trip_point_1_temp"), "100000")

	sampler := &sysfsTemperatureSampler{root: root}
	sensors := sampler.Sample()
	if len(sensors) != 3 {
		t.Fatalf("sensors = %#v, want 3", sensors)
	}

	byID := make(map[string]temperatureSensor, len(sensors))
	for _, sensor := range sensors {
		byID[sensor.ID] = sensor
	}

	hwmon := byID[temperatureCheckID("coretemp/Package id 0")]
	if hwmon.Celsius != 45 || hwmon.Warning == nil || *hwmon.Warning != 80 || hwmon.Critical == nil || *hwmon.Critical != 100 {
		t.Errorf("hwmon sensor = %+v", hwmon)
	}
	if hwmon.Sensor != "Package id 0" || hwmon.Chip != "coretemp" {
		t.Errorf("hwmon sensor identity = %+v", hwmon)
	}

	plain := byID[temperatureCheckID("coretemp/temp3")]
	if plain.Celsius != 50 || plain.Warning != nil || plain.Critical != nil || plain.Sensor != "temp3" {
		t.Errorf("threshold-less sensor = %+v", plain)
	}

	thermal := byID[temperatureCheckID("thermal/x86_pkg_temp")]
	if thermal.Celsius != 47 || thermal.Warning == nil || *thermal.Warning != 85 || thermal.Critical == nil || *thermal.Critical != 100 {
		t.Errorf("thermal sensor = %+v", thermal)
	}

	if _, ok := byID[temperatureCheckID("coretemp/temp2")]; ok {
		t.Error("non-positive sensor reading should be ignored")
	}

	empty := (&sysfsTemperatureSampler{root: t.TempDir()}).Sample()
	if len(empty) != 0 {
		t.Errorf("empty root sensors = %#v, want none", empty)
	}
}

func writeSysFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Real /sys/class/hwmon/hwmon* and /sys/class/thermal/thermal_zone* entries are
// symlinks into the device tree; the sampler must follow them.
func TestSysfsTemperatureSamplerFollowsSymlinks(t *testing.T) {
	root := t.TempDir()

	hwmonDevice := filepath.Join(root, "devices/platform/coretemp.0/hwmon/hwmon0")
	writeSysFile(t, filepath.Join(hwmonDevice, "name"), "coretemp")
	writeSysFile(t, filepath.Join(hwmonDevice, "temp1_input"), "45000")
	writeSysFile(t, filepath.Join(hwmonDevice, "temp1_label"), "Package id 0")
	writeSysFile(t, filepath.Join(hwmonDevice, "temp1_max"), "80000")
	writeSysFile(t, filepath.Join(hwmonDevice, "temp1_crit"), "100000")

	thermalDevice := filepath.Join(root, "devices/virtual/thermal/thermal_zone0")
	writeSysFile(t, filepath.Join(thermalDevice, "type"), "x86_pkg_temp")
	writeSysFile(t, filepath.Join(thermalDevice, "temp"), "47000")
	writeSysFile(t, filepath.Join(thermalDevice, "trip_point_0_type"), "passive")
	writeSysFile(t, filepath.Join(thermalDevice, "trip_point_0_temp"), "85000")
	writeSysFile(t, filepath.Join(thermalDevice, "trip_point_1_type"), "critical")
	writeSysFile(t, filepath.Join(thermalDevice, "trip_point_1_temp"), "100000")

	hwmonClass := filepath.Join(root, "sys/class/hwmon")
	thermalClass := filepath.Join(root, "sys/class/thermal")
	for _, dir := range []string{hwmonClass, thermalClass} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join("..", "..", "..", "devices/platform/coretemp.0/hwmon/hwmon0"), filepath.Join(hwmonClass, "hwmon0")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "..", "devices/virtual/thermal/thermal_zone0"), filepath.Join(thermalClass, "thermal_zone0")); err != nil {
		t.Fatal(err)
	}
	// Broken symlinks and plain files must be skipped without failing the scan.
	if err := os.Symlink(filepath.Join("..", "..", "..", "devices/missing/hwmon"), filepath.Join(hwmonClass, "hwmon1")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(thermalClass, "thermal_zone1"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}

	sensors := (&sysfsTemperatureSampler{root: root}).Sample()
	if len(sensors) != 2 {
		t.Fatalf("sensors = %#v, want 2", sensors)
	}
	byID := make(map[string]temperatureSensor, len(sensors))
	for _, sensor := range sensors {
		byID[sensor.ID] = sensor
	}

	hwmon := byID[temperatureCheckID("coretemp/Package id 0")]
	if hwmon.Celsius != 45 || hwmon.Warning == nil || *hwmon.Warning != 80 || hwmon.Critical == nil || *hwmon.Critical != 100 {
		t.Errorf("symlinked hwmon sensor = %+v", hwmon)
	}
	thermal := byID[temperatureCheckID("thermal/x86_pkg_temp")]
	if thermal.Celsius != 47 || thermal.Warning == nil || *thermal.Warning != 85 || thermal.Critical == nil || *thermal.Critical != 100 {
		t.Errorf("symlinked thermal sensor = %+v", thermal)
	}
}

// --- V2: load average ---

func loadSample(engine *Engine, clock *fakeClock, at time.Time, load5 float64, cores int) Snapshot {
	sample := healthySnapshot(at)
	sample.Load = &monitor.LoadStat{Load1: load5 / 2, Load5: load5, Load15: load5 * 2, LogicalCores: cores}
	return evaluate(engine, clock, sample)
}

func TestLoadUsesLoad5PerCoreWithHysteresis(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["load"] = rule{warning: 1.5, critical: 3.0, recoverHealthy: 1.0, recoverWarning: 2.5, enterAfter: 10 * time.Second, recoverAfter: 3 * time.Second}

	at := baseTime
	snapshot := loadSample(engine, clock, at, 6, 4) // 1.5 per core
	check := findCheck(t, snapshot, "load")
	if check.Status != StatusHealthy {
		t.Fatalf("first sample status = %q, want healthy", check.Status)
	}
	if check.Value == nil || *check.Value != 1.5 {
		t.Fatalf("value = %v, want load5PerCore 1.5", check.Value)
	}
	details := check.Details.(LoadDetails)
	if details.Load1 != 3 || details.Load5 != 6 || details.Load15 != 12 || details.LogicalCores != 4 || details.Load5PerCore != 1.5 {
		t.Errorf("details = %+v", details)
	}
	if !thresholdEquals(check.Thresholds.Warning, 1.5) || !thresholdEquals(check.Thresholds.Critical, 3.0) {
		t.Errorf("thresholds = %+v", check.Thresholds)
	}

	for i := 1; i < 10; i++ {
		snapshot = loadSample(engine, clock, at.Add(time.Duration(i)*time.Second), 6, 4)
	}
	if check := findCheck(t, snapshot, "load"); check.Status != StatusHealthy {
		t.Fatalf("status before window = %q, want healthy", check.Status)
	}

	snapshot = loadSample(engine, clock, at.Add(10*time.Second), 6, 4)
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusWarning || check.Reason != ReasonThresholdWarning {
		t.Fatalf("status = %q/%q, want warning", check.Status, check.Reason)
	}
	if check.Since == nil || !check.Since.Equal(at) {
		t.Errorf("since = %v, want %v", check.Since, at)
	}

	// 3.0 per core is critical after the entry window.
	for i := 11; i <= 20; i++ {
		snapshot = loadSample(engine, clock, at.Add(time.Duration(i)*time.Second), 12, 4)
	}
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusCritical || check.Reason != ReasonThresholdCritical {
		t.Fatalf("status = %q/%q, want critical", check.Status, check.Reason)
	}

	// 2.0 is below the critical recovery threshold (2.5) but above the warning
	// recovery threshold (1.0): critical -> warning.
	for i := 21; i <= 23; i++ {
		snapshot = loadSample(engine, clock, at.Add(time.Duration(i)*time.Second), 8, 4)
	}
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusWarning {
		t.Fatalf("status during recovery = %q, want warning", check.Status)
	}

	// 0.5 per core recovers to healthy.
	for i := 24; i <= 26; i++ {
		snapshot = loadSample(engine, clock, at.Add(time.Duration(i)*time.Second), 2, 4)
	}
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusHealthy || check.Since != nil {
		t.Fatalf("status = %q, since = %v, want healthy/nil", check.Status, check.Since)
	}
}

func TestLoadUnavailableStates(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	sample := healthySnapshot(at)
	sample.Load = nil
	sample.Collection.LoadFailed = true
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "load")
	if !check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}

	clock.at = at.Add(6 * time.Second)
	engine.refreshAt(clock.at)
	snapshot, _ = engine.Snapshot()
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusUnknown || check.Reason != ReasonStale || !check.Stale {
		t.Fatalf("status=%q reason=%q stale=%v, want unknown/stale", check.Status, check.Reason, check.Stale)
	}

	engine, clock = newTestEngine()
	sample = healthySnapshot(at)
	sample.Load = nil
	snapshot = evaluate(engine, clock, sample)
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusUnknown || check.Reason != ReasonInitializing {
		t.Fatalf("status=%q reason=%q, want unknown/initializing", check.Status, check.Reason)
	}

	engine, clock = newTestEngine()
	sample = healthySnapshot(at)
	sample.Load = &monitor.LoadStat{Load5: 2, LogicalCores: 0}
	snapshot = evaluate(engine, clock, sample)
	check = findCheck(t, snapshot, "load")
	if check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("zero core status=%q reason=%q, want unknown/collect_failed", check.Status, check.Reason)
	}
}

func TestLoadBecomesStale(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	evaluate(engine, clock, healthySnapshot(at))
	clock.at = at.Add(6 * time.Second)
	engine.refreshAt(clock.at)
	snapshot, _ := engine.Snapshot()
	check := findCheck(t, snapshot, "load")
	if check.Status != StatusUnknown || check.Reason != ReasonStale || !check.Stale {
		t.Fatalf("status=%q reason=%q stale=%v, want stale", check.Status, check.Reason, check.Stale)
	}
}

// --- V2: swap ---

func swapSample(engine *Engine, clock *fakeClock, at time.Time, swap monitor.SwapStat) Snapshot {
	sample := healthySnapshot(at)
	sample.Swap = &swap
	return evaluate(engine, clock, sample)
}

func TestSwapUnconfiguredIsNotApplicable(t *testing.T) {
	engine, clock := newTestEngine()
	snapshot := swapSample(engine, clock, baseTime, monitor.SwapStat{Configured: false})
	check := findCheck(t, snapshot, "swap")
	if check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonNotSupported {
		t.Fatalf("applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}
	if check.Value != nil || check.Stale {
		t.Errorf("value=%v stale=%v", check.Value, check.Stale)
	}
	if snapshot.Summary.NotApplicable != 1 || snapshot.Summary.IssueCount != 0 {
		t.Errorf("summary = %+v", snapshot.Summary)
	}
	if snapshot.Overall != StatusHealthy {
		t.Errorf("overall = %q, want healthy", snapshot.Overall)
	}

	// A zero total is not usable even if the collector briefly marks it configured.
	engine, clock = newTestEngine()
	snapshot = swapSample(engine, clock, baseTime, monitor.SwapStat{Configured: true, TotalBytes: 0})
	check = findCheck(t, snapshot, "swap")
	if check.Applicable || check.Reason != ReasonNotSupported {
		t.Fatalf("zero total applicable=%v reason=%q, want not_supported", check.Applicable, check.Reason)
	}
}

func TestSwapHighUsageWithoutPagingStaysHealthy(t *testing.T) {
	engine, clock := newTestEngine()
	at := baseTime
	for i := 0; i < 20; i++ {
		snapshot := swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), monitor.SwapStat{
			TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true, PagingAvailable: true,
		})
		check := findCheck(t, snapshot, "swap")
		if check.Status != StatusHealthy || check.Reason != ReasonOK {
			t.Fatalf("sample %d status = %q/%q, want healthy/ok", i, check.Status, check.Reason)
		}
		if check.Value == nil || *check.Value != 90 {
			t.Fatalf("value = %v, want 90", check.Value)
		}
		details := check.Details.(SwapDetails)
		if details.UsedPercent != 90 || details.SwapInPerSec != 0 || details.SwapOutPerSec != 0 {
			t.Errorf("details = %+v", details)
		}
	}
}

func TestSwapNeedsHighUsageAndPaging(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["swap"] = rule{warning: 1, critical: unreachableThreshold, recoverHealthy: 0.5, recoverWarning: unreachableThreshold, enterAfter: 10 * time.Second, recoverAfter: 3 * time.Second}
	at := baseTime

	// High usage alone must not trigger.
	for i := 0; i < 15; i++ {
		snapshot := swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), monitor.SwapStat{
			TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true, PagingAvailable: true,
		})
		if check := findCheck(t, snapshot, "swap"); check.Status != StatusHealthy {
			t.Fatalf("high usage without paging status = %q, want healthy", check.Status)
		}
	}

	// Paging at low usage must not trigger either.
	for i := 15; i < 30; i++ {
		snapshot := swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), monitor.SwapStat{
			TotalBytes: 1000, UsedBytes: 100, UsedPercent: 10, Configured: true, PagingAvailable: true, SwapOutPerSec: 4096,
		})
		if check := findCheck(t, snapshot, "swap"); check.Status != StatusHealthy {
			t.Fatalf("paging at low usage status = %q, want healthy", check.Status)
		}
	}

	// High usage plus sustained paging warns after 10 seconds.
	var snapshot Snapshot
	for i := 30; i <= 40; i++ {
		snapshot = swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), monitor.SwapStat{
			TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true, PagingAvailable: true, SwapInPerSec: 2048,
		})
	}
	check := findCheck(t, snapshot, "swap")
	if check.Status != StatusWarning || check.Reason != ReasonThresholdWarning {
		t.Fatalf("status = %q/%q, want warning", check.Status, check.Reason)
	}
	if check.Since == nil || !check.Since.Equal(at.Add(30*time.Second)) {
		t.Errorf("since = %v, want %v", check.Since, at.Add(30*time.Second))
	}
	details := check.Details.(SwapDetails)
	if details.UsedPercent != 90 || details.SwapInPerSec != 2048 {
		t.Errorf("details = %+v", details)
	}

	// Paging stops: the warning clears after the recovery window.
	for i := 41; i <= 43; i++ {
		snapshot = swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), monitor.SwapStat{
			TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true, PagingAvailable: true,
		})
	}
	check = findCheck(t, snapshot, "swap")
	if check.Status != StatusHealthy || check.Since != nil {
		t.Fatalf("status after recovery = %q, since = %v, want healthy/nil", check.Status, check.Since)
	}
}

func TestSwapCollectFailure(t *testing.T) {
	engine, clock := newTestEngine()
	sample := healthySnapshot(baseTime)
	sample.Swap = nil
	sample.Collection.SwapFailed = true
	snapshot := evaluate(engine, clock, sample)
	check := findCheck(t, snapshot, "swap")
	if !check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("applicable=%v status=%q reason=%q", check.Applicable, check.Status, check.Reason)
	}
}

func TestSwapPagingUnavailableIsUnknown(t *testing.T) {
	engine, clock := newTestEngine()
	snapshot := swapSample(engine, clock, baseTime, monitor.SwapStat{
		TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true,
	})
	check := findCheck(t, snapshot, "swap")
	if !check.Applicable || check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
		t.Fatalf("applicable=%v status=%q reason=%q, want unknown/collect_failed", check.Applicable, check.Status, check.Reason)
	}
	if check.Since == nil {
		t.Error("since is nil")
	}
	// Capacity stays visible even though paging activity is unknown.
	details := check.Details.(SwapDetails)
	if details.TotalBytes != 1000 || details.UsedBytes != 900 || details.UsedPercent != 90 {
		t.Errorf("details = %+v, want capacity preserved", details)
	}
	if snapshot.Summary.Unknown != 1 || snapshot.Summary.IssueCount != 0 {
		t.Errorf("summary = %+v", snapshot.Summary)
	}
	if snapshot.Overall != StatusUnknown {
		t.Errorf("overall = %q, want unknown", snapshot.Overall)
	}
}

func TestSwapPagingUnavailablePausesEvaluation(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["swap"] = rule{warning: 1, critical: unreachableThreshold, recoverHealthy: 0.5, recoverWarning: unreachableThreshold, enterAfter: 9 * time.Second, recoverAfter: 3 * time.Second}
	at := baseTime
	paging := monitor.SwapStat{
		TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true,
		PagingAvailable: true, SwapInPerSec: 2048,
	}

	var snapshot Snapshot
	for i := 0; i <= 10; i++ {
		snapshot = swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), paging)
	}
	if check := findCheck(t, snapshot, "swap"); check.Status != StatusWarning {
		t.Fatalf("status = %q, want warning before the paging outage", check.Status)
	}

	// The paging counters disappear: an active warning must not be reported as
	// healthy (or recovered) while paging activity cannot be observed.
	unknown := monitor.SwapStat{TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true}
	for i := 11; i <= 15; i++ {
		snapshot = swapSample(engine, clock, at.Add(time.Duration(i)*time.Second), unknown)
		check := findCheck(t, snapshot, "swap")
		if check.Status != StatusUnknown || check.Reason != ReasonCollectFailed {
			t.Fatalf("sample %d status = %q/%q, want unknown/collect_failed", i, check.Status, check.Reason)
		}
		if check.Value == nil || *check.Value != 90 {
			t.Errorf("value = %v, want the current used percent 90", check.Value)
		}
		if details := check.Details.(SwapDetails); details.UsedPercent != 90 {
			t.Errorf("details = %+v, want capacity preserved", details)
		}
		if snapshot.Overall != StatusUnknown {
			t.Errorf("sample %d overall = %q, want unknown", i, snapshot.Overall)
		}
	}

	// Once paging counters return the accumulated window is re-evaluated from a
	// stale gap, so healthy activity does not immediately restore the warning.
	snapshot = swapSample(engine, clock, at.Add(16*time.Second), monitor.SwapStat{
		TotalBytes: 1000, UsedBytes: 900, UsedPercent: 90, Configured: true, PagingAvailable: true,
	})
	check := findCheck(t, snapshot, "swap")
	if check.Status != StatusHealthy || check.Reason != ReasonOK {
		t.Fatalf("status after paging recovery = %q/%q, want healthy/ok", check.Status, check.Reason)
	}
	if check.Since != nil {
		t.Errorf("since = %v, want nil", check.Since)
	}
}

// --- V2: summary invariants across mixed checks ---

func TestSummaryCountsAcrossMixedChecks(t *testing.T) {
	engine, clock := newTestEngine()
	engine.rules["cpu"] = cpuRule(time.Second, time.Second)
	engine.rules["memory"] = rule{warning: 85, critical: 95, recoverHealthy: 80, recoverWarning: 90, enterAfter: time.Second, recoverAfter: time.Second}

	at := baseTime
	sample := healthySnapshot(at)
	sample.CPU.Percent = 90
	sample.CPU.PerCore = []float64{90}
	sample.Memory = &monitor.MemoryStat{Total: 100, Used: 97, Available: 3, Percent: 97}
	sample.Swap = &monitor.SwapStat{Configured: false}
	sample.Network = []monitor.NetworkStat{{Name: "eth1", LinkUp: true, IsDefaultRoute: false, IPv4: []string{"192.0.2.11"}}}
	evaluate(engine, clock, sample)

	sample = healthySnapshot(at.Add(time.Second))
	sample.CPU.Percent = 90
	sample.CPU.PerCore = []float64{90}
	sample.Memory = &monitor.MemoryStat{Total: 100, Used: 97, Available: 3, Percent: 97}
	sample.Swap = &monitor.SwapStat{Configured: false}
	sample.Network = []monitor.NetworkStat{{Name: "eth1", LinkUp: true, IsDefaultRoute: false, IPv4: []string{"192.0.2.11"}}}
	engine.evaluateAt(sample, sample.SampledAt)
	engine.evaluateTemperatureAt(tempSensors(55, nil, nil), sample.SampledAt)
	snapshot, _ := engine.Snapshot()

	wantIDs := []string{
		"cpu", "load", "memory", "swap", "disk:/", "network:default", "temperature:test/sensor0",
	}
	gotIDs := checkIDs(snapshot)
	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("ids = %v, want %v", gotIDs, wantIDs)
	}
	for i := range wantIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Fatalf("ids = %v, want %v", gotIDs, wantIDs)
		}
	}

	summary := snapshot.Summary
	if summary.Total != len(snapshot.Checks) {
		t.Errorf("total = %d, checks = %d", summary.Total, len(snapshot.Checks))
	}
	if summary.Total != summary.Healthy+summary.Warning+summary.Critical+summary.Unknown+summary.NotApplicable {
		t.Errorf("summary counts do not add up: %+v", summary)
	}
	if summary.Warning != 1 || summary.Critical != 1 || summary.Unknown != 0 {
		t.Errorf("summary = %+v", summary)
	}
	if summary.NotApplicable != 3 {
		t.Errorf("notApplicable = %d, want 3", summary.NotApplicable)
	}
	if summary.IssueCount != 2 {
		t.Errorf("issueCount = %d, want 2 (notApplicable excluded)", summary.IssueCount)
	}
	if snapshot.Overall != StatusCritical {
		t.Errorf("overall = %q, want critical", snapshot.Overall)
	}
	// Not-applicable checks are never counted as issues or unknown.
	if findCheck(t, snapshot, "swap").Applicable {
		t.Error("swap should be not applicable")
	}
	if findCheck(t, snapshot, "network:default").Applicable {
		t.Error("network should be not applicable")
	}
	if findCheck(t, snapshot, "temperature:test/sensor0").Applicable {
		t.Error("temperature should be not applicable")
	}
}

func TestV2CheckJSONShape(t *testing.T) {
	engine, clock := newTestEngine()
	sample := healthySnapshot(baseTime)
	sample.Swap = &monitor.SwapStat{Configured: false}
	evaluate(engine, clock, sample)
	engine.evaluateTemperatureAt(tempSensors(55, nil, nil), baseTime)
	snapshot, _ := engine.Snapshot()

	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Checks []map[string]any `json:"checks"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]map[string]any, len(decoded.Checks))
	for _, check := range decoded.Checks {
		byID[check["id"].(string)] = check
	}

	load, ok := byID["load"]
	if !ok {
		t.Fatalf("load check missing from %v", decoded.Checks)
	}
	if load["category"] != "load" || load["unit"] != nil || load["applicable"] != true {
		t.Errorf("load = %+v", load)
	}
	loadDetails, _ := load["details"].(map[string]any)
	for _, field := range []string{"load1", "load5", "load15", "logicalCores", "load5PerCore"} {
		if _, ok := loadDetails[field]; !ok {
			t.Errorf("load details missing %q: %+v", field, loadDetails)
		}
	}
	if thresholds, _ := load["thresholds"].(map[string]any); thresholds == nil || thresholds["warning"] != 1.5 || thresholds["critical"] != 3.0 {
		t.Errorf("load thresholds = %+v", load["thresholds"])
	}

	swap, ok := byID["swap"]
	if !ok {
		t.Fatalf("swap check missing from %v", decoded.Checks)
	}
	if swap["applicable"] != false || swap["status"] != "unknown" || swap["reason"] != "not_supported" {
		t.Errorf("swap = %+v", swap)
	}
	if swap["thresholds"] != nil || swap["value"] != nil {
		t.Errorf("swap thresholds/value = %+v / %+v", swap["thresholds"], swap["value"])
	}
	swapDetails, _ := swap["details"].(map[string]any)
	for _, field := range []string{"totalBytes", "usedBytes", "usedPercent", "swapInPerSec", "swapOutPerSec"} {
		if _, ok := swapDetails[field]; !ok {
			t.Errorf("swap details missing %q: %+v", field, swapDetails)
		}
	}

	temp, ok := byID["temperature:test/sensor0"]
	if !ok {
		t.Fatalf("temperature check missing from %v", decoded.Checks)
	}
	if temp["category"] != "temperature" || temp["applicable"] != false || temp["reason"] != "no_threshold" {
		t.Errorf("temperature = %+v", temp)
	}
	if temp["value"] != 55.0 || temp["unit"] != "celsius" || temp["thresholds"] != nil {
		t.Errorf("temperature value/unit/thresholds = %+v / %+v / %+v", temp["value"], temp["unit"], temp["thresholds"])
	}
	tempDetails, _ := temp["details"].(map[string]any)
	if tempDetails["celsius"] != 55.0 || tempDetails["sensor"] != "sensor0" || tempDetails["chip"] != "test" {
		t.Errorf("temperature details = %+v", tempDetails)
	}
	if tempDetails["warning"] != nil || tempDetails["critical"] != nil {
		t.Errorf("temperature thresholds in details = %+v", tempDetails)
	}
}
