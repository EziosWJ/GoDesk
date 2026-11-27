package monitor

import (
	"bufio"
	"errors"
	"io"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	bytesPerKiB      = 1024 // /proc/meminfo reports swap in KiB
	diskSectorSize   = 512  // /proc/diskstats sectors are always 512 bytes
	minLoadFields    = 3
	minMemInfoFields = 2
)

// LoadStat is the host load average alongside the number of logical cores
// needed to interpret it.
type LoadStat struct {
	Load1        float64 `json:"load1"`
	Load5        float64 `json:"load5"`
	Load15       float64 `json:"load15"`
	LogicalCores int     `json:"logicalCores"`
}

// SwapStat is the swap configuration and paging activity. The paging rates are
// bytes per second so the health engine can reuse them without another read.
type SwapStat struct {
	TotalBytes    uint64  `json:"totalBytes"`
	UsedBytes     uint64  `json:"usedBytes"`
	UsedPercent   float64 `json:"usedPercent"`
	Configured    bool    `json:"configured"`
	SwapInPerSec  float64 `json:"swapInPerSec"`
	SwapOutPerSec float64 `json:"swapOutPerSec"`
}

type DiskIODevice struct {
	Name             string  `json:"name"`
	ReadBytesPerSec  float64 `json:"readBytesPerSec"`
	WriteBytesPerSec float64 `json:"writeBytesPerSec"`
}

type DiskIOStat struct {
	ReadBytesPerSec  float64        `json:"readBytesPerSec"`
	WriteBytesPerSec float64        `json:"writeBytesPerSec"`
	Devices          []DiskIODevice `json:"devices"`
}

type swapCounters struct {
	in    uint64
	out   uint64
	valid bool
}

type diskIOCounters struct {
	readSectors  uint64
	writeSectors uint64
}

func collectLoad() (*LoadStat, error) {
	file, err := os.Open("/proc/loadavg")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	load, err := parseLoadAverage(file)
	if err != nil {
		return nil, err
	}
	load.LogicalCores = runtime.NumCPU()
	return &load, nil
}

func parseLoadAverage(r io.Reader) (LoadStat, error) {
	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return LoadStat{}, err
		}
		return LoadStat{}, errors.New("empty load average")
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < minLoadFields {
		return LoadStat{}, errors.New("incomplete load average")
	}
	values := make([]float64, minLoadFields)
	for i := range values {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return LoadStat{}, err
		}
		values[i] = value
	}
	return LoadStat{Load1: values[0], Load5: values[1], Load15: values[2]}, nil
}

func collectSwap(now time.Time, previous swapCounters, previousAt time.Time) (*SwapStat, swapCounters, time.Time, error) {
	meminfo, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil, previous, previousAt, err
	}
	total, free, err := parseMemInfo(meminfo)
	meminfo.Close()
	if err != nil {
		return nil, previous, previousAt, err
	}

	current := swapCounters{}
	if vmstat, err := os.Open("/proc/vmstat"); err == nil {
		in, out, parseErr := parseVMStat(vmstat)
		vmstat.Close()
		if parseErr == nil {
			current = swapCounters{in: in, out: out, valid: true}
		}
	}

	elapsed := 0.0
	if !previousAt.IsZero() {
		elapsed = now.Sub(previousAt).Seconds()
	}
	stat := buildSwapStat(total, free, current, previous, elapsed, os.Getpagesize())
	return &stat, current, now, nil
}

func parseMemInfo(r io.Reader) (uint64, uint64, error) {
	var total, free uint64
	var haveTotal, haveFree bool
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < minMemInfoFields {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "SwapTotal:":
			total, haveTotal = value*bytesPerKiB, true
		case "SwapFree:":
			free, haveFree = value*bytesPerKiB, true
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !haveTotal || !haveFree {
		return 0, 0, errors.New("swap information missing")
	}
	return total, free, nil
}

func parseVMStat(r io.Reader) (uint64, uint64, error) {
	var in, out uint64
	var haveIn, haveOut bool
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "pswpin":
			in, haveIn = value, true
		case "pswpout":
			out, haveOut = value, true
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !haveIn || !haveOut {
		return 0, 0, errors.New("swap paging counters missing")
	}
	return in, out, nil
}

func buildSwapStat(total, free uint64, current, previous swapCounters, elapsed float64, pageSize int) SwapStat {
	if free > total {
		free = total
	}
	used := total - free
	stat := SwapStat{TotalBytes: total, UsedBytes: used, Configured: total > 0}
	if total > 0 {
		stat.UsedPercent = float64(used) / float64(total) * 100
	}
	if previous.valid && current.valid && elapsed > 0 && pageSize > 0 {
		if current.in >= previous.in {
			stat.SwapInPerSec = float64(current.in-previous.in) * float64(pageSize) / elapsed
		}
		if current.out >= previous.out {
			stat.SwapOutPerSec = float64(current.out-previous.out) * float64(pageSize) / elapsed
		}
	}
	return stat
}

func collectDiskIO(now time.Time, previous map[string]diskIOCounters, previousAt time.Time) (*DiskIOStat, map[string]diskIOCounters, time.Time, error) {
	file, err := os.Open("/proc/diskstats")
	if err != nil {
		empty := &DiskIOStat{Devices: []DiskIODevice{}}
		if errors.Is(err, os.ErrNotExist) {
			return empty, nil, now, nil
		}
		return empty, previous, previousAt, err
	}
	defer file.Close()

	current, err := parseDiskStats(file)
	if err != nil {
		return &DiskIOStat{Devices: []DiskIODevice{}}, previous, previousAt, err
	}
	elapsed := 0.0
	if !previousAt.IsZero() {
		elapsed = now.Sub(previousAt).Seconds()
	}
	stat := buildDiskIOStat(current, previous, elapsed)
	return &stat, current, now, nil
}

func parseDiskStats(r io.Reader) (map[string]diskIOCounters, error) {
	counters := make(map[string]diskIOCounters)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		if !physicalBlockDevice(name) {
			continue
		}
		read, err := strconv.ParseUint(fields[5], 10, 64)
		if err != nil {
			continue
		}
		write, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		counters[name] = diskIOCounters{readSectors: read, writeSectors: write}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return counters, nil
}

func buildDiskIOStat(current, previous map[string]diskIOCounters, elapsed float64) DiskIOStat {
	names := make([]string, 0, len(current))
	for name := range current {
		names = append(names, name)
	}
	sort.Strings(names)

	stat := DiskIOStat{Devices: make([]DiskIODevice, 0, len(names))}
	for _, name := range names {
		device := DiskIODevice{Name: name}
		value := current[name]
		if old, ok := previous[name]; ok && elapsed > 0 {
			if value.readSectors >= old.readSectors {
				device.ReadBytesPerSec = float64(value.readSectors-old.readSectors) * diskSectorSize / elapsed
			}
			if value.writeSectors >= old.writeSectors {
				device.WriteBytesPerSec = float64(value.writeSectors-old.writeSectors) * diskSectorSize / elapsed
			}
		}
		stat.ReadBytesPerSec += device.ReadBytesPerSec
		stat.WriteBytesPerSec += device.WriteBytesPerSec
		stat.Devices = append(stat.Devices, device)
	}
	return stat
}

// physicalBlockDevice keeps whole physical block devices and drops loop, ram,
// zram, device-mapper and partition entries so I/O is not double counted.
func physicalBlockDevice(name string) bool {
	switch {
	case strings.HasPrefix(name, "nvme"):
		return nvmeNamespace(name)
	case strings.HasPrefix(name, "mmcblk"):
		return numericSuffix(strings.TrimPrefix(name, "mmcblk"))
	case strings.HasPrefix(name, "xvd"):
		return lowerAlphaSuffix(strings.TrimPrefix(name, "xvd"))
	case strings.HasPrefix(name, "vd"):
		return lowerAlphaSuffix(strings.TrimPrefix(name, "vd"))
	case strings.HasPrefix(name, "hd"):
		return lowerAlphaSuffix(strings.TrimPrefix(name, "hd"))
	case strings.HasPrefix(name, "sd"):
		return lowerAlphaSuffix(strings.TrimPrefix(name, "sd"))
	default:
		return false
	}
}

func nvmeNamespace(name string) bool {
	rest := strings.TrimPrefix(name, "nvme")
	controller, namespace, ok := strings.Cut(rest, "n")
	return ok && numericSuffix(controller) && numericSuffix(namespace)
}

func numericSuffix(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func lowerAlphaSuffix(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}
