import { invoke } from "@tauri-apps/api/core";
import { getNotesFolderPath } from "./settings";
import { promptAi } from "./ai";
import { runQuestionGeneration } from "../questions/generation";
import { createEmptyCard } from "ts-fsrs";
import type { Difficulty, QuestionFormatSelection } from "../types/index";
import type { SyncedNote } from "../types/notes";
import type {
    QuestionGenerationOptions,
    QuestionGenerationResult,
    NoteQuestionActionRequest,
} from "../types/questions";

export { QuestionGenerationError } from "../questions/generation";
const activeGenerations = new Set<string>();

export async function manageNoteQuestions(
    request: NoteQuestionActionRequest,
): Promise<SyncedNote> {
    const expectedQuestionIds = [...request.expectedQuestionIds];
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    const key = JSON.stringify([folderPath, request.noteId]);
    if (activeGenerations.has(key))
        throw new Error(
            "Questions are already being generated or updated for this note.",
        );
    activeGenerations.add(key);
    try {
        const card =
            request.action === "reset" ? createEmptyCard(new Date()) : null;
        return await invoke<SyncedNote>("manage_note_questions", {
            folderPath,
            ...request,
            expectedQuestionIds,
            fsrsData: card
                ? {
                      ...card,
                      due: card.due.toISOString(),
                      last_review: undefined,
                  }
                : null,
        });
    } finally {
        activeGenerations.delete(key);
    }
}

/**
 * luoKysymyksiä: complete the note's basic question set first, with FSRS cards.
 * Once complete, generate exactly the requested additional practice questions.
 * Basic generation always covers the whole note and ignores optional filters/count.
 * Explicit additional mode bypasses basic generation for fresh practice sessions.
 * Partial success is persisted; QuestionGenerationError.result exposes that progress.
 * This function performs paid AI calls only when explicitly called by the app.
 */
export async function generateQuestions(
    questionCount: number,
    noteId: string,
    topicIds: string[] = [],
    questionFormat: QuestionFormatSelection = 2,
    difficulty: Difficulty = 0,
    options: QuestionGenerationOptions = {},
): Promise<QuestionGenerationResult> {
    const folderPath = await getNotesFolderPath();
    if (!folderPath)
        throw new Error("Select a notes folder before generating questions.");
    const key = JSON.stringify([folderPath, noteId]);
    if (activeGenerations.has(key))
        throw new Error("Questions are already being generated for this note.");
    activeGenerations.add(key);
    try {
        return await runQuestionGeneration(
            {
                questionCount,
                noteId,
                topicIds,
                questionFormat,
                difficulty,
                outputLanguage: options.outputLanguage,
            },
            {
                loadNote: (noteId) =>
                    invoke<SyncedNote>("get_question_generation_note", {
                        folderPath,
                        noteId,
                    }),
                promptAi,
                saveBatch: (batch) =>
                    invoke<SyncedNote>("save_generated_questions", {
                        folderPath,
                        batch,
                    }),
            },
            options,
        );
    } finally {
        activeGenerations.delete(key);
    }
}
