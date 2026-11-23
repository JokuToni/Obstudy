CREATE TABLE mobileState (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    document TEXT NOT NULL CHECK (json_valid(document))
);
