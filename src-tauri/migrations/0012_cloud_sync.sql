CREATE TABLE cloudState (
    id INTEGER PRIMARY KEY CHECK(id=1),
    userId TEXT NOT NULL,
    serverUrl TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    document TEXT NOT NULL CHECK(json_valid(document))
);
CREATE TABLE cloudAnswers (
    id TEXT PRIMARY KEY,
    exerciseId TEXT NOT NULL,
    noteId TEXT NOT NULL,
    mode TEXT NOT NULL,
    questionId TEXT NOT NULL,
    answeredAt TEXT NOT NULL,
    text TEXT NOT NULL,
    points REAL NOT NULL,
    feedback TEXT NOT NULL,
    drawing TEXT,
    questionSnapshot TEXT NOT NULL CHECK(json_valid(questionSnapshot))
);
DROP VIEW answerHistory;
CREATE VIEW answerHistory AS
SELECT a.id,a.exerciseId,e.noteId,e.mode,a.questionId,a.answeredAt,a.text,a.points,a.feedback,a.drawing
FROM submittedAnswers a JOIN exercises e ON e.id=a.exerciseId
UNION ALL
SELECT a.id,p.exerciseId,e.noteId,e.mode,a.questionId,a.answeredAt,a.text,a.points,a.feedback,NULL AS drawing
FROM answers a JOIN performances p ON p.id=a.performanceId JOIN exercises e ON e.id=p.exerciseId
UNION ALL
SELECT c.id,c.exerciseId,c.noteId,c.mode,c.questionId,c.answeredAt,c.text,c.points,c.feedback,c.drawing
FROM cloudAnswers c WHERE NOT EXISTS(SELECT 1 FROM submittedAnswers a WHERE a.id=c.id)
AND NOT EXISTS(SELECT 1 FROM answers a WHERE a.id=c.id);
