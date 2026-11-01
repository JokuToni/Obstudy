import type { Card } from "ts-fsrs";

export type EntityId = string;
/** UTC ISO 8601 strings are used at the storage and IPC boundaries. */
export type Timestamp = string;
export type Difficulty = 0 | 1 | 2;
export type StudyMode = "study" | "practice";
export const questionFormats = {
    multipleChoice: 0,
    freeText: 1,
    mixed: 2,
} as const;
export type QuestionFormat = 0 | 1;
export type QuestionFormatSelection = QuestionFormat | 2;

export interface NoteFile {
    path: string;
    text: string;
}

export interface BroadTopic {
    id: EntityId;
    noteId: EntityId;
    title: string;
}

export interface Subtopic {
    id: EntityId;
    noteId: EntityId;
    broadTopicId: EntityId | null;
    title: string;
    text: string;
}

export type Topic = BroadTopic | Subtopic;

export interface PracticeSettings {
    questionCount: number;
    difficulty: Difficulty;
    difficulties?: Difficulty[];
    reuseQuestions: boolean;
    questionFormat: QuestionFormatSelection;
    topicIds: EntityId[];
}

export type SupplementaryMaterial =
    | { type: "image"; source: string; alt: string }
    | { type: "latex"; content: string }
    | { type: "code"; content: string; language: string | null };

interface QuestionBase {
    id: EntityId;
    noteId: EntityId;
    isBasicQuestion: boolean;
    /** Null for questions created before generation metadata was introduced. */
    generatedAt: Timestamp | null;
    generatedWithModel: string | null;
    generationScope: string | null;
    text: string;
    exampleAnswer: string;
    lastAnsweredAt: Timestamp | null;
    averageScore: number;
    topicIds: EntityId[];
    difficulty: Difficulty;
    materials: SupplementaryMaterial[];
}

export interface MultipleChoiceQuestion extends QuestionBase {
    format: 0;
    choices: string[];
    /** Zero-based index into choices; choices must contain between 1 and 8 items. */
    correctChoiceIndex: number;
}

export interface FreeTextQuestion extends QuestionBase {
    format: 1;
    maxCharacters: number;
    answerCriteria: string;
}

export type Question = MultipleChoiceQuestion | FreeTextQuestion;

export interface Exercise {
    id: EntityId;
    noteId: EntityId;
    mode: StudyMode;
    settings: PracticeSettings;
    maxPoints: number;
    questions: Question[];
}

export interface Answer {
    drawing?: import("./exercises").DrawingAnswer | null;
    id: EntityId;
    answeredAt: Timestamp;
    questionId: EntityId;
    text: string;
    points: number | null;
    exerciseId?: EntityId;
    mode?: StudyMode;
    feedback: string;
}

export interface Performance {
    id: EntityId;
    completedAt: Timestamp;
    totalPoints: number;
    answerIds: EntityId[];
    exerciseId: EntityId;
}

export interface QuestionFsrs {
    questionId: EntityId;
    /** Rehydrate dates before passing this serialized card to ts-fsrs. */
    fsrsData: Omit<Card, "due" | "last_review"> & {
        due: Timestamp;
        last_review?: Timestamp;
    };
}

export interface Note {
    id: EntityId;
    isStudying: boolean;
    file: NoteFile;
    topics: Topic[];
    savedPracticeSettings: PracticeSettings | null;
    performances: Performance[];
    questions: Question[];
}

export interface User {
    id: EntityId;
    notesFolderPath: string;
    lastSelectedNoteId: EntityId | null;
    lastAnsweredAt: Timestamp | null;
    answerCount: number;
    studyStreak: number;
    longestStudyStreak: number;
}

export interface SharedState {
    user: User | null;
    notes: Note[];
    selectedNoteId: EntityId | null;
    studyMode: StudyMode;
}
