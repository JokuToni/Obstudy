import type { Exercise, PracticeSettings, StudyMode } from "./index";

export interface AnswerGrade {
    points: 0 | 0.5 | 1;
    source: "automatic" | "self" | "ai";
    feedback: string;
    model?: string | null;
}

export interface DrawingAnswer {
    version: 1;
    width: 1200;
    height: 800;
    elements: readonly import("@excalidraw/excalidraw/element/types").ExcalidrawElement[];
}

export interface ExerciseDraftAnswer {
    questionId: string;
    text: string;
    selectedChoiceIndex: number | null;
    revealed: boolean;
    drawing?: DrawingAnswer | null;
    editorMode?: "text" | "draw";
    grade?: AnswerGrade | null;
    reviewRating?: 1 | 2 | 3 | 4 | null;
}
export interface ExerciseSession extends Exercise {
    noteTitle: string;
    warnings: string[];
    createdAt: string | null;
    reviewedAt: string | null;
    closedAt?: string | null;
    revision: number;
    draftAnswers: ExerciseDraftAnswer[];
    scheduledQuestionIds?: string[];
    pendingReviewQuestionIds?: string[];
}
export interface ExerciseSelection {
    questionIds: string[];
    dueBefore: string;
    dueAfter: string;
    dueNow?: string;
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
    dueNow?: string;
    warnings: string[];
}
export interface ExerciseDraftSaveResult {
    scheduledQuestionIds?: string[];
    pendingReviewQuestionIds?: string[];
    revision: number;
    reviewedAt: string | null;
}
