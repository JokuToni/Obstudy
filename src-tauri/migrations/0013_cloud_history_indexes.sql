CREATE INDEX cloudAnswersNoteTime ON cloudAnswers(noteId,answeredAt,id);
CREATE INDEX cloudAnswersQuestionTime ON cloudAnswers(questionId,answeredAt,id);
CREATE INDEX cloudAnswersExercise ON cloudAnswers(exerciseId);
