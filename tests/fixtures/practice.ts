import { createEmptyCard } from "ts-fsrs";
import type { Question } from "../../src/lib/types/index";
import type { SyncedNote } from "../../src/lib/types/notes";
import type { ExerciseSession } from "../../src/lib/types/exercises";

export const practiceSessionId = "11111111-1111-4111-8111-111111111111";
export function practiceNote(now = new Date(2026, 9, 25, 12)): SyncedNote {
    const base = {
        noteId: "note",
        generatedAt: now.toISOString(),
        generatedWithModel: "test-model",
        generationScope: null,
        lastAnsweredAt: null,
        averageScore: 0,
        topicIds: ["broad", "sub"],
        exampleAnswer:
            "The interval includes its left endpoint and excludes its right endpoint.",
        materials: [],
    };
    const questions: Question[] = [
        {
            ...base,
            id: "q0",
            text: "Which interval includes $0$ and excludes $4$?",
            isBasicQuestion: true,
            difficulty: 0,
            format: 0,
            choices: ["$[0,4)$", "$(0,4)$", "$(0,4]$", "$[0,4]$"],
            correctChoiceIndex: 0,
            materials: [
                { type: "latex", content: "0 \\le x < 4" },
                {
                    type: "code",
                    content: "const isInInterval = (x) => x >= 0 && x < 4;",
                    language: "javascript",
                },
            ],
        },
        {
            ...base,
            id: "q1",
            text: "Explain the difference between an open and a closed interval.",
            isBasicQuestion: true,
            difficulty: 2,
            format: 1,
            maxCharacters: 500,
            answerCriteria:
                "Explain whether endpoints belong to each interval.",
        },
        {
            ...base,
            id: "q2",
            text: "Give an example of a half-open interval.",
            isBasicQuestion: false,
            difficulty: 0,
            format: 1,
            maxCharacters: 200,
            answerCriteria: "Include exactly one endpoint.",
        },
        {
            ...base,
            id: "q3",
            text: "Which set is empty?",
            isBasicQuestion: true,
            difficulty: 0,
            format: 0,
            topicIds: ["other"],
            choices: ["A", "B", "C", "D"],
            correctChoiceIndex: 1,
        },
    ];
    const dates = [
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20),
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    ];
    return {
        id: "note",
        isStudying: true,
        file: { path: "/test/vault/Intervals.md", text: "Source note" },
        topics: [
            { id: "broad", noteId: "note", title: "Intervals" },
            {
                id: "sub",
                noteId: "note",
                broadTopicId: "broad",
                title: "Endpoints",
                text: "Intervals can include or exclude their endpoints.",
            },
            { id: "other", noteId: "note", title: "Sets" },
        ],
        questions,
        questionFsrs: dates.map((date, index) => ({
            questionId: `q${index}`,
            fsrsData: {
                ...createEmptyCard(date),
                due: date.toISOString(),
                last_review: undefined,
            },
        })),
        performances: [],
        savedPracticeSettings: {
            questionCount: 10,
            difficulty: 0,
            reuseQuestions: true,
            questionFormat: 2,
            topicIds: [],
        },
        answers: [],
        exercises: [],
        isAvailable: true,
        parseError: null,
        parseWarnings: [],
        syncIssues: [],
    };
}
export function practiceSession(): ExerciseSession {
    const note = practiceNote();
    return {
        id: practiceSessionId,
        noteId: note.id,
        mode: "study",
        settings: note.savedPracticeSettings!,
        maxPoints: 2,
        questions: note.questions.slice(0, 2),
        noteTitle: "Intervals",
        warnings: [
            "Only 2 basic questions are due today. No new questions were generated.",
        ],
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        revision: 0,
        draftAnswers: [],
    };
}
