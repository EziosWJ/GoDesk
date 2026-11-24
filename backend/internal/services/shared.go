package services

import (
	shared "github.com/EziosWJ/Extension-Host/hostsys/services"
)

// GoDesk's native service management is a thin facade over the shared
// implementation shipped with the Extension Host. Native and plugin callers
// therefore share the same detection, parsing and command execution code.
type (
	State         = shared.State
	BootState     = shared.BootState
	Action        = shared.Action
	Capabilities  = shared.Capabilities
	Service       = shared.Service
	ServiceDetail = shared.ServiceDetail
	Backend       = shared.Backend
	Error         = shared.Error
)

const (
	StateRunning   = shared.StateRunning
	StateCompleted = shared.StateCompleted
	StateStopped   = shared.StateStopped
	StateFailed    = shared.StateFailed
	StateUnknown   = shared.StateUnknown

	BootEnabled       = shared.BootEnabled
	BootDisabled      = shared.BootDisabled
	BootStatic        = shared.BootStatic
	BootMasked        = shared.BootMasked
	BootRuntime       = shared.BootRuntime
	BootNotApplicable = shared.BootNotApplicable

	ActionStart   = shared.ActionStart
	ActionStop    = shared.ActionStop
	ActionRestart = shared.ActionRestart
	ActionEnable  = shared.ActionEnable
	ActionDisable = shared.ActionDisable
)

// Open selects a service backend for GoDesk's native service management. It is
// called once at startup.
func Open(choice string) (Backend, error) {
	return shared.Open(choice)
}

// OpenPlugin selects a service backend for extension plugins. Its actions run
// as the host account unless the caller asks for elevation.
func OpenPlugin(choice string) (shared.PluginBackend, error) {
	return shared.OpenPlugin(choice)
}

// None returns a backend used when no supported service manager is detected.
func None() Backend {
	return shared.None()
}

// ValidUnit reports whether name is a syntactically valid systemd service unit
// name.
func ValidUnit(name string) bool {
	return shared.ValidUnit(name)
}

func validAction(action Action) bool {
	return shared.ValidAction(action)
}

func containsAction(actions []Action, action Action) bool {
	return shared.ContainsAction(actions, action)
}
