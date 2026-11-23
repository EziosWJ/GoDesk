package services

import (
	"sort"
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
