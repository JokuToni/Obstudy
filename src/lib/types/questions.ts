import type {
    Difficulty,
    Question,
    QuestionFormat,
    QuestionFormatSelection,
    QuestionFsrs,
    Topic,
} from "./index";
import type { SyncedNote } from "./notes";
import type { AiTokenUsage } from "./ai";

export type GeneratedQuestion =
    | Omit<
          Extract<Question, { format: 0 }>,
          | "id"
          | "noteId"
          | "isBasicQuestion"
          | "generatedAt"
          | "generatedWithModel"
          | "generationScope"
          | "lastAnsweredAt"
          | "averageScore"
          | "materials"
      >
    | Omit<
          Extract<Question, { format: 1 }>,
          | "id"
          | "noteId"
          | "isBasicQuestion"
          | "generatedAt"
          | "generatedWithModel"
          | "generationScope"
          | "lastAnsweredAt"
          | "averageScore"
          | "materials"
      >;

export interface QuestionGenerationRequest {
    questionCount: number;
    noteId: string;
    topicIds?: string[];
    questionFormat?: QuestionFormatSelection;
    difficulty?: Difficulty;
    outputLanguage?: string;
    generationMode?: "auto" | "additional";
}

export interface QuestionGenerationProgress {
    mode: "basic" | "additional";
    generatedCount: number;
    requestedCount: number;
    phase?: "requesting" | "validating" | "saving";
    topicTitle?: string;
    batchCount?: number;
    attempt?: number;
}

export interface QuestionGenerationResult extends QuestionGenerationProgress {
    complete: boolean;
    note: SyncedNote;
    warnings: string[];
    usage: AiTokenUsage;
}

export interface QuestionGenerationOptions {
    /** Explicit fresh practice requests bypass the automatic basic-question plan. */
    generationMode?: "auto" | "additional";
    outputLanguage?: string;
    signal?: AbortSignal;
    onProgress?: (progress: QuestionGenerationProgress) => void;
    onNoteUpdated?: (note: SyncedNote) => void;
}

export interface NoteGenerationState {
    isGenerating: boolean;
    maintenanceAction?: NoteQuestionAction;
    progress: QuestionGenerationProgress | null;
    message: string | null;
    error: string | null;
    errorDetails?: string | null;
    warnings: string[];
    remainingRequest: QuestionGenerationRequest | null;
}

export type NoteQuestionAction = "remove" | "reset";

export interface NoteQuestionActionRequest {
    noteId: string;
    action: NoteQuestionAction;
    expectedQuestionIds: string[];
}

export interface QuestionGenerationBatch {
    noteId: string;
    sourceText: string;
    sourceTopics: Topic[];
    expectedQuestionIds: string[];
    isBasicQuestion: boolean;
    scope: string;
    model: string;
    difficulty: Difficulty;
    format: QuestionFormat;
    targetCount: number;
    allowedTopicIds: string[];
    questions: (GeneratedQuestion & { fsrsData?: QuestionFsrs["fsrsData"] })[];
}
