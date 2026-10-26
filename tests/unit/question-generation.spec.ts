import { expect, test } from "@playwright/test";
import {
    buildQuestionPrompt,
    parseGeneratedQuestions,
    planBasicQuestions,
    planAdditionalQuestions,
    runQuestionGeneration,
    QuestionGenerationError,
    type GenerationDependencies,
    type GenerationTask,
} from "../../src/lib/questions/generation";
import type { SyncedNote } from "../../src/lib/types/notes";
import type { AiResponse } from "../../src/lib/types/ai";
import type {
    GeneratedQuestion,
    QuestionGenerationBatch,
} from "../../src/lib/types/questions";

function noteFixture(): SyncedNote {
    return {
        id: "note",
        isStudying: true,
        file: { path: "/vault/Math.md", text: "Original note" },
        topics: [
            { id: "sets", noteId: "note", title: "Sets" },
            { id: "intervals", noteId: "note", title: "Intervals" },
            {
                id: "s1",
                noteId: "note",
                broadTopicId: "sets",
                title: "Membership",
                text: "A set contains elements. {{questionCount}} is source text, not a variable.",
            },
            {
                id: "s2",
                noteId: "note",
                broadTopicId: "sets",
                title: "Union",
                text: "A union combines elements.",
            },
            {
                id: "s3",
                noteId: "note",
                broadTopicId: "intervals",
                title: "Endpoints",
                text: "Closed intervals include endpoints.",
            },
        ],
        questions: [],
        performances: [],
        savedPracticeSettings: null,
        answers: [],
        exercises: [],
        questionFsrs: [],
        isAvailable: true,
        parseError: null,
        parseWarnings: [],
        syncIssues: [],
    };
}
function generated(task: GenerationTask, label: string): GeneratedQuestion {
    const base = {
        text: label,
        exampleAnswer: "A supported answer.",
        difficulty: task.difficulty,
        topicIds: [task.topics.find((topic) => "text" in topic)!.id],
    };
    return task.format === 0
        ? {
              ...base,
              format: 0,
              choices: ["Correct", "Other", "Third", "Fourth"],
              correctChoiceIndex: 0,
          }
        : {
              ...base,
              format: 1,
              maxCharacters: 500,
              answerCriteria: "Explain the concept correctly.",
          };
}
function response(text: string): AiResponse {
    return {
        text,
        integrationId: "chosen",
        provider: "openaiOauth",
        model: "selected-model",
        responseId: null,
        usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
        },
        rateLimits: { headers: {}, observedAt: 1 },
    };
}
function harness(initial = noteFixture()) {
    let note = structuredClone(initial);
    const batches: QuestionGenerationBatch[] = [];
    let calls = 0;
    const dependencies: GenerationDependencies = {
        loadNote: async () => structuredClone(note),
        promptAi: async (prompt) => {
            calls++;
            const match = prompt.match(
                /Generate (\d+) (?:easy|medium-difficulty|hard) questions with difficulty (\d)(?:\s+and)?(?:\s+format| and format)\s+(\d)/,
            );
            expect(match, prompt).not.toBeNull();
            const source = JSON.parse(
                prompt
                    .split("Source material (JSON reference data):\n")[1]
                    .split("\n\nExisting questions")[0],
            );
            const task = {
                difficulty: Number(match![2]),
                format: Number(match![3]),
                topics: [...source.broadTopics, ...source.subtopics],
            } as GenerationTask;
            return response(
                JSON.stringify({
                    questions: Array.from(
                        { length: Number(match![1]) },
                        (_, i) => generated(task, `Question ${calls}.${i}`),
                    ),
                    warnings: [],
                }),
            );
        },
        saveBatch: async (batch) => {
            expect(batch.expectedQuestionIds).toEqual(
                note.questions.map((question) => question.id),
            );
            batches.push(structuredClone(batch));
            for (const { fsrsData, ...draft } of batch.questions) {
                const id = `q${note.questions.length}`;
                note.questions.push({
                    ...draft,
                    id,
                    noteId: note.id,
                    isBasicQuestion: batch.isBasicQuestion,
                    generationScope: batch.scope,
                    generatedAt: new Date().toISOString(),
                    generatedWithModel: batch.model,
                    lastAnsweredAt: null,
                    averageScore: 0,
                    materials: [],
                });
                if (fsrsData)
                    note.questionFsrs.push({ questionId: id, fsrsData });
            }
            return structuredClone(note);
        },
    };
    return {
        dependencies,
        batches,
        get note() {
            return note;
        },
        get calls() {
            return calls;
        },
    };
}

test("basic plan has exact per-topic counts and the agreed rounded format distribution", () => {
    const note = noteFixture();
    const tasks = planBasicQuestions(note);
    const count = (difficulty: number, format?: number) =>
        tasks
            .filter(
                (task) =>
                    task.difficulty === difficulty &&
                    (format === undefined || task.format === format),
            )
            .reduce((sum, task) => sum + task.targetCount, 0);
    expect(count(0)).toBe(9);
    expect(count(0, 0)).toBe(5);
    expect(count(1)).toBe(6);
    expect(
        tasks
            .filter((task) => task.difficulty === 1 && task.format === 0)
            .map((task) => task.targetCount),
    ).toEqual([1, 1]);
    expect(count(2)).toBe(4);
    expect(count(2, 0)).toBe(0);
    for (const subtopic of ["s1", "s2", "s3"])
        expect(
            tasks
                .filter((task) => task.scope === `easy:${subtopic}`)
                .reduce((sum, task) => sum + task.targetCount, 0),
        ).toBe(3);
});

test("prompt includes actual scoped content and preserves source placeholders as data", () => {
    const note = noteFixture();
    const prompt = buildQuestionPrompt(
        note,
        planBasicQuestions(note)[0],
        2,
        "Finnish",
    );
    expect(prompt).toContain("A set contains elements.");
    expect(prompt).toContain(
        "{{questionCount}} is source text, not a variable.",
    );
    expect(prompt).not.toContain("A union combines elements.");
    expect(prompt).toContain(
        "Write questions, answers, choices, and grading criteria in Finnish.",
    );
    expect(prompt).toContain("Generate 2 easy questions");
    expect(prompt).toContain("ALL mathematical notation");
    expect(prompt).toContain("Wrap every inline math fragment in $...$");
    expect(prompt).toContain(String.raw`the LaTeX command \frac{1}{2}`);
});

test("response validation keeps good questions, rejects invalid topics, duplicates, and malformed choices", () => {
    const note = noteFixture();
    const task = planBasicQuestions(note)[0];
    const good = generated(task, "Valid question");
    const parsed = parseGeneratedQuestions(
        JSON.stringify({
            questions: [
                good,
                good,
                { ...good, text: "Bad topics", topicIds: ["foreign"] },
                {
                    ...good,
                    text: "Bad choices",
                    choices: ["Same", "same", "Third", "Fourth"],
                },
            ],
            warnings: [],
        }),
        task,
        4,
        note,
    );
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0].topicIds).toEqual(["s1", "sets"]);
    expect(parsed.warnings.join(" ")).toContain("duplicates");
    expect(parsed.warnings.join(" ")).toContain("topic IDs");
    expect(parsed.warnings.join(" ")).toContain("unique choices");
});

test("initial call generates the full basic set with serialized FSRS cards; next call honors additional filters without cards", async () => {
    const h = harness();
    const basic = await runQuestionGeneration(
        {
            questionCount: 1,
            noteId: "note",
            topicIds: ["s1"],
            difficulty: 2,
            questionFormat: 0,
        },
        h.dependencies,
    );
    expect(basic).toMatchObject({
        mode: "basic",
        complete: true,
        generatedCount: 19,
        requestedCount: 19,
    });
    expect(
        basic.note.questions.every(
            (question) =>
                question.isBasicQuestion &&
                question.generatedWithModel === "selected-model",
        ),
    ).toBe(true);
    expect(basic.note.questionFsrs).toHaveLength(19);
    expect(
        h.batches.every((batch) =>
            batch.questions.every(
                (question) =>
                    typeof question.fsrsData?.due === "string" &&
                    question.fsrsData.state === 0,
            ),
        ),
    ).toBe(true);
    const earlierCards = structuredClone(basic.note.questionFsrs);
    const additional = await runQuestionGeneration(
        {
            questionCount: 7,
            noteId: "note",
            topicIds: ["s2"],
            difficulty: 2,
            questionFormat: 0,
        },
        h.dependencies,
    );
    expect(additional).toMatchObject({
        mode: "additional",
        complete: true,
        generatedCount: 7,
        requestedCount: 7,
    });
    expect(additional.note.questionFsrs).toEqual(earlierCards);
    const added = additional.note.questions.slice(19);
    expect(
        added.every(
            (question) =>
                !question.isBasicQuestion &&
                question.difficulty === 2 &&
                question.format === 0 &&
                question.topicIds.includes("s2") &&
                !question.topicIds.includes("s1"),
        ),
    ).toBe(true);
    expect(additional.usage.totalTokens).toBe(60);
});

test("provider failure preserves completed batches and a later call resumes only missing basic slots", async () => {
    const h = harness();
    const normalPrompt = h.dependencies.promptAi;
    let attempts = 0;
    h.dependencies.promptAi = async (prompt) => {
        if (++attempts === 2)
            throw { code: "rateLimit", message: "Rate limit reached" };
        return normalPrompt(prompt);
    };
    let error: QuestionGenerationError | undefined;
    try {
        await runQuestionGeneration(
            { questionCount: 1, noteId: "note" },
            h.dependencies,
        );
    } catch (caught) {
        error = caught as QuestionGenerationError;
    }
    expect(error).toBeInstanceOf(QuestionGenerationError);
    expect(error?.message).toBe("Rate limit reached");
    expect(error?.result.generatedCount).toBe(2);
    expect(h.note.questions).toHaveLength(2);
    h.dependencies.promptAi = normalPrompt;
    const resumed = await runQuestionGeneration(
        { questionCount: 1, noteId: "note" },
        h.dependencies,
    );
    expect(resumed).toMatchObject({
        mode: "basic",
        requestedCount: 17,
        generatedCount: 17,
        complete: true,
    });
    expect(resumed.note.questionFsrs).toHaveLength(19);
});

test("only rejected or missing questions are retried and retries are bounded", async () => {
    const h = harness();
    const normalPrompt = h.dependencies.promptAi;
    const prompts: string[] = [];
    h.dependencies.promptAi = async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
            const task = planBasicQuestions(h.note)[0];
            return response(
                JSON.stringify({
                    questions: [
                        generated(task, "First valid question"),
                        {
                            ...generated(task, "Invalid question"),
                            topicIds: ["foreign"],
                        },
                    ],
                    warnings: [],
                }),
            );
        }
        return normalPrompt(prompt);
    };
    const result = await runQuestionGeneration(
        { questionCount: 1, noteId: "note" },
        h.dependencies,
    );
    expect(result.complete).toBe(true);
    expect(prompts[1]).toContain("Generate 1 easy questions");
    expect(prompts[1]).toContain("First valid question");
    expect(prompts[1]).toContain("Validation feedback");
    const noContent = harness();
    let calls = 0;
    noContent.dependencies.promptAi = async () => {
        calls++;
        return response(
            '{"questions":[],"warnings":["Insufficient source content."]}',
        );
    };
    const partial = await runQuestionGeneration(
        { questionCount: 1, noteId: "note" },
        noContent.dependencies,
    );
    expect(partial.complete).toBe(false);
    expect(partial.generatedCount).toBe(0);
    expect(calls).toBe(planBasicQuestions(noContent.note).length * 2);
});

test("additional mixed questions preserve exact count and target only selected subtopic content", () => {
    const note = noteFixture();
    const tasks = planAdditionalQuestions(note, {
        questionCount: 5,
        noteId: "note",
        topicIds: ["s1", "s3"],
        questionFormat: 2,
        difficulty: 0,
    });
    expect(tasks.reduce((sum, task) => sum + task.targetCount, 0)).toBe(5);
    expect(
        tasks
            .filter((task) => task.format === 0)
            .reduce((sum, task) => sum + task.targetCount, 0),
    ).toBe(3);
    expect(
        tasks.every((task) => !task.topics.some((topic) => topic.id === "s2")),
    ).toBe(true);
});

test("invalid requests and unresolved notes never call AI; cancellation prevents a request", async () => {
    for (const settings of [
        { questionCount: 0 },
        { questionCount: 1, topicIds: ["foreign"] },
    ]) {
        const h = harness();
        await expect(
            runQuestionGeneration(
                { noteId: "note", ...settings },
                h.dependencies,
            ),
        ).rejects.toThrow();
        expect(h.calls).toBe(0);
    }
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
        runQuestionGeneration(
            { noteId: "note", questionCount: 1 },
            h.dependencies,
            { signal: controller.signal },
        ),
    ).rejects.toThrow("cancelled");
    expect(h.calls).toBe(0);
    const note = noteFixture();
    note.parseError = "Invalid topic structure";
    const invalid = harness(note);
    await expect(
        runQuestionGeneration(
            { noteId: "note", questionCount: 1 },
            invalid.dependencies,
        ),
    ).rejects.toThrow("Resolve note errors");
    expect(invalid.calls).toBe(0);
});

test("medium format rounding applies across the note instead of rounding every broad topic up", () => {
    const note = noteFixture();
    note.topics = [0, 1, 2].flatMap((i) => [
        { id: `b${i}`, noteId: note.id, title: `Broad ${i}` },
        {
            id: `s${i}`,
            noteId: note.id,
            broadTopicId: `b${i}`,
            title: `Sub ${i}`,
            text: "Source content",
        },
    ]);
    const medium = planBasicQuestions(note).filter(
        (task) => task.difficulty === 1,
    );
    expect(medium.reduce((sum, task) => sum + task.targetCount, 0)).toBe(6);
    expect(
        medium
            .filter((task) => task.format === 0)
            .reduce((sum, task) => sum + task.targetCount, 0),
    ).toBe(2);
});

test("progress starts at zero and note updates accompany each persisted batch", async () => {
    const h = harness();
    const progress: number[] = [];
    const savedCounts: number[] = [];
    const result = await runQuestionGeneration(
        { questionCount: 1, noteId: "note" },
        h.dependencies,
        {
            onProgress: (event) => progress.push(event.generatedCount),
            onNoteUpdated: (note) => savedCounts.push(note.questions.length),
        },
    );
    expect(progress[0]).toBe(0);
    expect(progress.slice(1)).toEqual(savedCounts);
    expect(progress.at(-1)).toBe(result.requestedCount);
});

test("provider errors preserve only safe diagnostics alongside saved generation progress", async () => {
    const h = harness();
    h.dependencies.promptAi = async () => {
        throw {
            code: "invalidResponse",
            providerCode: "empty_output",
            requestId: "req-test-123",
            status: 200,
            message: "No assistant text was returned.",
            prompt: "private note text",
            authorization: "private credential",
        };
    };
    try {
        await runQuestionGeneration(
            { questionCount: 1, noteId: "note" },
            h.dependencies,
        );
        throw new Error("Expected generation to fail.");
    } catch (error) {
        expect(error).toBeInstanceOf(QuestionGenerationError);
        const failure = error as QuestionGenerationError;
        expect(failure.details).toContain("Provider code: empty_output");
        expect(failure.details).toContain("Request ID: req-test-123");
        expect(failure.details).toContain("HTTP status: 200");
        expect(failure.details).not.toContain("private");
        expect(failure.result.generatedCount).toBe(0);
    }
});
