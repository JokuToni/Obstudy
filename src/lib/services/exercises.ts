import { scheduleReview, type StudyReviewContext } from "$lib/fsrs/scheduler";
import { invoke } from "@tauri-apps/api/core";
import { getNotesFolderPath } from "./settings";
import { generateQuestions, QuestionGenerationError } from "./questions";
import {
    effectiveExerciseSettings,
    selectExerciseQuestions,
    validateExerciseSettings,
    matchingPracticeQuestions,
    selectedDifficulties,
} from "../exercises/selection";
import type { PracticeSettings, StudyMode } from "../types/index";
import type { SyncedNote } from "../types/notes";
import type {
    ExerciseDraftAnswer,
    ExerciseDraftSaveResult,
    ExerciseSession,
} from "../types/exercises";

export async function savePracticeSettings(
    noteId: string,
    settings: PracticeSettings,
): Promise<SyncedNote> {
    validateExerciseSettings(settings);
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    return invoke("save_practice_settings", {
        folderPath,
        noteId,
        settings: { ...settings, topicIds: [...settings.topicIds] },
    });
}

/** luoHarjoitus: select due study cards or build a filtered practice session. */
export async function createExercise(
    settings: PracticeSettings,
    noteId: string,
    mode: StudyMode = "practice",
    onNoteUpdated?: (note: SyncedNote) => void,
): Promise<ExerciseSession> {
    const effective = effectiveExerciseSettings(settings, mode);
    validateExerciseSettings(effective);
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    let note = await invoke<SyncedNote>("get_question_generation_note", {
        folderPath,
        noteId,
    });
    let freshIds: Set<string> | null = null;
    const warnings: string[] = [];
    if (mode === "practice" && !effective.reuseQuestions) {
        if (!note.isAvailable || note.parseError || note.syncIssues.length)
            throw new Error(
                "Resolve note errors and pending topic changes before starting a session.",
            );
        matchingPracticeQuestions(note, effective); // Validate topic ownership before a paid request.
        const previousIds = new Set(
            note.questions.map((question) => question.id),
        );
        const levels = selectedDifficulties(effective);
        for (const [index, level] of levels.entries()) {
            const count =
                Math.floor(effective.questionCount / levels.length) +
                (index < effective.questionCount % levels.length ? 1 : 0);
            if (!count) continue;
            try {
                const generated = await generateQuestions(
                    count,
                    noteId,
                    effective.topicIds,
                    effective.questionFormat,
                    level,
                    {
                        generationMode: "additional",
                        onNoteUpdated,
                    },
                );
                note = generated.note;
                warnings.push(...generated.warnings);
            } catch (error) {
                if (
                    !(error instanceof QuestionGenerationError) ||
                    (error.result.generatedCount === 0 &&
                        !note.questions.some(
                            (question) => !previousIds.has(question.id),
                        ))
                )
                    throw error;
                note = error.result.note;
                warnings.push(
                    `Generation stopped early: ${error.message}`,
                    ...error.result.warnings,
                );
                break;
            }
        }
        onNoteUpdated?.(note);
        freshIds = new Set(
            note.questions
                .filter(
                    (question) =>
                        !previousIds.has(question.id) &&
                        !question.isBasicQuestion,
                )
                .map((question) => question.id),
        );
        if (!freshIds.size)
            throw new Error(
                "No fresh questions could be generated. Check generation notices or try reusing saved questions.",
            );
    }
    const selectionNote = freshIds
        ? {
              ...note,
              questions: note.questions.filter((question) =>
                  freshIds.has(question.id),
              ),
          }
        : note;
    const selection = selectExerciseQuestions(selectionNote, effective, mode);
    return invoke("create_exercise", {
        folderPath,
        request: {
            noteId,
            mode,
            settings: effective,
            questionIds: selection.questionIds,
            sourceText: note.file.text,
            dueBefore: selection.dueBefore,
            dueAfter: selection.dueAfter,
            dueNow: selection.dueNow,
            warnings: [...new Set([...warnings, ...selection.warnings])],
        },
    });
}

export async function openPracticeWindow(exerciseId: string): Promise<string> {
    const folderPath = await getNotesFolderPath();
    if (!folderPath) throw new Error("Select a notes folder first.");
    return invoke("open_practice_window", { folderPath, exerciseId });
}

/** The native window binds this ID to its original vault; no path is put in the URL. */
export function loadExerciseSession(
    exerciseId: string,
): Promise<ExerciseSession> {
    return invoke("load_exercise_session", { exerciseId });
}
export async function saveExerciseDraft(
    exerciseId: string,
    expectedRevision: number,
    answers: ExerciseDraftAnswer[],
    finish = false,
): Promise<ExerciseDraftSaveResult> {
    const snapshot = answers.map((answer) => ({ ...answer }));
    for (let attempt = 0; attempt < 2; attempt++) {
        const contexts = await invoke<StudyReviewContext[]>(
            "prepare_study_reviews",
            { exerciseId, answers: snapshot },
        );
        const fsrsUpdates = contexts.map(scheduleReview);
        try {
            return await invoke("save_exercise_draft", {
                exerciseId,
                expectedRevision,
                answers: snapshot,
                finish,
                fsrsUpdates,
            });
        } catch (error) {
            if (attempt === 0 && String(error).includes("Study card changed"))
                continue;
            throw error;
        }
    }
    throw new Error("Unable to update the Study schedule.");
}

export function closeExerciseSession(
    exerciseId: string,
    expectedRevision: number,
    voidUngraded: boolean,
): Promise<ExerciseSession> {
    return invoke("close_exercise_session", {
        exerciseId,
        expectedRevision,
        voidUngraded,
    });
}
