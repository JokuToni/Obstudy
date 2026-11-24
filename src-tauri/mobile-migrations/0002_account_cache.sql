CREATE TABLE mobileAccountState (
    scope TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision>0),
    document TEXT NOT NULL CHECK(json_valid(document))
);
