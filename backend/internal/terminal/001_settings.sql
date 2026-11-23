CREATE TABLE IF NOT EXISTS terminal_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    scrollback_lines INTEGER NOT NULL CHECK (scrollback_lines BETWEEN 0 AND 2147483647)
);

INSERT INTO terminal_settings (id, scrollback_lines)
VALUES (1, 5000)
ON CONFLICT (id) DO NOTHING;
