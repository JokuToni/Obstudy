import { createEmptyCard } from "ts-fsrs";
import type { MobileCatalog } from "./types";
import type { Question } from "../types";

/** Explicit opt-in sample data; never mixed into a downloaded catalog. */
export function sampleCatalog(now = new Date()): MobileCatalog {
    const base = {
        noteId: "sample-intervals",
        isBasicQuestion: true,
        generatedAt: null,
        generatedWithModel: null,
        generationScope: null,
        lastAnsweredAt: null,
        averageScore: 0,
        topicIds: ["sample-topic"],
        materials: [],
    };
    const questions: Question[] = [
        {
            ...base,
            id: "sample-half-open",
            difficulty: 0,
            format: 0,
            text: "Which interval includes $0$ but excludes $4$?",
            choices: ["$[0,4)$", "$(0,4)$", "$(0,4]$", "$[0,4]$"],
            correctChoiceIndex: 0,
            exampleAnswer:
                "$[0,4)$ includes its left endpoint and excludes its right endpoint.",
        },
        {
            ...base,
            id: "sample-explanation",
            difficulty: 1,
            format: 1,
            text: "Explain why $x = 4$ does not belong to $[0,4)$.",
            maxCharacters: 2000,
            exampleAnswer:
                "The interval requires $0 \\le x < 4$. The right endpoint is excluded, so $x = 4$ does not satisfy the strict upper bound.",
            answerCriteria:
                "Explain the excluded endpoint or the strict upper bound.",
        },
        {
            ...base,
            id: "sample-intersection",
            difficulty: 1,
            format: 0,
            text: "What is $[0,4) \\cap [2,6]$?",
            choices: ["$[2,4)$", "$[0,6]$", "$(2,4]$", "$\\varnothing$"],
            correctChoiceIndex: 0,
            exampleAnswer:
                "Both conditions hold exactly for $2 \\le x < 4$, giving $[2,4)$.",
        },
    ];
    return {
        schemaVersion: 1,
        isSample: true,
        revision: "sample-v1",
        sets: [
            {
                id: base.noteId,
                title: "Sample: intervals",
                topics: [
                    {
                        id: "sample-topic",
                        noteId: base.noteId,
                        title: "Intervals",
                    },
                ],
                questions,
                cards: questions.map((question) => ({
                    questionId: question.id,
                    fsrsData: JSON.parse(JSON.stringify(createEmptyCard(now))),
                })),
            },
        ],
    };
}
