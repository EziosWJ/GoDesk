package terminal

import (
	"context"
	"database/sql"
	_ "embed"
)

//go:embed 001_settings.sql
var schema string

type Settings struct {
	ScrollbackLines int32 `json:"scrollbackLines"`
}

func (m *Manager) settings(ctx context.Context) (Settings, error) {
	var settings Settings
	err := m.db.QueryRowContext(ctx, "SELECT scrollback_lines FROM terminal_settings WHERE id = 1").Scan(&settings.ScrollbackLines)
	return settings, err
}

func (m *Manager) saveSettings(ctx context.Context, settings Settings) error {
	_, err := m.db.ExecContext(ctx, "UPDATE terminal_settings SET scrollback_lines = ? WHERE id = 1", settings.ScrollbackLines)
	return err
}

func Open(ctx context.Context, db *sql.DB) (*Manager, error) {
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, err
	}
	return &Manager{db: db, sessions: make(map[string]*session)}, nil
}
