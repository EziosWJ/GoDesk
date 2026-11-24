package health

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
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
		Memory:    &monitor.MemoryStat{Total: 100, Used: 50, Available: 50, Percent: 50},
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
	if check.Thresholds == nil || check.Thresholds.Warning != 85 || check.Thresholds.Critical != 95 {
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

	wantIDs := []string{"cpu", "memory", "disk:/", "disk:/data", "disk:/home", "network:eth0"}
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
