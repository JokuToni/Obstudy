ALTER TABLE questions ADD COLUMN isBasicQuestion INTEGER NOT NULL DEFAULT 0 CHECK (isBasicQuestion IN (0, 1));
ALTER TABLE questions ADD COLUMN generatedAt TEXT;
ALTER TABLE questions ADD COLUMN generatedWithModel TEXT;
ALTER TABLE questions ADD COLUMN generationScope TEXT;

-- Preserve existing schedules when upgrading an existing database.
UPDATE questions SET isBasicQuestion = 1 WHERE id IN (SELECT questionId FROM questionFsrs);

CREATE INDEX basicQuestionScopeIndex ON questions(noteId, isBasicQuestion, generationScope, difficulty, format);

CREATE TRIGGER onlyBasicQuestionsHaveFsrsCards
BEFORE INSERT ON questionFsrs
WHEN NOT EXISTS (SELECT 1 FROM questions WHERE id = NEW.questionId AND isBasicQuestion = 1)
BEGIN
    SELECT RAISE(ABORT, 'Only basic questions can have FSRS cards.');
END;

CREATE TRIGGER onlyBasicQuestionsKeepFsrsCards
BEFORE UPDATE OF questionId ON questionFsrs
WHEN NOT EXISTS (SELECT 1 FROM questions WHERE id = NEW.questionId AND isBasicQuestion = 1)
BEGIN
    SELECT RAISE(ABORT, 'Only basic questions can have FSRS cards.');
END;

CREATE TRIGGER preventRemovingBasicFlagFromScheduledQuestions
BEFORE UPDATE OF isBasicQuestion ON questions
WHEN NEW.isBasicQuestion = 0 AND EXISTS (SELECT 1 FROM questionFsrs WHERE questionId = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'Remove the FSRS card before changing the basic question flag.');
END;
