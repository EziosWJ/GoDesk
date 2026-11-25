CREATE TABLE IF NOT EXISTS web_shortcuts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    parameter_name TEXT NOT NULL,
    secret TEXT NOT NULL
);
