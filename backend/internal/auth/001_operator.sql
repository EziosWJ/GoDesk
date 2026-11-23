CREATE TABLE IF NOT EXISTS operator_credentials (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    salt        BLOB NOT NULL,
    hash        BLOB NOT NULL,
    signing_key BLOB NOT NULL
);
