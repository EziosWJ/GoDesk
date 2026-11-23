package services

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

type unitFile struct {
	name  string
	state string
}

type runtimeUnit struct {
	name        string
	load        string
	active      string
	sub         string
	description string
}

func parseUnitFiles(output string) []unitFile {
	files := make([]unitFile, 0)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[0]
		if !strings.HasSuffix(name, ".service") || strings.HasSuffix(name, "@.service") {
			continue
		}
		files = append(files, unitFile{name: name, state: fields[1]})
	}
	return files
}

func parseRuntimeUnits(output string) []runtimeUnit {
	units := make([]runtimeUnit, 0)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := fields[0]
		if !strings.HasSuffix(name, ".service") {
			continue
		}
		unit := runtimeUnit{name: name, load: fields[1], active: fields[2], sub: fields[3]}
		if len(fields) > 4 {
			unit.description = strings.Join(fields[4:], " ")
		}
		units = append(units, unit)
	}
	return units
}

func buildServices(unitFiles, runtimeUnits string, capabilities Capabilities) []Service {
	files := parseUnitFiles(unitFiles)
	units := parseRuntimeUnits(runtimeUnits)
	byName := make(map[string]runtimeUnit, len(units))
	for _, unit := range units {
		byName[unit.name] = unit
	}
	seen := make(map[string]bool, len(files))
	list := make([]Service, 0, len(files)+len(units))
	for _, file := range files {
		seen[file.name] = true
		boot := bootStateFor(file.state)
		state := StateStopped
		detail := ""
		description := ""
		if unit, ok := byName[file.name]; ok {
			state = stateFor(unit)
			detail = detailFor(unit)
			description = unit.description
		}
		list = append(list, Service{
			Name:        file.name,
			Description: description,
			State:       state,
			StateDetail: detail,
			BootState:   boot,
			Actions:     actionsFor(state, boot, capabilities),
		})
	}
	for _, unit := range units {
		if seen[unit.name] {
			continue
		}
		state := stateFor(unit)
		list = append(list, Service{
			Name:        unit.name,
			Description: unit.description,
			State:       state,
			StateDetail: detailFor(unit),
			BootState:   BootNotApplicable,
			Actions:     actionsFor(state, BootNotApplicable, capabilities),
		})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

func stateFor(unit runtimeUnit) State {
	if unit.load == "not-found" {
		return StateUnknown
	}
	switch unit.active {
	case "active":
		if unit.sub == "exited" {
			return StateCompleted
		}
		return StateRunning
	case "inactive":
		return StateStopped
	case "failed":
		return StateFailed
	default:
		return StateUnknown
	}
}

func detailFor(unit runtimeUnit) string {
	if unit.active == "" {
		return ""
	}
	if unit.sub == "" {
		return unit.active
	}
	return unit.active + " (" + unit.sub + ")"
}

func bootStateFor(value string) BootState {
	switch value {
	case "enabled":
		return BootEnabled
	case "disabled":
		return BootDisabled
	case "static", "indirect", "alias":
		return BootStatic
	case "masked", "masked-runtime":
		return BootMasked
	case "enabled-runtime", "linked-runtime":
		return BootRuntime
	case "linked":
		return BootEnabled
	default:
		return BootNotApplicable
	}
}

// parseShow parses the Property=Value output of `systemctl show`.
func parseShow(output string) map[string]string {
	props := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		props[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return props
}

// buildDetail maps the properties of `systemctl show` to the detail view.
// It reports false when the unit does not exist.
func buildDetail(unit string, props map[string]string) (ServiceDetail, bool) {
	if props["LoadState"] == "not-found" || (props["LoadState"] == "" && props["ActiveState"] == "") {
		return ServiceDetail{}, false
	}
	runtime := runtimeUnit{
		name:   unit,
		load:   props["LoadState"],
		active: props["ActiveState"],
		sub:    props["SubState"],
	}
	return ServiceDetail{
		Name:                 unit,
		State:                stateFor(runtime),
		StateDetail:          detailFor(runtime),
		BootState:            bootStateFor(props["UnitFileState"]),
		MainPID:              parsePID(props["MainPID"]),
		MemoryBytes:          parseUint64Property(props["MemoryCurrent"]),
		CPUUsageNs:           parseUint64Property(props["CPUUsageNSec"]),
		ActiveEnterTimestamp: unsetToEmpty(props["ActiveEnterTimestamp"]),
		FragmentPath:         unsetToEmpty(props["FragmentPath"]),
	}, true
}

func parsePID(value string) *int {
	pid, err := strconv.Atoi(value)
	if err != nil || pid <= 0 {
		return nil
	}
	return &pid
}

// parseUint64Property returns nil for unset values and for values that do not
// fit int64, such as the "infinity" memory counter.
func parseUint64Property(value string) *int64 {
	if value == "" || value == "[not set]" {
		return nil
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed > math.MaxInt64 {
		return nil
	}
	number := int64(parsed)
	return &number
}

func unsetToEmpty(value string) string {
	if value == "[not set]" {
		return ""
	}
	return value
}
