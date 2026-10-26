ALTER TABLE notes ADD COLUMN isAvailable INTEGER NOT NULL DEFAULT 1 CHECK (isAvailable IN (0, 1));
ALTER TABLE notes ADD COLUMN parseError TEXT;
ALTER TABLE notes ADD COLUMN parseWarnings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parseWarnings));
ALTER TABLE broadTopics ADD COLUMN isPresent INTEGER NOT NULL DEFAULT 1 CHECK (isPresent IN (0, 1));
ALTER TABLE subtopics ADD COLUMN isPresent INTEGER NOT NULL DEFAULT 1 CHECK (isPresent IN (0, 1));
ALTER TABLE questions ADD COLUMN isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1));

-- Deleted/changed topics remain addressable until the user resolves their question links.
CREATE TABLE noteSyncIssues (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('topicChanged', 'topicRemoved', 'orphanedSubtopic')),
    topicId TEXT NOT NULL,
    topicKind TEXT NOT NULL CHECK (topicKind IN ('broad', 'subtopic')),
    title TEXT NOT NULL,
    UNIQUE (noteId, kind, topicId)
);
