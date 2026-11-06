ALTER TABLE submittedAnswers ADD COLUMN fsrsPending INTEGER NOT NULL DEFAULT 0 CHECK (fsrsPending IN (0, 1));
