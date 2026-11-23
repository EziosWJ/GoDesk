package services

import "context"

type noneBackend struct{}

// None returns a backend used when no supported service manager is detected.
func None() Backend { return noneBackend{} }

func (noneBackend) Name() string { return "none" }

func (noneBackend) Capabilities() Capabilities { return Capabilities{} }

func (noneBackend) List(context.Context) ([]Service, error) { return []Service{}, nil }

func (noneBackend) Detail(context.Context, string) (ServiceDetail, error) {
	return ServiceDetail{}, &Error{Code: "not_found", Message: "服务不存在"}
}

func (noneBackend) Start(context.Context, string) error { return unavailable() }

func (noneBackend) Stop(context.Context, string) error { return unavailable() }

func (noneBackend) Restart(context.Context, string) error { return unavailable() }

func (noneBackend) Enable(context.Context, string) error { return unavailable() }

func (noneBackend) Disable(context.Context, string) error { return unavailable() }

func (noneBackend) Logs(context.Context, string, int) ([]string, error) {
	return nil, &Error{Code: "logs_unavailable", Message: "没有可用的服务后端"}
}

func unavailable() error {
	return &Error{Code: "operation_failed", Message: "没有可用的服务后端"}
}
