ALTER TABLE submittedAnswers ADD COLUMN fsrsPending INTEGER NOT NULL DEFAULT 0 CHECK (fsrsPending IN (0, 1));
CREATE TABLE fsrsReviews (
    id TEXT PRIMARY KEY,
    exerciseId TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    reviewedAt TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    points REAL NOT NULL CHECK (points IN (0, 0.5, 1)),
    beforeCard TEXT NOT NULL CHECK (json_valid(beforeCard)),
    afterCard TEXT NOT NULL CHECK (json_valid(afterCard)),
    reviewLog TEXT NOT NULL CHECK (json_valid(reviewLog)),
    schedulerVersion TEXT NOT NULL,
    UNIQUE (exerciseId, questionId)
);
CREATE INDEX fsrsReviewsQuestionTime ON fsrsReviews(questionId, reviewedAt);
