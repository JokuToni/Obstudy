-- Restore one active folder link after the development-only multi-profile migration.
-- Retain extra profile documents, including pending work, without making them active.
CREATE TABLE cloudStateArchive (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    serverUrl TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    document TEXT NOT NULL CHECK(json_valid(document)),
    archivedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO cloudStateArchive(id,userId,serverUrl,revision,document)
SELECT id,userId,serverUrl,revision,document FROM cloudState
WHERE id<>(SELECT MIN(id) FROM cloudState);
CREATE TABLE cloudStateSingle (
    id INTEGER PRIMARY KEY CHECK(id=1),
    userId TEXT NOT NULL,
    serverUrl TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    document TEXT NOT NULL CHECK(json_valid(document))
);
INSERT INTO cloudStateSingle(id,userId,serverUrl,revision,document)
SELECT 1,userId,serverUrl,revision,document FROM cloudState ORDER BY id LIMIT 1;
DROP TABLE cloudState;
ALTER TABLE cloudStateSingle RENAME TO cloudState;
