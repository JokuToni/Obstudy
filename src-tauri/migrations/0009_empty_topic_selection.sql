ALTER TABLE practiceSettings ADD COLUMN excludeAllTopics INTEGER NOT NULL DEFAULT 0
    CHECK (excludeAllTopics IN (0, 1));
