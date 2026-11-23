CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    library_revision TEXT
) STRICT;
CREATE TABLE devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_id,id)
) STRICT;
CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id,device_id) REFERENCES devices(user_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE library_versions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)),
    PRIMARY KEY(user_id,id)
) STRICT;
CREATE TABLE cards (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    base_card TEXT NOT NULL CHECK(json_valid(base_card)),
    current_card TEXT NOT NULL CHECK(json_valid(current_card)),
    PRIMARY KEY(user_id,question_id)
) STRICT;
CREATE TABLE exercises (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    mode TEXT CHECK(mode IN ('study','practice')),
    closed_at TEXT,
    PRIMARY KEY(user_id,id)
) STRICT;
CREATE TABLE sync_events (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)),
    digest TEXT NOT NULL,
    PRIMARY KEY(user_id,id),
    UNIQUE(user_id,sequence)
) STRICT;
CREATE TABLE answers (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    answered_at TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)),
    question TEXT NOT NULL CHECK(json_valid(question)),
    PRIMARY KEY(user_id,id),
    FOREIGN KEY(user_id,exercise_id) REFERENCES exercises(user_id,id),
    UNIQUE(user_id,exercise_id,question_id)
) STRICT;
CREATE INDEX answers_question_history ON answers(user_id,question_id,answered_at,id);
CREATE TABLE reviews (
    user_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)),
    PRIMARY KEY(user_id,answer_id),
    FOREIGN KEY(user_id,answer_id) REFERENCES answers(user_id,id) ON DELETE CASCADE
) STRICT;
