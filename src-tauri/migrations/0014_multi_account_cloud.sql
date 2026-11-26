-- One local workspace may synchronize with several accounts and servers.
-- Preserve the original singleton row and all of its pending work.
CREATE TABLE cloudStateProfiles (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    serverUrl TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    document TEXT NOT NULL CHECK(json_valid(document)),
    UNIQUE(userId,serverUrl)
);
INSERT INTO cloudStateProfiles(id,userId,serverUrl,revision,document)
SELECT id,userId,serverUrl,revision,document FROM cloudState;
DROP TABLE cloudState;
ALTER TABLE cloudStateProfiles RENAME TO cloudState;
