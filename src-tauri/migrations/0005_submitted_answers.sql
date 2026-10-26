-- Ungraded submissions are distinct from editable drafts and scored performances.
CREATE TABLE submittedAnswers (
    id TEXT PRIMARY KEY NOT NULL,
    exerciseId TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    answeredAt TEXT NOT NULL,
    text TEXT NOT NULL,
    selectedChoiceIndex INTEGER,
    points REAL CHECK (points IS NULL OR points >= 0),
    feedback TEXT NOT NULL DEFAULT '',
    UNIQUE (exerciseId, questionId),
    FOREIGN KEY (exerciseId, questionId) REFERENCES exerciseQuestions(exerciseId, questionId)
);
CREATE INDEX submittedAnswersQuestionIndex ON submittedAnswers(questionId, answeredAt);

-- Older drafts did not store reveal times. Use the saved session time as an
-- approximation when recovering answers that were already submitted.
INSERT INTO submittedAnswers (id, exerciseId, questionId, answeredAt, text, selectedChoiceIndex)
SELECT e.id || ':' || eq.questionId, e.id, eq.questionId,
    COALESCE(e.reviewedAt, e.createdAt, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    json_extract(d.value,'$.text'), json_extract(d.value,'$.selectedChoiceIndex')
FROM exercises e, json_each(e.draftAnswers) d
JOIN exerciseQuestions eq ON eq.exerciseId=e.id AND eq.questionId=json_extract(d.value,'$.questionId')
WHERE json_extract(d.value,'$.revealed')=1
    AND length(trim(json_extract(d.value,'$.text')))>0
    AND NOT EXISTS (SELECT 1 FROM answers a JOIN performances p ON p.id=a.performanceId
        WHERE p.exerciseId=e.id AND a.questionId=eq.questionId);

CREATE VIEW answerHistory AS
SELECT a.id, a.exerciseId, e.noteId, e.mode, a.questionId, a.answeredAt, a.text, a.points, a.feedback
FROM submittedAnswers a JOIN exercises e ON e.id=a.exerciseId
UNION ALL
SELECT a.id, p.exerciseId, e.noteId, e.mode, a.questionId, a.answeredAt, a.text, a.points, a.feedback
FROM answers a JOIN performances p ON p.id=a.performanceId JOIN exercises e ON e.id=p.exerciseId;

UPDATE questions SET lastAnsweredAt=COALESCE(
    (SELECT MAX(h.answeredAt) FROM answerHistory h WHERE h.questionId=questions.id), lastAnsweredAt);
