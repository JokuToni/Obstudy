ALTER TABLE exercises ADD COLUMN noteTitle TEXT NOT NULL DEFAULT '';
ALTER TABLE exercises ADD COLUMN createdAt TEXT;
ALTER TABLE exercises ADD COLUMN reviewedAt TEXT;
ALTER TABLE exercises ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings) AND json_type(warnings) = 'array');
ALTER TABLE exercises ADD COLUMN draftAnswers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(draftAnswers) AND json_type(draftAnswers) = 'array');
ALTER TABLE exercises ADD COLUMN draftRevision INTEGER NOT NULL DEFAULT 0 CHECK (draftRevision >= 0);
