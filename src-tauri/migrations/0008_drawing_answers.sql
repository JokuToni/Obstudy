ALTER TABLE submittedAnswers ADD COLUMN drawing TEXT CHECK (drawing IS NULL OR json_valid(drawing));
DROP VIEW answerHistory;
CREATE VIEW answerHistory AS
SELECT a.id, a.exerciseId, e.noteId, e.mode, a.questionId, a.answeredAt, a.text, a.points, a.feedback, a.drawing
FROM submittedAnswers a JOIN exercises e ON e.id=a.exerciseId
UNION ALL
SELECT a.id, p.exerciseId, e.noteId, e.mode, a.questionId, a.answeredAt, a.text, a.points, a.feedback, NULL AS drawing
FROM answers a JOIN performances p ON p.id=a.performanceId JOIN exercises e ON e.id=p.exerciseId;
