ALTER TABLE exercises ADD COLUMN closedAt TEXT;
ALTER TABLE submittedAnswers ADD COLUMN gradingSource TEXT CHECK (gradingSource IN ('automatic','self','ai'));
ALTER TABLE submittedAnswers ADD COLUMN gradingModel TEXT;
ALTER TABLE submittedAnswers ADD COLUMN gradedAt TEXT;
-- Use the immutable question presented to the user, rather than today's question.
UPDATE submittedAnswers SET points=CASE WHEN selectedChoiceIndex=(
    SELECT json_extract(questionSnapshot,'$.correctChoiceIndex') FROM exerciseQuestions
    WHERE exerciseId=submittedAnswers.exerciseId AND questionId=submittedAnswers.questionId
) THEN 1 ELSE 0 END, gradingSource='automatic', gradedAt=answeredAt
WHERE points IS NULL AND selectedChoiceIndex IS NOT NULL AND EXISTS (
    SELECT 1 FROM exerciseQuestions WHERE exerciseId=submittedAnswers.exerciseId
    AND questionId=submittedAnswers.questionId AND json_extract(questionSnapshot,'$.format')=0
);
UPDATE questions SET averageScore=COALESCE((SELECT AVG(points) FROM answerHistory WHERE questionId=questions.id AND points IS NOT NULL),0);
