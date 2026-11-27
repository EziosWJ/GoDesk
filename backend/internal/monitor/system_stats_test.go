package monitor

import (
	"strings"
	"testing"
)

func TestParseLoadAverage(t *testing.T) {
	load, err := parseLoadAverage(strings.NewReader("3.02 0.91 0.59 2/2574 604209\n"))
	if err != nil {
		t.Fatal(err)
	}
	if load.Load1 != 3.02 || load.Load5 != 0.91 || load.Load15 != 0.59 {
		t.Errorf("load = %+v, want 3.02/0.91/0.59", load)
	}
	for _, input := range []string{"", "1.0 2.0", "a b c", "1.0 2.0 x"} {
		if _, err := parseLoadAverage(strings.NewReader(input)); err == nil {
			t.Errorf("parseLoadAverage(%q) succeeded, want error", input)
		}
	}
}

func TestParseMemInfo(t *testing.T) {
	meminfo := strings.Join([]string{
		"MemTotal:       32278364 kB",
		"MemFree:         1000000 kB",
		"SwapTotal:       8388608 kB",
		"SwapFree:        8215836 kB",
		"SwapCached:         4852 kB",
	}, "\n")
	total, free, err := parseMemInfo(strings.NewReader(meminfo))
	if err != nil {
		t.Fatal(err)
	}
	if total != 8388608*1024 || free != 8215836*1024 {
		t.Errorf("total = %d, free = %d", total, free)
	}
	if _, _, err := parseMemInfo(strings.NewReader("MemTotal: 100 kB\n")); err == nil {
		t.Error("missing swap fields should fail")
	}
}

func TestParseVMStat(t *testing.T) {
	input := strings.Join([]string{
		"nr_free_pages 1234",
		"pswpin 9741",
		"pswpout 79207",
	}, "\n")
	in, out, err := parseVMStat(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if in != 9741 || out != 79207 {
		t.Errorf("in = %d, out = %d", in, out)
	}
	if _, _, err := parseVMStat(strings.NewReader("pswpin 1\n")); err == nil {
		t.Error("missing pswpout should fail")
	}
}

func TestBuildSwapStat(t *testing.T) {
	current := swapCounters{in: 100, out: 50, valid: true}
	previous := swapCounters{in: 60, out: 20, valid: true}
	stat := buildSwapStat(1000*1024, 400*1024, current, previous, 2, 4096)
	if !stat.Configured {
		t.Error("configured = false, want true")
	}
	if stat.TotalBytes != 1000*1024 || stat.UsedBytes != 600*1024 {
		t.Errorf("total = %d, used = %d", stat.TotalBytes, stat.UsedBytes)
	}
	if stat.UsedPercent != 60 {
		t.Errorf("usedPercent = %v, want 60", stat.UsedPercent)
	}
	if stat.SwapInPerSec != float64(40*4096)/2 {
		t.Errorf("swapInPerSec = %v, want %v", stat.SwapInPerSec, float64(40*4096)/2)
	}
	if stat.SwapOutPerSec != float64(30*4096)/2 {
		t.Errorf("swapOutPerSec = %v, want %v", stat.SwapOutPerSec, float64(30*4096)/2)
	}

	unconfigured := buildSwapStat(0, 0, current, previous, 2, 4096)
	if unconfigured.Configured || unconfigured.UsedPercent != 0 || unconfigured.TotalBytes != 0 || unconfigured.UsedBytes != 0 {
		t.Errorf("unconfigured swap = %+v", unconfigured)
	}

	first := buildSwapStat(1000, 500, current, swapCounters{}, 2, 4096)
	if first.SwapInPerSec != 0 || first.SwapOutPerSec != 0 {
		t.Errorf("first sample rates = %v/%v, want 0", first.SwapInPerSec, first.SwapOutPerSec)
	}
}

func TestPhysicalBlockDevice(t *testing.T) {
	tests := map[string]bool{
		"sda":       true,
		"sdz":       true,
		"sda1":      false,
		"nvme0n1":   true,
		"nvme12n3":  true,
		"nvme0n1p1": false,
		"vda":       true,
		"vda1":      false,
		"hda":       true,
		"hda1":      false,
		"xvda":      true,
		"xvda1":     false,
		"mmcblk0":   true,
		"mmcblk1":   true,
		"mmcblk0p1": false,
		"loop0":     false,
		"ram0":      false,
		"zram0":     false,
		"dm-0":      false,
		"md0":       false,
		"sr0":       false,
		"":          false,
		"nvme0n":    false,
		"nvmeXn1":   false,
		"sd":        false,
		"mmcblk":    false,
	}
	for name, want := range tests {
		if got := physicalBlockDevice(name); got != want {
			t.Errorf("physicalBlockDevice(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestParseDiskStatsAndRates(t *testing.T) {
	input := strings.Join([]string{
		"   8       0 sda 100 0 1000 0 50 0 500 0 0 0 0",
		"   8       1 sda1 10 0 100 0 5 0 50 0 0 0 0",
		"   7       0 loop0 10 0 100 0 5 0 50 0 0 0 0",
		"   1       0 ram0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
		" 259       0 nvme0n1 10 0 2000 0 20 0 1000 0 0 0 0",
		" 259       1 nvme0n1p1 1 0 100 0 1 0 50 0 0 0 0",
		" 253       0 dm-0 1 0 100 0 1 0 50 0 0 0 0",
		" 179       0 mmcblk0 5 0 500 0 2 0 250 0 0 0 0",
		" 179       1 mmcblk0p1 1 0 100 0 1 0 50 0 0 0 0",
		"   9       0 md0 1 0 100 0 1 0 50 0 0 0 0",
	}, "\n")
	current, err := parseDiskStats(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if len(current) != 3 {
		t.Fatalf("devices = %d (%v), want 3", len(current), current)
	}
	for _, name := range []string{"sda", "nvme0n1", "mmcblk0"} {
		if _, ok := current[name]; !ok {
			t.Errorf("missing device %q", name)
		}
	}

	previous := map[string]diskIOCounters{
		"sda":     {readSectors: 800, writeSectors: 400},
		"nvme0n1": {readSectors: 1500, writeSectors: 500},
		"mmcblk0": {readSectors: 500, writeSectors: 250},
	}
	stat := buildDiskIOStat(current, previous, 2)
	wantRead := float64(200*512)/2 + float64(500*512)/2
	wantWrite := float64(100*512)/2 + float64(500*512)/2
	if stat.ReadBytesPerSec != wantRead {
		t.Errorf("read rate = %v, want %v", stat.ReadBytesPerSec, wantRead)
	}
	if stat.WriteBytesPerSec != wantWrite {
		t.Errorf("write rate = %v, want %v", stat.WriteBytesPerSec, wantWrite)
	}
	if len(stat.Devices) != 3 {
		t.Fatalf("device rates = %d, want 3", len(stat.Devices))
	}
	if stat.Devices[0].Name != "mmcblk0" || stat.Devices[1].Name != "nvme0n1" || stat.Devices[2].Name != "sda" {
		t.Errorf("devices not sorted: %+v", stat.Devices)
	}
	if stat.Devices[2].ReadBytesPerSec != float64(200*512)/2 {
		t.Errorf("sda read rate = %v", stat.Devices[2].ReadBytesPerSec)
	}

	first := buildDiskIOStat(current, nil, 0)
	if first.ReadBytesPerSec != 0 || first.WriteBytesPerSec != 0 {
		t.Errorf("first sample rates = %v/%v, want 0", first.ReadBytesPerSec, first.WriteBytesPerSec)
	}
	if len(first.Devices) != 3 {
		t.Errorf("first sample devices = %d, want 3", len(first.Devices))
	}
}
