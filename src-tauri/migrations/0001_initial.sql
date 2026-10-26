-- Entity IDs are application-generated strings; timestamps are UTC ISO 8601 text.
CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    filePath TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL DEFAULT '',
    isStudying INTEGER NOT NULL DEFAULT 0 CHECK (isStudying IN (0, 1))
);

CREATE TABLE broadTopics (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    UNIQUE (id, noteId)
);

CREATE TABLE subtopics (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    broadTopicId TEXT REFERENCES broadTopics(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    UNIQUE (id, noteId)
);

CREATE TABLE practiceSettings (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    questionCount INTEGER NOT NULL CHECK (questionCount > 0),
    difficulty INTEGER NOT NULL CHECK (difficulty IN (0, 1, 2)),
    reuseQuestions INTEGER NOT NULL CHECK (reuseQuestions IN (0, 1)),
    questionFormat INTEGER NOT NULL CHECK (questionFormat IN (0, 1, 2))
);

-- A note has at most one saved settings profile; exercises keep their own snapshot.
CREATE TABLE noteSettings (
    noteId TEXT PRIMARY KEY NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    settingsId TEXT NOT NULL UNIQUE REFERENCES practiceSettings(id)
);

CREATE TABLE settingsBroadTopics (
    settingsId TEXT NOT NULL REFERENCES practiceSettings(id) ON DELETE CASCADE,
    topicId TEXT NOT NULL REFERENCES broadTopics(id) ON DELETE CASCADE,
    PRIMARY KEY (settingsId, topicId)
);

CREATE TABLE settingsSubtopics (
    settingsId TEXT NOT NULL REFERENCES practiceSettings(id) ON DELETE CASCADE,
    topicId TEXT NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE,
    PRIMARY KEY (settingsId, topicId)
);

CREATE TABLE questions (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    exampleAnswer TEXT NOT NULL,
    lastAnsweredAt TEXT,
    averageScore REAL NOT NULL DEFAULT 0 CHECK (averageScore >= 0),
    difficulty INTEGER NOT NULL CHECK (difficulty IN (0, 1, 2)),
    format INTEGER NOT NULL CHECK (format IN (0, 1)),
    choices TEXT,
    correctChoiceIndex INTEGER,
    maxCharacters INTEGER,
    answerCriteria TEXT,
    materials TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(materials) AND json_type(materials) = 'array'),
    CHECK (
        (format = 0 AND choices IS NOT NULL AND json_valid(choices)
            AND json_type(choices) = 'array' AND json_array_length(choices) BETWEEN 1 AND 8
            AND correctChoiceIndex IS NOT NULL
            AND correctChoiceIndex >= 0 AND correctChoiceIndex < json_array_length(choices)
            AND maxCharacters IS NULL AND answerCriteria IS NULL)
        OR
        (format = 1 AND choices IS NULL AND correctChoiceIndex IS NULL
            AND maxCharacters IS NOT NULL AND maxCharacters > 0 AND answerCriteria IS NOT NULL)
    )
);

-- Topic links can be removed while retaining the questions and their history.
CREATE TABLE questionBroadTopics (
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    topicId TEXT NOT NULL REFERENCES broadTopics(id) ON DELETE CASCADE,
    PRIMARY KEY (questionId, topicId)
);

CREATE TABLE questionSubtopics (
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    topicId TEXT NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE,
    PRIMARY KEY (questionId, topicId)
);

CREATE TABLE exercises (
    id TEXT PRIMARY KEY NOT NULL,
    noteId TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    settingsId TEXT NOT NULL REFERENCES practiceSettings(id),
    mode TEXT NOT NULL CHECK (mode IN ('study', 'practice')),
    maxPoints REAL NOT NULL CHECK (maxPoints >= 0)
);

CREATE TABLE exerciseQuestions (
    exerciseId TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    -- Preserve the question as presented, even if the original is later edited.
    questionSnapshot TEXT NOT NULL CHECK (json_valid(questionSnapshot)),
    PRIMARY KEY (exerciseId, questionId),
    UNIQUE (exerciseId, position)
);

CREATE TABLE performances (
    id TEXT PRIMARY KEY NOT NULL,
    exerciseId TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    completedAt TEXT NOT NULL,
    totalPoints REAL NOT NULL CHECK (totalPoints >= 0)
);

CREATE TABLE answers (
    id TEXT PRIMARY KEY NOT NULL,
    performanceId TEXT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
    questionId TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    answeredAt TEXT NOT NULL,
    text TEXT NOT NULL,
    points REAL NOT NULL CHECK (points >= 0),
    feedback TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (performanceId, position)
);

CREATE TABLE questionFsrs (
    questionId TEXT PRIMARY KEY NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    fsrsData TEXT NOT NULL CHECK (json_valid(fsrsData) AND json_type(fsrsData) = 'object')
);

-- The bootstrap notes folder path lives in Tauri Store, not in this table.
CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    lastSelectedNoteId TEXT REFERENCES notes(id) ON DELETE SET NULL,
    lastAnsweredAt TEXT,
    answerCount INTEGER NOT NULL DEFAULT 0 CHECK (answerCount >= 0),
    studyStreak INTEGER NOT NULL DEFAULT 0 CHECK (studyStreak >= 0),
    longestStudyStreak INTEGER NOT NULL DEFAULT 0 CHECK (longestStudyStreak >= studyStreak)
);

CREATE INDEX broadTopicsNoteIndex ON broadTopics(noteId);
CREATE INDEX subtopicsNoteIndex ON subtopics(noteId);
CREATE INDEX subtopicsParentIndex ON subtopics(broadTopicId);
CREATE INDEX questionsNoteIndex ON questions(noteId);
CREATE INDEX exercisesNoteIndex ON exercises(noteId);
CREATE INDEX performancesExerciseIndex ON performances(exerciseId);
CREATE INDEX answersQuestionIndex ON answers(questionId);
CREATE INDEX questionBroadTopicIndex ON questionBroadTopics(topicId);
CREATE INDEX questionSubtopicIndex ON questionSubtopics(topicId);
