// Package extensions embeds the GoDesk Extension Host in the GoDesk process.
package extensions

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/EziosWJ/Extension-Host/host"
	extservices "github.com/EziosWJ/Extension-Host/hostsys/services"
)

// RestoreTimeout bounds plugin restoration so a slow plugin cannot hold up the
// rest of GoDesk during startup.
const RestoreTimeout = 30 * time.Second

// developmentOrigins lets the Vite development server open plugin event
// sockets through its proxy.
var developmentOrigins = []string{"localhost:5173", "127.0.0.1:5173"}

// Options configures the embedded extension host.
type Options struct {
	DataDir        string
	Logger         *slog.Logger
	ServiceBackend extservices.PluginBackend
}

// Manager owns the embedded extension host.
type Manager struct {
	host *host.Host
}

// Open opens the host data directory and its SQLite storage.
func Open(ctx context.Context, opts Options) (*Manager, error) {
	extensionHost, err := host.Open(ctx, host.Options{
		DataDir:        opts.DataDir,
		Logger:         opts.Logger,
		ServiceBackend: opts.ServiceBackend,
	})
	if err != nil {
		return nil, err
	}
	return &Manager{host: extensionHost}, nil
}

// Restore starts the plugins that were enabled before the last shutdown.
func (m *Manager) Restore(ctx context.Context) error {
	return m.host.Restore(ctx)
}

// Handler returns the extension routes protected by requireSession.
func (m *Manager) Handler(requireSession func(http.Handler) http.Handler) http.Handler {
	return m.host.Handler(host.HTTPOptions{
		RequireSession: requireSession,
		AllowedOrigins: developmentOrigins,
	})
}

// Close stops the running plugins and releases the host storage.
func (m *Manager) Close(ctx context.Context) error {
	return m.host.Close(ctx)
}
