package health

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultTemperatureInterval is the sysfs sampling period. It intentionally
	// differs from the monitor interval so health polling never triggers an
	// extra hardware scan.
	defaultTemperatureInterval = 5 * time.Second

	temperatureEnterAfter   = 2 * time.Minute
	temperatureRecoverAfter = time.Minute
	temperatureHysteresis   = 5.0
	maxPlausibleCelsius     = 200.0
)

// temperatureSensor is one readable sensor with the thresholds the kernel or
// driver exposed, if any. Warning and Critical are nil when the sensor does not
// publish a trustworthy threshold; such sensors are display-only.
type temperatureSensor struct {
	ID       string
	Sensor   string
	Chip     string
	Celsius  float64
	Warning  *float64
	Critical *float64
}

type temperatureSampler interface {
	Sample() []temperatureSensor
}

// sysfsTemperatureSampler reads Linux hwmon and thermal zones. The root is
// injectable so tests can use a temporary directory.
type sysfsTemperatureSampler struct {
	root string
}

func newSysfsTemperatureSampler() *sysfsTemperatureSampler {
	return &sysfsTemperatureSampler{root: "/"}
}

func (s *sysfsTemperatureSampler) Sample() []temperatureSensor {
	root := s.root
	if root == "" {
		root = "/"
	}
	sensors := make([]temperatureSensor, 0, 8)
	sensors = append(sensors, sampleHwmon(filepath.Join(root, "sys/class/hwmon"))...)
	sensors = append(sensors, sampleThermal(filepath.Join(root, "sys/class/thermal"))...)
	sort.SliceStable(sensors, func(i, j int) bool { return sensors[i].ID < sensors[j].ID })

	// Keep dynamic IDs unique and stable for the lifetime of the sample.
	seen := make(map[string]int, len(sensors))
	for i := range sensors {
		seen[sensors[i].ID]++
		if count := seen[sensors[i].ID]; count > 1 {
			sensors[i].ID += "#" + strconv.Itoa(count)
		}
	}
	return sensors
}

func sampleHwmon(dir string) []temperatureSensor {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var sensors []temperatureSensor
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "hwmon") {
			continue
		}
		chipDir := filepath.Join(dir, entry.Name())
		// /sys/class/hwmon/hwmon* are symlinks on real systems, so entry.IsDir()
		// is false there. Follow the link instead.
		if info, err := os.Stat(chipDir); err != nil || !info.IsDir() {
			continue
		}
		chip := readTrimmed(filepath.Join(chipDir, "name"))
		if chip == "" {
			chip = entry.Name()
		}
		files, err := os.ReadDir(chipDir)
		if err != nil {
			continue
		}
		for _, file := range files {
			name := file.Name()
			if !strings.HasPrefix(name, "temp") || !strings.HasSuffix(name, "_input") {
				continue
			}
			prefix := strings.TrimSuffix(name, "_input")
			celsius, ok := readCelsius(filepath.Join(chipDir, name))
			if !ok {
				continue
			}
			label := readTrimmed(filepath.Join(chipDir, prefix+"_label"))
			if label == "" {
				label = prefix
			}
			sensors = append(sensors, temperatureSensor{
				ID:       temperatureCheckID(chip + "/" + label),
				Sensor:   label,
				Chip:     chip,
				Celsius:  celsius,
				Warning:  readThreshold(filepath.Join(chipDir, prefix+"_max")),
				Critical: readThreshold(filepath.Join(chipDir, prefix+"_crit")),
			})
		}
	}
	return sensors
}

func sampleThermal(dir string) []temperatureSensor {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var sensors []temperatureSensor
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "thermal_zone") {
			continue
		}
		zoneDir := filepath.Join(dir, entry.Name())
		// /sys/class/thermal/thermal_zone* are symlinks on real systems, so
		// entry.IsDir() is false there. Follow the link instead.
		if info, err := os.Stat(zoneDir); err != nil || !info.IsDir() {
			continue
		}
		celsius, ok := readCelsius(filepath.Join(zoneDir, "temp"))
		if !ok {
			continue
		}
		name := readTrimmed(filepath.Join(zoneDir, "type"))
		if name == "" {
			name = entry.Name()
		}
		warning, critical := thermalThresholds(zoneDir)
		sensors = append(sensors, temperatureSensor{
			ID:       temperatureCheckID("thermal/" + name),
			Sensor:   name,
			Chip:     "thermal",
			Celsius:  celsius,
			Warning:  warning,
			Critical: critical,
		})
	}
	return sensors
}

// thermalThresholds maps trip points to a warning and critical threshold.
// "passive" and "hot" are the earliest actionable trips; "critical" is the
// kernel's emergency shutdown threshold.
func thermalThresholds(dir string) (*float64, *float64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil
	}
	var warning, critical *float64
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "trip_point_") || !strings.HasSuffix(name, "_type") {
			continue
		}
		prefix := strings.TrimSuffix(name, "_type")
		kind := readTrimmed(filepath.Join(dir, name))
		celsius, ok := readCelsius(filepath.Join(dir, prefix+"_temp"))
		if !ok {
			continue
		}
		switch kind {
		case "critical":
			critical = lowerThreshold(critical, celsius)
		case "passive", "hot":
			warning = lowerThreshold(warning, celsius)
		}
	}
	return warning, critical
}

func lowerThreshold(current *float64, candidate float64) *float64 {
	if current != nil && *current <= candidate {
		return current
	}
	value := candidate
	return &value
}

func readCelsius(path string) (float64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	milli, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0, false
	}
	celsius := float64(milli) / 1000
	if celsius <= 0 || celsius > maxPlausibleCelsius {
		return 0, false
	}
	return celsius, true
}

func readThreshold(path string) *float64 {
	celsius, ok := readCelsius(path)
	if !ok {
		return nil
	}
	return &celsius
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func temperatureCheckID(key string) string {
	return "temperature:" + key
}

// temperatureRule translates the kernel-exposed thresholds into the engine's
// hysteresis state machine. The second result is false when the sensor exposes
// no trustworthy threshold and must stay display-only.
func temperatureRule(sensor temperatureSensor) (rule, bool) {
	if sensor.Warning == nil && sensor.Critical == nil {
		return rule{}, false
	}
	r := rule{
		enterAfter:   temperatureEnterAfter,
		recoverAfter: temperatureRecoverAfter,
		critical:     unreachableThreshold,
	}
	if sensor.Warning != nil {
		r.warning = *sensor.Warning
		r.recoverHealthy = *sensor.Warning - temperatureHysteresis
	} else {
		// Only a critical threshold is exposed: there is no warning band.
		r.warning = *sensor.Critical
		r.recoverHealthy = *sensor.Critical - temperatureHysteresis
	}
	if sensor.Critical != nil {
		r.critical = *sensor.Critical
		r.recoverWarning = *sensor.Critical - temperatureHysteresis
	} else {
		r.recoverWarning = r.warning
	}
	return r, true
}

// unreachableThreshold stands in for an absent critical threshold so the state
// machine never enters the critical band.
const unreachableThreshold = 1e9

func temperatureThresholdValues(sensor temperatureSensor) *Thresholds {
	return &Thresholds{
		Warning:  copyFloatPointer(sensor.Warning),
		Critical: copyFloatPointer(sensor.Critical),
	}
}
