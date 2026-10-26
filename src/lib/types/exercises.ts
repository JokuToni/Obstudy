import type { Exercise, PracticeSettings, StudyMode } from "./index";

export interface AnswerGrade {
    points: 0 | 0.5 | 1;
    source: "automatic" | "self" | "ai";
    feedback: string;
    model?: string | null;
}

export interface ExerciseDraftAnswer {
    questionId: string;
    text: string;
    selectedChoiceIndex: number | null;
    revealed: boolean;
    grade?: AnswerGrade | null;
}
export interface ExerciseSession extends Exercise {
    noteTitle: string;
    warnings: string[];
    createdAt: string | null;
    reviewedAt: string | null;
    closedAt?: string | null;
    revision: number;
    draftAnswers: ExerciseDraftAnswer[];
}
export interface ExerciseSelection {
    questionIds: string[];
    dueBefore: string;
    dueAfter: string;
    warnings: string[];
}
export interface ExerciseRequest {
    noteId: string;
    mode: StudyMode;
    settings: PracticeSettings;
    questionIds: string[];
    sourceText: string;
    dueBefore: string;
    dueAfter: string;
    warnings: string[];
}
export interface ExerciseDraftSaveResult {
    revision: number;
    reviewedAt: string | null;
}
