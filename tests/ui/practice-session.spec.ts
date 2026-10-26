import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
    practiceNote,
    practiceSession,
    practiceSessionId,
} from "../fixtures/practice";
import type {
    ExerciseRequest,
    ExerciseSession,
    ExerciseDraftAnswer,
} from "../../src/lib/types/exercises";
import type { QuestionGenerationBatch } from "../../src/lib/types/questions";
import type { PracticeSettings } from "../../src/lib/types";

test.use({ timezoneId: "Europe/Helsinki" });
const practicePermissions: string[] = JSON.parse(
    readFileSync(
        new URL("../../src-tauri/capabilities/practice.json", import.meta.url),
        "utf8",
    ),
).permissions;
async function setup(
    page: Page,
    practice = false,
    math = false,
    native = false,
    extraQuestion = false,
): Promise<void> {
    await page.clock.install({ time: new Date("2026-10-25T12:00:00Z") });
    const initialNote = practiceNote(new Date("2026-10-25T12:00:00Z"));
    const dueDates = [
        "2026-10-24T12:00:00Z",
        "2026-10-25T18:00:00Z",
        "2026-10-24T12:00:00Z",
        "2026-10-26T12:00:00Z",
    ];
    initialNote.questionFsrs.forEach((stored, index) => {
        stored.fsrsData.due = dueDates[index];
    });
    const initialSession = practiceSession();
    if (extraQuestion) initialSession.questions.push(initialNote.questions[2]);
    if (math) {
        const question = initialSession.questions[0];
        question.text = String.raw`For x ∈ ℝ, compare \frac{1}{2} with \(x^2 \ge 0\). $$\sum_{n=1}^{3} n = 6$$ Miten ℝ_{>0} ja ℝ_{≥0} eroavat?`;
        question.exampleAnswer = String.raw`The answer is $\frac{1}{2}$.`;
        if (question.format === 0)
            question.choices = [
                "∅",
                String.raw`\frac{1}{2}`,
                String.raw`$\mathbb{R}$`,
                "ℝ_{≥0}",
            ];
    }
    await page.addInitScript(
        ({ initialNote, initialSession, native, practicePermissions }) => {
            const callbacks = new Map<number, (event: unknown) => unknown>();
            const listeners = new Map<string, number>();
            let callbackId = 0;
            const label = `practice-${initialSession.id}`;
            const note =
                (JSON.parse(
                    sessionStorage.getItem("practice-note-test") ?? "null",
                ) as typeof initialNote | null) ?? initialNote;
            let session: ExerciseSession =
                JSON.parse(
                    sessionStorage.getItem("practice-session-test") ?? "null",
                ) ?? initialSession;
            const calls: { command: string; args: Record<string, unknown> }[] =
                [];
            const controls = {
                failSave: false,
                failLoad: false,
                failWindow: false,
                holdSave: false,
                failDestroy: false,
                invalidAiGrade: false,
                holdAiGrade: false,
            };
            window.close = () => {
                calls.push({ command: "test:window-close", args: {} });
            };
            const persist = () => {
                sessionStorage.setItem(
                    "practice-session-test",
                    JSON.stringify(session),
                );
                sessionStorage.setItem(
                    "practice-note-test",
                    JSON.stringify(note),
                );
            };
            Object.assign(window, {
                isTauri: native,
                requestPracticeClose: async () => {
                    const handler = listeners.get("tauri://close-requested");
                    if (handler === undefined)
                        throw new Error("Close listener not registered");
                    await callbacks.get(handler)!({
                        event: "tauri://close-requested",
                        id: 1,
                        payload: null,
                    });
                },
                notifyPracticeProgress: async () => {
                    const handler = listeners.get("study-progress-updated");
                    if (handler === undefined)
                        throw new Error("Progress listener not registered");
                    await callbacks.get(handler)!({
                        event: "study-progress-updated",
                        id: 1,
                        payload: { noteId: note.id },
                    });
                },
                __TAURI_EVENT_PLUGIN_INTERNALS__: {
                    unregisterListener: () => {},
                },
                practiceCalls: calls,
                practiceControls: controls,
                __TAURI_INTERNALS__: {
                    metadata: {
                        currentWindow: { label },
                        currentWebview: { label },
                    },
                    transformCallback: (
                        callback: (event: unknown) => unknown,
                    ) => {
                        callbacks.set(++callbackId, callback);
                        return callbackId;
                    },
                    invoke: async (
                        command: string,
                        raw: Record<string, unknown> = {},
                    ) => {
                        const args = JSON.parse(JSON.stringify(raw)) as Record<
                            string,
                            unknown
                        >;
                        calls.push({ command, args });
                        switch (command) {
                            case "plugin:event|listen":
                                listeners.set(
                                    args.event as string,
                                    args.handler as number,
                                );
                                return args.handler;
                            case "plugin:event|unlisten":
                            case "plugin:window|set_background_color":
                            case "plugin:webview|set_webview_background_color":
                            case "plugin:window|show":
                                return;
                            case "plugin:window|destroy":
                                if (
                                    !practicePermissions.includes(
                                        "core:window:allow-destroy",
                                    )
                                )
                                    throw "Window destroy permission denied";
                                if (args.label !== label) throw "Wrong window";
                                if (controls.failDestroy)
                                    throw "Unable to close the practice window.";
                                return;
                            case "plugin:store|load":
                                return 1;
                            case "plugin:store|get":
                                return ["/test/vault", true];
                            case "fetch_obsidian_notes":
                                return {
                                    notes: [structuredClone(note)],
                                    warnings: [],
                                };
                            case "get_ai_configuration":
                                return {
                                    integrations: [
                                        {
                                            id: "ai",
                                            provider: "openai",
                                            model: "test-model",
                                            maxOutputTokens: 4096,
                                        },
                                    ],
                                    activeIntegrationId: "ai",
                                };
                            case "get_openai_oauth_account":
                                return null;
                            case "get_last_ai_response":
                                return null;
                            case "get_question_generation_note":
                                return structuredClone(note);
                            case "save_practice_settings":
                                note.savedPracticeSettings =
                                    args.settings as PracticeSettings;
                                persist();
                                return structuredClone(note);
                            case "create_exercise": {
                                const request = args.request as ExerciseRequest;
                                session = {
                                    ...initialSession,
                                    settings: request.settings,
                                    mode: request.mode,
                                    questions: request.questionIds.map((id) =>
                                        note.questions.find(
                                            (question) => question.id === id,
                                        )!,
                                    ),
                                    warnings: request.warnings,
                                    draftAnswers: [],
                                    revision: 0,
                                    reviewedAt: null,
                                };
                                persist();
                                return structuredClone(session);
                            }
                            case "open_practice_window":
                                if (controls.failWindow)
                                    throw "Unable to open the practice window.";
                                return `practice-${session.id}`;
                            case "load_exercise_session":
                                if (controls.failLoad)
                                    throw "Session is unavailable.";
                                return structuredClone(session);
                            case "save_exercise_draft": {
                                if (controls.holdSave)
                                    await new Promise<void>((resolve) => {
                                        Object.assign(window, {
                                            releasePracticeSave: resolve,
                                        });
                                    });
                                if (controls.failSave)
                                    throw "Unable to save the session.";
                                if (args.expectedRevision !== session.revision)
                                    throw "Stale revision";
                                session.draftAnswers =
                                    args.answers as ExerciseDraftAnswer[];
                                for (const answer of session.draftAnswers) {
                                    const presentedQuestion =
                                        session.questions.find(
                                            (question) =>
                                                question.id ===
                                                answer.questionId,
                                        );
                                    if (
                                        presentedQuestion?.format === 0 &&
                                        answer.revealed
                                    )
                                        answer.grade = {
                                            points:
                                                answer.selectedChoiceIndex ===
                                                presentedQuestion.correctChoiceIndex
                                                    ? 1
                                                    : 0,
                                            source: "automatic",
                                            feedback: "",
                                        };
                                    if (
                                        !answer.revealed ||
                                        !answer.grade ||
                                        note.answers.some(
                                            (saved) =>
                                                saved.exerciseId ===
                                                    session.id &&
                                                saved.questionId ===
                                                    answer.questionId,
                                        )
                                    )
                                        continue;
                                    const answeredAt = new Date().toISOString();
                                    note.answers.push({
                                        id: `submitted-${note.answers.length}`,
                                        exerciseId: session.id,
                                        mode: session.mode,
                                        questionId: answer.questionId,
                                        answeredAt,
                                        text: answer.text,
                                        points: answer.grade!.points,
                                        feedback: "",
                                    });
                                    const question = note.questions.find(
                                        (question) =>
                                            question.id === answer.questionId,
                                    );
                                    if (question)
                                        question.lastAnsweredAt = answeredAt;
                                }
                                session.revision++;
                                if (args.finish)
                                    session.reviewedAt =
                                        new Date().toISOString();
                                persist();
                                return {
                                    revision: session.revision,
                                    reviewedAt: session.reviewedAt,
                                };
                            }
                            case "close_exercise_session": {
                                if (session.closedAt)
                                    return structuredClone(session);
                                if (args.expectedRevision !== session.revision)
                                    throw "Stale revision";
                                if (
                                    !args.voidUngraded &&
                                    session.draftAnswers.some(
                                        (answer) =>
                                            answer.text.trim() && !answer.grade,
                                    )
                                )
                                    throw "Ungraded answers need confirmation";
                                session.draftAnswers =
                                    session.draftAnswers.filter(
                                        (answer) =>
                                            answer.revealed && answer.grade,
                                    );
                                note.answers = note.answers.filter(
                                    (answer) =>
                                        answer.exerciseId !== session.id ||
                                        answer.points !== null,
                                );
                                session.closedAt = new Date().toISOString();
                                session.maxPoints = session.draftAnswers.length;
                                session.revision++;
                                persist();
                                return structuredClone(session);
                            }
                            case "prompt_ai": {
                                if (
                                    (args.prompt as string).startsWith(
                                        "Grade the student's answer",
                                    )
                                ) {
                                    if (controls.holdAiGrade)
                                        await new Promise<void>((resolve) => {
                                            Object.assign(window, {
                                                releasePracticeAi: resolve,
                                            });
                                        });
                                    return {
                                        text: controls.invalidAiGrade
                                            ? '{"points":4}'
                                            : '{"points":0.5,"feedback":"The endpoint reasoning is incomplete."}',
                                        model: "test-grader",
                                    };
                                }
                                const match = (args.prompt as string).match(
                                    /Generate (\d+) (?:easy|medium-difficulty|hard) questions with difficulty (\d)(?:\s+and)?(?:\s+format| and format)\s+(\d)/,
                                )!;
                                const format = Number(match[3]);
                                const questions = Array.from(
                                    { length: Number(match[1]) },
                                    (_, index) => ({
                                        text: `Fresh question ${calls.length}.${index}`,
                                        exampleAnswer: "A supported answer",
                                        topicIds: ["sub"],
                                        difficulty: Number(match[2]),
                                        format,
                                        ...(format === 0
                                            ? {
                                                  choices: ["A", "B", "C", "D"],
                                                  correctChoiceIndex: 0,
                                              }
                                            : {
                                                  maxCharacters: 500,
                                                  answerCriteria:
                                                      "Explain the concept.",
                                              }),
                                    }),
                                );
                                return {
                                    text: JSON.stringify({
                                        questions,
                                        warnings: [],
                                    }),
                                    integrationId: "ai",
                                    model: "test-model",
                                    provider: "openai",
                                    responseId: null,
                                    usage: {
                                        inputTokens: 10,
                                        outputTokens: 20,
                                        totalTokens: 30,
                                        cacheReadInputTokens: 0,
                                        cacheCreationInputTokens: 0,
                                    },
                                    rateLimits: { headers: {}, observedAt: 0 },
                                };
                            }
                            case "save_generated_questions": {
                                const batch =
                                    args.batch as QuestionGenerationBatch;
                                for (const {
                                    fsrsData,
                                    ...question
                                } of batch.questions)
                                    note.questions.push({
                                        ...question,
                                        id: `fresh-${note.questions.length}`,
                                        noteId: note.id,
                                        isBasicQuestion: batch.isBasicQuestion,
                                        generatedAt: new Date().toISOString(),
                                        generatedWithModel: batch.model,
                                        generationScope: batch.scope,
                                        averageScore: 0,
                                        lastAnsweredAt: null,
                                        materials: [],
                                    });
                                return structuredClone(note);
                            }
                            default:
                                throw new Error(
                                    `Unexpected test command: ${command}`,
                                );
                        }
                    },
                },
            });
        },
        {
            initialNote,
            initialSession,
            native,
            practicePermissions,
        },
    );
    await page.goto(practice ? `/?practice=${practiceSessionId}` : "/");
}

async function selectNote(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Intervals", exact: true }).click();
}
async function calls(page: Page) {
    return page.evaluate(
        () =>
            (
                window as unknown as {
                    practiceCalls: {
                        command: string;
                        args: Record<string, unknown>;
                    }[];
                }
            ).practiceCalls,
    );
}

test("Start creates a due-only Study exercise and asks native code to open a separate window", async ({
    page,
}) => {
    await setup(page);
    await expect(
        page.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await selectNote(page);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "open_practice_window",
                ).length,
        )
        .toBe(1);
    const recorded = await calls(page);
    const request = recorded.find((call) => call.command === "create_exercise")!
        .args.request as ExerciseRequest;
    expect(request.mode).toBe("study");
    expect(request.questionIds).toEqual(["q0", "q1"]);
    expect(recorded.some((call) => call.command === "prompt_ai")).toBe(false);
    expect(
        recorded.find((call) => call.command === "open_practice_window")!.args
            .exerciseId,
    ).toBe(practiceSessionId);
});

for (const mode of ["Study", "Practice", "Fresh practice"] as const) {
    test(`${mode} uses the current question count without saving and retains it when settings reopen`, async ({
        page,
    }) => {
        await setup(page);
        await selectNote(page);
        if (mode !== "Study")
            await page
                .getByRole("button", { name: "Practice", exact: true })
                .click();
        const openSettings = async () => {
            await page
                .getByRole("button", { name: "Open a tab", exact: true })
                .click();
            await page
                .getByRole("button", { name: "Practice settings", exact: true })
                .click();
        };
        await openSettings();
        if (mode === "Fresh practice")
            await page
                .getByLabel("Reuse saved questions", { exact: true })
                .uncheck();
        await page.getByLabel("Number of questions", { exact: true }).fill("1");
        await page
            .getByRole("button", {
                name: "Close Practice settings",
                exact: true,
            })
            .click();
        await openSettings();
        await expect(
            page.getByLabel("Number of questions", { exact: true }),
        ).toHaveValue("1");
        for (const count of [1, 2]) {
            await page
                .getByLabel("Number of questions", { exact: true })
                .fill(String(count));
            await page
                .getByRole("button", { name: "Start", exact: true })
                .click();
            await expect
                .poll(
                    async () =>
                        (await calls(page)).filter(
                            (call) => call.command === "open_practice_window",
                        ).length,
                )
                .toBe(count);
            const recorded = await calls(page);
            const request = recorded
                .filter((call) => call.command === "create_exercise")
                .at(-1)!.args.request as ExerciseRequest;
            expect(request.settings.questionCount).toBe(count);
            expect(request.questionIds).toHaveLength(count);
            expect(
                recorded.some(
                    (call) => call.command === "save_practice_settings",
                ),
            ).toBe(false);
            if (mode !== "Fresh practice")
                expect(
                    recorded.some((call) => call.command === "prompt_ai"),
                ).toBe(false);
            else
                expect(
                    request.questionIds.every((id) => id.startsWith("fresh-")),
                ).toBe(true);
        }
    });
}

for (const fresh of [false, true]) {
    test(`multiple difficulties persist and ${fresh ? "fresh generation splits" : "reused selection filters"} the total question count`, async ({
        page,
    }) => {
        await setup(page);
        await selectNote(page);
        await page
            .getByRole("button", { name: "Practice", exact: true })
            .click();
        const openSettings = async () => {
            await page
                .getByRole("button", { name: "Open a tab", exact: true })
                .click();
            await page
                .getByRole("button", { name: "Practice settings", exact: true })
                .click();
        };
        await openSettings();
        await expect(
            page.getByRole("checkbox", { name: "Easy", exact: true }),
        ).toBeDisabled();
        await page
            .getByRole("checkbox", { name: "Medium", exact: true })
            .check();
        await page.getByRole("checkbox", { name: "Hard", exact: true }).check();
        await page
            .getByRole("checkbox", { name: "Easy", exact: true })
            .uncheck();
        await page.getByLabel("Number of questions", { exact: true }).fill("5");
        if (fresh) {
            await page
                .getByLabel("Reuse saved questions", { exact: true })
                .uncheck();
            await page
                .getByRole("button", { name: "Question format", exact: true })
                .click();
            await page
                .getByRole("button", { name: "Free text", exact: true })
                .click();
        }
        await page
            .getByRole("button", { name: "Save settings", exact: true })
            .click();
        await expect(
            page.getByText("Session settings saved.", { exact: true }),
        ).toBeVisible();
        await page.reload();
        await selectNote(page);
        await page
            .getByRole("button", { name: "Practice", exact: true })
            .click();
        await openSettings();
        await expect(
            page.getByRole("checkbox", { name: "Medium", exact: true }),
        ).toBeChecked();
        await expect(
            page.getByRole("checkbox", { name: "Hard", exact: true }),
        ).toBeChecked();
        await expect(
            page.getByRole("checkbox", { name: "Easy", exact: true }),
        ).not.toBeChecked();
        await page.getByRole("button", { name: "Start", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await calls(page)).filter(
                        (call) => call.command === "open_practice_window",
                    ).length,
            )
            .toBe(1);
        const request = (await calls(page)).find(
            (call) => call.command === "create_exercise",
        )!.args.request as ExerciseRequest;
        expect(request.settings.difficulties).toEqual([1, 2]);
        expect(request.settings.questionCount).toBe(5);
        if (fresh) {
            expect(request.questionIds).toHaveLength(5);
            const saved = await page.evaluate(
                () =>
                    JSON.parse(
                        sessionStorage.getItem("practice-session-test")!,
                    ) as ExerciseSession,
            );
            expect(
                saved.questions.filter((question) => question.difficulty === 1),
            ).toHaveLength(3);
            expect(
                saved.questions.filter((question) => question.difficulty === 2),
            ).toHaveLength(2);
        } else expect(request.questionIds).toEqual(["q1"]);
    });
}

test("session settings save and Practice with reuse disabled generates only fresh additional questions", async ({
    page,
}) => {
    await setup(page);
    await selectNote(page);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await page.getByRole("button", { name: "Open a tab", exact: true }).click();
    await page
        .getByRole("button", { name: "Practice settings", exact: true })
        .click();
    await page.getByLabel("Number of questions", { exact: true }).fill("2");
    await page
        .getByRole("button", { name: "Question format", exact: true })
        .click();
    await page.getByRole("button", { name: "Free text", exact: true }).click();
    await page.getByLabel("Reuse saved questions", { exact: true }).uncheck();
    await page
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
    await expect(
        page.getByText("Session settings saved.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "open_practice_window",
                ).length,
        )
        .toBe(1);
    const recorded = await calls(page);
    const request = recorded.find((call) => call.command === "create_exercise")!
        .args.request as ExerciseRequest;
    expect(request.mode).toBe("practice");
    expect(request.questionIds).toHaveLength(2);
    expect(request.questionIds.every((id) => id.startsWith("fresh-"))).toBe(
        true,
    );
    expect(
        recorded
            .filter((call) => call.command === "save_generated_questions")
            .every(
                (call) =>
                    (call.args.batch as QuestionGenerationBatch)
                        .isBasicQuestion === false,
            ),
    ).toBe(true);
});

test("practice window supports materials, answering, reload recovery, and a saved self-review", async ({
    page,
}) => {
    await setup(page, true);
    await expect(
        page.getByRole("region", { name: "Study workspace" }),
    ).toHaveCount(0);
    await expect(
        page.getByRole("heading", { name: "Intervals", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText("Question 1 of 2", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".katex").first()).toBeVisible();
    await page
        .getByRole("button", { name: "Next material", exact: true })
        .click();
    await expect(
        page.getByText("const isInInterval", { exact: false }),
    ).toBeVisible();
    await page.getByRole("radio").first().check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Example answer", exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Next question", exact: false })
        .click();
    await page
        .getByLabel("Your answer", { exact: true })
        .fill(
            "Closed intervals include both endpoints. Open intervals exclude them.",
        );
    await expect(
        page.getByRole("status", { name: "" }).filter({ hasText: /^Saved$/ }),
    ).toBeVisible();
    await page.reload();
    await expect(
        page.getByText("Question 2 of 2", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Your answer", { exact: true })).toHaveText(
        "Closed intervals include both endpoints. Open intervals exclude them.",
    );
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(
        page.getByRole("heading", { name: "Review your answers", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText("1 answer still needs a grade.", { exact: false }),
    ).toBeVisible();
    const recorded = await calls(page);
    expect(
        recorded.some(
            (call) =>
                call.command === "fetch_obsidian_notes" ||
                call.command === "plugin:store|get",
        ),
    ).toBe(false);
    expect(recorded.some((call) => call.command === "prompt_ai")).toBe(false);
    await page.reload();
    await expect(
        page.getByRole("heading", { name: "Review your answers", exact: true }),
    ).toBeVisible();
});

async function submitFreeform(page: Page): Promise<void> {
    await page.getByRole("radio").nth(1).check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect(
        page.getByText("Incorrect · 0 / 1", { exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Next question", exact: false })
        .click();
    await page
        .getByLabel("Your answer", { exact: true })
        .fill("An interval includes its left endpoint.");
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
}

for (const gradingMode of [
    "self immediately",
    "self in results",
    "AI in results",
] as const) {
    test(`${gradingMode} saves a freeform grade and automatic choice score`, async ({
        page,
    }) => {
        await setup(page, true);
        await submitFreeform(page);
        if (gradingMode === "self immediately")
            await page
                .getByRole("button", { name: "Correct · 1", exact: true })
                .click();
        if (gradingMode !== "self immediately")
            await page
                .getByRole("button", { name: "Skip", exact: true })
                .click();
        await expect(
            page.getByRole("heading", {
                name: "Review your answers",
                exact: true,
            }),
        ).toBeVisible();
        if (gradingMode !== "self immediately") {
            await expect(
                page.getByText("1 answer still needs a grade.", {
                    exact: false,
                }),
            ).toBeVisible();
            if (gradingMode === "self in results")
                await page
                    .getByRole("button", {
                        name: "Partly correct · 0.5",
                        exact: true,
                    })
                    .click();
            else {
                await page
                    .getByRole("button", { name: "Grade with AI", exact: true })
                    .click();
                await expect(
                    page.getByText("Graded by AI", { exact: true }),
                ).toBeVisible();
                await expect(
                    page.getByText("The endpoint reasoning is incomplete.", {
                        exact: true,
                    }),
                ).toBeVisible();
            }
        }
        await expect(
            page.getByText("All submitted answers are graded.", {
                exact: false,
            }),
        ).toBeVisible();
        const freeformReview = page.getByRole("region", {
            name: "Question 2 review",
            exact: true,
        });
        await expect(
            freeformReview.getByRole("heading", {
                name:
                    gradingMode === "self immediately"
                        ? "Graded · 1 / 1"
                        : "Graded · 0.5 / 1",
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            page.getByRole("group", { name: "Self grading", exact: true }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Grade with AI", exact: true }),
        ).toHaveCount(0);
        await page
            .getByRole("button", { name: "Save and exit", exact: true })
            .click();
        await expect
            .poll(
                async () =>
                    (await calls(page)).filter(
                        (call) => call.command === "test:window-close",
                    ).length,
            )
            .toBe(1);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const saved = await page.evaluate(
            () =>
                JSON.parse(
                    sessionStorage.getItem("practice-session-test")!,
                ) as ExerciseSession,
        );
        expect(saved.closedAt).toBeTruthy();
        expect(
            saved.draftAnswers.find((answer) => answer.questionId === "q0")
                ?.grade,
        ).toMatchObject({ points: 0, source: "automatic" });
        expect(
            saved.draftAnswers.find((answer) => answer.questionId === "q1")
                ?.grade,
        ).toMatchObject({
            points: gradingMode === "self immediately" ? 1 : 0.5,
            source: gradingMode === "AI in results" ? "ai" : "self",
        });
        await page.reload();
        await expect(
            page.getByText("Session saved", { exact: true }),
        ).toBeVisible();
        await expect(
            page.getByText("All submitted answers are graded.", {
                exact: false,
            }),
        ).toBeVisible();
    });
}

async function selectAnswer(
    page: Page,
    from: number,
    to = from,
): Promise<void> {
    await page.getByLabel("Your answer", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Home");
    for (let index = 0; index < from; index++)
        await page.keyboard.press("ArrowRight");
    for (let index = from; index < to; index++)
        await page.keyboard.press("Shift+ArrowRight");
}

async function answerSource(page: Page): Promise<string> {
    return page.evaluate(() => {
        const session = JSON.parse(
            sessionStorage.getItem("practice-session-test") ?? "null",
        ) as ExerciseSession | null;
        return (
            session?.draftAnswers.find((answer) => answer.questionId === "q1")
                ?.text ?? ""
        );
    });
}

async function answerCursor(page: Page): Promise<number> {
    return page
        .getByLabel("Your answer", { exact: true })
        .evaluate((element) => {
            const selection = window.getSelection();
            if (!selection?.focusNode) return -1;
            const range = document.createRange();
            range.selectNodeContents(element);
            range.setEnd(selection.focusNode, selection.focusOffset);
            return range.toString().length;
        });
}

test("MathQuill inserts inline KaTeX at the answer cursor and persists the LaTeX", async ({
    page,
}) => {
    await setup(page, true, false, false, true);
    await expect(page.getByRole("radio").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("Before  after");
    await selectAnswer(page, 7);
    await page
        .getByRole("button", { name: "Insert fraction", exact: true })
        .click();
    const equation = page.getByLabel("Equation", { exact: true });
    await expect(equation).toBeFocused();
    await page.keyboard.type("1");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("2");
    await page.keyboard.press("ArrowRight");
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await expect(answer).toHaveText("Before after");
    await expect(page.locator(".mq-fraction")).toBeVisible();
    for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        const colors = await page
            .locator(".mq-denominator")
            .evaluate((element) => {
                const style = getComputedStyle(element);
                return { line: style.borderTopColor, text: style.color };
            });
        expect(colors.line).toBe(colors.text);
        await page.screenshot({
            path: `/tmp/obstudy-math-editor-${colorScheme}-${test.info().project.name}.png`,
        });
    }
    await page
        .getByRole("button", { name: "Insert equation", exact: true })
        .click();
    await expect
        .poll(() => answerSource(page))
        .toBe(String.raw`Before $\frac{1}{2}$ after`);
    await expect(answer.locator("[data-answer-equation] .katex")).toBeVisible();
    await expect(answer).toBeFocused();
    expect(
        await answer.evaluate(
            (element) => getComputedStyle(element).fontFamily,
        ),
    ).toContain("sans-serif");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
        path: `/tmp/obstudy-inline-answer-dark-${test.info().project.name}.png`,
    });
    await page.keyboard.type("!");
    await expect
        .poll(() => answerSource(page))
        .toBe(String.raw`Before $\frac{1}{2}$! after`);
    await page.keyboard.press("Backspace");
    expect(
        await answer.evaluate(
            (element) => getComputedStyle(element).outlineStyle,
        ),
    ).toBe("none");
    expect(
        await answer
            .locator("..")
            .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe("none");
    await expect
        .poll(() =>
            page.evaluate(() => {
                const session = JSON.parse(
                    sessionStorage.getItem("practice-session-test") ?? "null",
                ) as ExerciseSession | null;
                return session?.draftAnswers.find(
                    (item) => item.questionId === "q1",
                )?.text;
            }),
        )
        .toBe(String.raw`Before $\frac{1}{2}$ after`);
    await page.reload();
    await expect
        .poll(() => answerSource(page))
        .toBe(String.raw`Before $\frac{1}{2}$ after`);
    await expect(answer.locator("[data-answer-equation] .katex")).toBeVisible();
    await answer.focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Insert fraction", exact: true }),
    ).toBeDisabled();
});

test("MathQuill replaces selected math and supports exponent, root, and cancel actions", async ({
    page,
}) => {
    await setup(page, true);
    await expect(page.getByRole("radio").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("Value $x$ only");
    await answer.locator("[data-answer-equation]").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Equation", { exact: true })).toBeFocused();
    await page.keyboard.type("y");
    await page
        .getByRole("button", { name: "Insert exponent", exact: true })
        .click();
    await page.keyboard.type("2");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect
        .poll(() => answerSource(page))
        .toMatch(/Value \$y\^\{?2\}?\$ only/);
    await expect(answer).toBeFocused();
    const saved = await answerSource(page);
    await page
        .getByRole("button", { name: "Insert square root", exact: true })
        .click();
    await expect(page.getByLabel("Equation", { exact: true })).toBeFocused();
    await page.keyboard.type("9");
    await expect(page.locator(".mq-sqrt-prefix")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
        page.getByRole("region", { name: "Equation editor", exact: true }),
    ).toHaveCount(0);
    await expect(answer).toBeFocused();
    await expect.poll(() => answerSource(page)).toBe(saved);
    await page
        .getByRole("button", { name: "Open equation editor", exact: true })
        .click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => answerSource(page)).toBe(saved);
    await expect(answer).toBeFocused();
    await answer.fill("Real numbers: ");
    await page.getByRole("button", { name: "Symbols", exact: true }).click();
    await page
        .getByRole("button", { name: "ℝ · Real numbers", exact: true })
        .click();
    await expect(page.getByLabel("Equation", { exact: true })).toBeFocused();
    await page
        .getByRole("button", { name: "Insert equation", exact: true })
        .click();
    await expect
        .poll(() => answerSource(page))
        .toBe(String.raw`Real numbers: $\mathbb{R}$`);
    await answer.locator("[data-answer-equation]").click();
    await expect(page.getByLabel("Equation", { exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
        .poll(() => answerSource(page))
        .toBe(String.raw`Real numbers: $\mathbb{R}$`);
});

test("inline equations support atomic deletion and undo while answer limits and literal code remain intact", async ({
    page,
}) => {
    await setup(page, true);
    await expect(page.getByRole("radio").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("Before $x^2$ after");
    await expect(answer.locator("[data-answer-equation] .katex")).toBeVisible();
    await answer.press("ControlOrMeta+End");
    for (let index = 0; index < " after".length; index++)
        await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await expect(answer.locator("[data-answer-equation]")).toHaveCount(0);
    await expect.poll(() => answerSource(page)).toBe("Before  after");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(answer.locator("[data-answer-equation] .katex")).toBeVisible();
    await expect.poll(() => answerSource(page)).toBe("Before $x^2$ after");
    await page.screenshot({
        path: `/tmp/obstudy-inline-answer-${test.info().project.name}.png`,
    });
    await answer.fill("a".repeat(501));
    await expect(page.getByRole("alert")).toContainText(
        "at most 500 characters",
    );
    await expect.poll(() => answerSource(page)).toBe("Before $x^2$ after");
    await answer.fill("Code: `$x$` and real math: $y$.");
    await expect(answer.locator("[data-answer-equation]")).toHaveCount(1);
    await expect(answer).toContainText("Code: `$x$`");
});

test("equation symbols respect the answer length limit without losing prose", async ({
    page,
}) => {
    await setup(page, true);
    await page.setViewportSize({ width: 580, height: 550 });
    await expect(page.getByRole("radio").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("a".repeat(499));
    await page.getByRole("button", { name: "Symbols", exact: true }).click();
    await page.getByRole("button", { name: "π · Pi", exact: true }).click();
    await expect(page.getByLabel("Equation", { exact: true })).toBeFocused();
    await page
        .getByRole("button", { name: "Insert equation", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText(
        "exceed the 500-character answer limit",
    );
    await expect(answer).toHaveText("a".repeat(499));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(answer).toBeFocused();
});

test("results focus the scrolling pane on entry, return from a question, and reload", async ({
    page,
}) => {
    await setup(page, true);
    await page.setViewportSize({ width: 580, height: 550 });
    await submitFreeform(page);
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    const main = page
        .getByRole("region", { name: "Practice session", exact: true })
        .getByRole("main");
    await expect(
        page.getByRole("heading", { name: "Review your answers", exact: true }),
    ).toBeVisible();
    await expect(main).toBeFocused();
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect
        .poll(() => main.evaluate((element) => element.scrollTop))
        .toBe(360);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect
        .poll(() => main.evaluate((element) => element.scrollTop))
        .toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ArrowDown");
    expect(await main.evaluate((element) => element.scrollTop)).toBe(120);
    await page.keyboard.press("ArrowUp");
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page
        .getByRole("region", { name: "Question 2 review", exact: true })
        .getByRole("button", { name: "View question", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Back to review", exact: true })
        .click();
    await expect(main).toBeFocused();
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    const viewQuestion = page
        .getByRole("button", { name: "View question", exact: true })
        .first();
    await viewQuestion.focus();
    await page.keyboard.press("ArrowDown");
    await expect(viewQuestion).toBeFocused();
    await page.reload();
    await expect(main).toBeFocused();
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
});

test("keyboard navigation focuses inputs, moves choice focus without selecting, and defaults the grading popup to Skip", async ({
    page,
}) => {
    await setup(page, true, false, false, true);
    const radios = page.getByRole("radio");
    await expect(radios.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).not.toBeChecked();
    await page.keyboard.press("ArrowUp");
    await expect(radios.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(radios.first()).not.toBeChecked();
    await expect(
        page.getByText("Question 1 of 3", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await expect
        .poll(async () =>
            page.evaluate(() => {
                const state = JSON.parse(
                    sessionStorage.getItem("practice-session-test") ?? "null",
                ) as ExerciseSession | null;
                const answer = state?.draftAnswers.find(
                    (answer) => answer.questionId === "q0",
                );
                return {
                    index: answer?.selectedChoiceIndex,
                    revealed: answer?.revealed,
                    points: answer?.grade?.points,
                };
            }),
        )
        .toEqual({ index: 0, revealed: true, points: 1 });
    const input = page.getByLabel("Your answer", { exact: true });
    await expect(input).toBeFocused();
    await page.keyboard.type("An endpoint explanation");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await selectAnswer(page, 0);
    await page.keyboard.press("ArrowLeft");
    await expect(input).toBeFocused();
    expect(await answerCursor(page)).toBe(0);
    await page.keyboard.press("ArrowRight");
    expect(await answerCursor(page)).toBe(1);
    await page.keyboard.press("ArrowLeft");
    expect(await answerCursor(page)).toBe(0);
    await input.press("ControlOrMeta+a");
    await page.keyboard.press("ArrowRight");
    expect(await answerCursor(page)).toBe("An endpoint explanation".length);
    await expect(
        page.getByRole("dialog", { name: "Grade your answer", exact: true }),
    ).toHaveCount(0);
    await page.locator("#practice-question").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
        page.getByText("Question 1 of 3", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(input).toBeFocused();
    await expect(input).toHaveText("An endpoint explanation");
    await page.keyboard.press("ArrowRight");
    const menu = page.getByRole("dialog", {
        name: "Grade your answer",
        exact: true,
    });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator("[data-grading-backdrop]")).toHaveCount(0);
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    const reopen = page.getByRole("button", {
        name: "Grade answer",
        exact: true,
    });
    await expect(reopen).toBeFocused();
    await expect(
        page.getByText("Not graded yet", { exact: true }),
    ).toBeVisible();
    await reopen.click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(reopen).toBeFocused();
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await reopen.click();
    await expect(
        menu.getByRole("button", { name: "Skip", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(
        menu.getByRole("button", { name: "Grade with AI", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(
        menu.getByRole("button", { name: "Skip", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
        page.getByText("Question 3 of 3", { exact: true }),
    ).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toContainText("Write your answer in your own words…");
    await page.locator("#practice-question").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
        page.getByText("Question 2 of 3", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("region", { name: "Grade this answer", exact: true }),
    ).toHaveCount(0);
    await page
        .getByRole("button", { name: "Grade answer", exact: true })
        .click();
    await page.keyboard.press("ArrowRight");
    await expect(
        menu.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(
        menu.getByRole("button", { name: "Incorrect · 0", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
        page.getByText("Question 3 of 3", { exact: true }),
    ).toBeVisible();
    await expect(input).toBeFocused();
    await expect
        .poll(async () => {
            const state = await page.evaluate(
                () =>
                    JSON.parse(
                        sessionStorage.getItem("practice-session-test")!,
                    ) as ExerciseSession,
            );
            return state.draftAnswers.find(
                (answer) => answer.questionId === "q1",
            )?.grade?.points;
        })
        .toBe(0);
});

test("AI selection advances and focuses the next input before grading completes; header stays slim", async ({
    page,
}) => {
    await setup(page, true, false, false, true);
    await page.setViewportSize({ width: 580, height: 550 });
    const header = page.locator("header");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(44);
    const title = await header
        .getByRole("heading", { name: "Intervals", exact: true })
        .boundingBox();
    const mode = await header
        .getByText("Study session", { exact: true })
        .boundingBox();
    expect(mode!.x).toBeGreaterThan(title!.x);
    expect(Math.abs(mode!.y - title!.y)).toBeLessThan(8);
    await submitFreeform(page);
    const menu = page.getByRole("dialog", {
        name: "Grade your answer",
        exact: true,
    });
    await expect(
        menu.getByRole("button", { name: "Skip", exact: true }),
    ).toBeFocused();
    for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const viewport of [
            { width: 580, height: 550 },
            { width: 1200, height: 900 },
        ]) {
            await page.setViewportSize(viewport);
            const body = (await page
                .locator("[data-practice-body]")
                .boundingBox())!;
            const backdrop = (await page
                .locator("[data-grading-backdrop]")
                .boundingBox())!;
            const popup = (await menu.boundingBox())!;
            const topBar = (await header.boundingBox())!;
            const bottomBar = (await page.locator("footer").boundingBox())!;
            expect(backdrop).toEqual(body);
            expect(
                Math.abs(popup.x + popup.width / 2 - (body.x + body.width / 2)),
            ).toBeLessThan(1);
            expect(
                Math.abs(
                    popup.y + popup.height / 2 - (body.y + body.height / 2),
                ),
            ).toBeLessThan(1);
            expect(popup.y).toBeGreaterThanOrEqual(body.y);
            expect(popup.y + popup.height).toBeLessThanOrEqual(
                body.y + body.height,
            );
            expect(topBar.y + topBar.height).toBeLessThanOrEqual(backdrop.y);
            expect(bottomBar.y).toBeGreaterThanOrEqual(
                backdrop.y + backdrop.height,
            );
            const glass = await page
                .locator("[data-grading-backdrop]")
                .evaluate((element) => {
                    const style = getComputedStyle(element);
                    return {
                        background: style.backgroundColor,
                        blur: style.backdropFilter,
                    };
                });
            expect(["rgba(0, 0, 0, 0.5)", "oklab(0 0 0 / 0.5)"]).toContain(
                glass.background,
            );
            expect(glass.blur).toBe("blur(8px)");
        }
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 580, height: 550 });
    await page.screenshot({
        path: `/tmp/obstudy-grading-menu-${test.info().project.name}.png`,
    });
    await page
        .getByText("What a good answer includes", { exact: true })
        .click();
    await expect(
        page.getByText("Explain whether endpoints belong to each interval.", {
            exact: true,
        }),
    ).toBeVisible();
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { holdAiGrade: boolean } }
        ).practiceControls.holdAiGrade = true;
    });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => "releasePracticeAi" in window);
    await expect(
        page.getByText("Question 3 of 3", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Your answer", { exact: true })).toBeFocused();
    await page.keyboard.type("Continue while AI grades");
    await page.evaluate(() => {
        (
            window as unknown as { releasePracticeAi: () => void }
        ).releasePracticeAi();
    });
    await expect
        .poll(async () => {
            const state = await page.evaluate(
                () =>
                    JSON.parse(
                        sessionStorage.getItem("practice-session-test")!,
                    ) as ExerciseSession,
            );
            return state.draftAnswers.find(
                (answer) => answer.questionId === "q1",
            )?.grade?.source;
        })
        .toBe("ai");
    await expect(page.getByLabel("Your answer", { exact: true })).toHaveText(
        "Continue while AI grades",
    );
    await expect(page.getByLabel("Your answer", { exact: true })).toBeFocused();
});

test("invalid AI grading can be retried or replaced with self grading", async ({
    page,
}) => {
    await setup(page, true);
    await submitFreeform(page);
    await page.evaluate(() => {
        (
            window as unknown as {
                practiceControls: { invalidAiGrade: boolean };
            }
        ).practiceControls.invalidAiGrade = true;
    });
    await page
        .getByRole("button", { name: "Grade with AI", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText("invalid grade");
    await page
        .getByRole("button", { name: "Incorrect · 0", exact: true })
        .click();
    await expect(page.getByText("Self graded", { exact: true })).toBeVisible();
    await expect(
        page.getByRole("heading", { name: "Graded · 0 / 1", exact: true }),
    ).toHaveCount(2);
    await expect(
        page.getByRole("group", { name: "Self grading", exact: true }),
    ).toHaveCount(0);
    await expect(
        page.getByRole("button", { name: "Grade with AI", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "test:window-close",
                ).length,
        )
        .toBe(1);
});

test("native close confirms ungraded answers and ignores an AI grade arriving after discard", async ({
    page,
}) => {
    await setup(page, true, false, true);
    await submitFreeform(page);
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { holdAiGrade: boolean } }
        ).practiceControls.holdAiGrade = true;
    });
    await page
        .getByRole("button", { name: "Grade with AI", exact: true })
        .click();
    await page.waitForFunction(() => "releasePracticeAi" in window);
    await page.evaluate(async () => {
        await (
            window as unknown as { requestPracticeClose: () => Promise<void> }
        ).requestPracticeClose();
    });
    await expect(page.getByRole("dialog")).toContainText(
        "Leave ungraded answers?",
    );
    await page.screenshot({
        path: `/tmp/obstudy-grading-exit-${test.info().project.name}.png`,
    });
    expect(
        (await calls(page)).some(
            (call) => call.command === "plugin:window|destroy",
        ),
    ).toBe(false);
    await page
        .getByRole("button", { name: "Review ungraded answers", exact: true })
        .click();
    await expect(
        page.getByRole("heading", { name: "Review your answers", exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Discard ungraded and exit", exact: true })
        .click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "plugin:window|destroy",
                ).length,
        )
        .toBe(1);
    await page.evaluate(async () => {
        (
            window as unknown as { releasePracticeAi: () => void }
        ).releasePracticeAi();
        await new Promise(requestAnimationFrame);
    });
    const saved = await page.evaluate(
        () =>
            JSON.parse(
                sessionStorage.getItem("practice-session-test")!,
            ) as ExerciseSession,
    );
    expect(saved.draftAnswers).toHaveLength(1);
    expect(saved.draftAnswers[0].questionId).toBe("q0");
    expect(JSON.stringify(saved.draftAnswers)).not.toContain(
        "An interval includes",
    );
    expect(
        (await calls(page))
            .filter((call) => call.command === "save_exercise_draft")
            .some((call) =>
                (call.args.answers as ExerciseDraftAnswer[]).some(
                    (answer) => answer.questionId === "q1" && answer.grade,
                ),
            ),
    ).toBe(false);
});

test("save errors keep the answer editable and can be retried", async ({
    page,
}) => {
    await setup(page, true);
    await page.getByRole("radio").first().check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Next question", exact: false })
        .click();
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failSave: boolean } }
        ).practiceControls.failSave = true;
    });
    await page
        .getByLabel("Your answer", { exact: true })
        .fill("My answer stays here.");
    await expect(page.getByRole("alert")).toContainText("Unable to save");
    await expect(page.getByLabel("Your answer", { exact: true })).toHaveText(
        "My answer stays here.",
    );
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failSave: boolean } }
        ).practiceControls.failSave = false;
    });
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("questions and every choice typeset delimited and legacy math", async ({
    page,
}) => {
    await setup(page, true, true);
    const question = page.locator("#practice-question");
    await expect(question.locator(".katex")).toHaveCount(6);
    await expect(question.locator("msub")).toHaveCount(2);
    for (const rendered of await question
        .locator(".katex-html")
        .allTextContents())
        expect(rendered).not.toMatch(/[{}]/);
    await expect(question.locator(".katex-display")).toHaveCount(1);
    const choices = page.locator("fieldset label");
    await expect(choices.nth(3).locator("msub")).toHaveCount(1);
    for (let index = 0; index < 4; index++) {
        await expect(choices.nth(index).locator(".katex")).toHaveCount(1);
        await expect(choices.nth(index).locator("math")).toHaveCount(1);
    }
    await expect(page.locator(".katex-error")).toHaveCount(0);
    await page.screenshot({
        path: `/tmp/obstudy-math-subscripts-${test.info().project.name}.png`,
    });
    await page.getByRole("radio").nth(1).check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect(
        page
            .getByRole("region", { name: "Example answer", exact: true })
            .locator(".katex"),
    ).toHaveCount(2);
    await expect(page.locator(".katex-error")).toHaveCount(0);
});

test("confirmed exit voids an unrevealed draft and keeps the graded choice", async ({
    page,
}) => {
    await setup(page, true);
    await page.getByRole("radio").first().check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Next question", exact: false })
        .click();
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { holdSave: boolean } }
        ).practiceControls.holdSave = true;
    });
    await page
        .getByLabel("Your answer", { exact: true })
        .fill("My unfinished answer");
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect(page.getByRole("dialog")).toContainText(
        "Leave ungraded answers?",
    );
    await page
        .getByRole("button", { name: "Discard ungraded and exit", exact: true })
        .click();
    await expect(
        page.getByRole("button", { name: "Saving and exiting…" }),
    ).toBeDisabled();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "save_exercise_draft",
                ).length,
        )
        .toBeGreaterThan(0);
    expect(
        (await calls(page)).some(
            (call) => call.command === "test:window-close",
        ),
    ).toBe(false);
    await page.waitForFunction(() => "releasePracticeSave" in window);
    await page.evaluate(() => {
        const context = window as unknown as {
            practiceControls: { holdSave: boolean };
            releasePracticeSave: () => void;
        };
        context.practiceControls.holdSave = false;
        context.releasePracticeSave();
    });
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "test:window-close",
                ).length,
        )
        .toBe(1);
    const saved = await page.evaluate(
        () =>
            JSON.parse(
                sessionStorage.getItem("practice-session-test")!,
            ) as ExerciseSession,
    );
    expect(saved.reviewedAt).toBeNull();
    expect(saved.draftAnswers).toHaveLength(1);
    expect(saved.closedAt).toBeTruthy();
    expect(JSON.stringify(saved.draftAnswers)).not.toContain(
        "My unfinished answer",
    );
    await page.reload();
    await expect(
        page.getByText("Session saved", { exact: true }),
    ).toBeVisible();
});

test("Save and exit keeps the session open on save failure and retries safely", async ({
    page,
}) => {
    await setup(page, true);
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failSave: boolean } }
        ).practiceControls.failSave = true;
    });
    await page.getByRole("radio").first().check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText("Unable to save");
    await expect(page.getByRole("radio").first()).toBeChecked();
    expect(
        (await calls(page)).some(
            (call) => call.command === "test:window-close",
        ),
    ).toBe(false);
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failSave: boolean } }
        ).practiceControls.failSave = false;
    });
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "test:window-close",
                ).length,
        )
        .toBe(1);
    const saved = await page.evaluate(
        () =>
            JSON.parse(
                sessionStorage.getItem("practice-session-test")!,
            ) as ExerciseSession,
    );
    expect(saved.reviewedAt).toBeNull();
    expect(saved.draftAnswers[0].selectedChoiceIndex).toBe(0);
});

for (const exitMethod of ["button", "native close"] as const) {
    test(`Tauri ${exitMethod} saves answers before destroying the practice window`, async ({
        page,
    }) => {
        await setup(page, true, false, true);
        await expect
            .poll(async () =>
                (await calls(page)).some(
                    (call) =>
                        call.command === "plugin:event|listen" &&
                        call.args.event === "tauri://close-requested",
                ),
            )
            .toBe(true);
        await page.getByRole("radio").first().check();
        await page
            .getByRole("button", { name: "Reveal answer", exact: true })
            .click();
        if (exitMethod === "button") {
            await page
                .getByRole("button", { name: "Save and exit", exact: true })
                .click();
        } else {
            await page.evaluate(async () => {
                await (
                    window as unknown as {
                        requestPracticeClose: () => Promise<void>;
                    }
                ).requestPracticeClose();
            });
        }
        await expect
            .poll(
                async () =>
                    (await calls(page)).filter(
                        (call) => call.command === "plugin:window|destroy",
                    ).length,
            )
            .toBe(1);
        const recorded = await calls(page);
        const savedAt = recorded.findIndex(
            (call) => call.command === "save_exercise_draft",
        );
        const destroyedAt = recorded.findIndex(
            (call) => call.command === "plugin:window|destroy",
        );
        expect(savedAt).toBeGreaterThanOrEqual(0);
        expect(destroyedAt).toBeGreaterThan(savedAt);
        expect(recorded[destroyedAt].args.label).toBe(
            `practice-${practiceSessionId}`,
        );
        expect(
            recorded.some(
                (call) =>
                    call.command === "plugin:window|close" ||
                    call.command === "test:window-close",
            ),
        ).toBe(false);
        const saved = await page.evaluate(
            () =>
                JSON.parse(
                    sessionStorage.getItem("practice-session-test")!,
                ) as ExerciseSession,
        );
        expect(saved.draftAnswers[0].selectedChoiceIndex).toBe(0);
        expect(saved.reviewedAt).toBeNull();
    });
}

test("a native close failure is shown and can be retried without resaving or losing answers", async ({
    page,
}) => {
    await setup(page, true, false, true);
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failDestroy: boolean } }
        ).practiceControls.failDestroy = true;
    });
    await page.getByRole("radio").first().check();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText(
        "Unable to close the practice window",
    );
    await expect(
        page.getByRole("button", { name: "Save and exit", exact: true }),
    ).toBeEnabled();
    await expect(
        page.getByText("Session saved", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failDestroy: boolean } }
        ).practiceControls.failDestroy = false;
    });
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "plugin:window|destroy",
                ).length,
        )
        .toBe(2);
    expect(
        (await calls(page)).filter(
            (call) => call.command === "save_exercise_draft",
        ),
    ).toHaveLength(1);
});

for (const refresh of ["focus", "native notification"] as const) {
    test(`note statistics refresh after submission via ${refresh}, survive reload, and Study skips the saved question`, async ({
        page,
    }) => {
        await setup(page, false, false, refresh === "native notification");
        await selectNote(page);
        const statistic = (label: string) =>
            page
                .locator("dl > div")
                .filter({ has: page.locator("dt", { hasText: label }) })
                .locator("dd");
        await expect(statistic("Answers submitted")).toHaveText("0");
        await page.evaluate(async (exerciseId) => {
            const path = "/src/lib/services/exercises.ts";
            const { saveExerciseDraft } = await import(/* @vite-ignore */ path);
            await saveExerciseDraft(exerciseId, 0, [
                {
                    questionId: "q0",
                    text: "My submitted choice",
                    selectedChoiceIndex: 0,
                    revealed: true,
                },
            ]);
        }, practiceSessionId);
        if (refresh === "focus")
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        else
            await page.evaluate(async () => {
                await (
                    window as unknown as {
                        notifyPracticeProgress: () => Promise<void>;
                    }
                ).notifyPracticeProgress();
            });
        await expect(statistic("Answers submitted")).toHaveText("1");
        await expect(statistic("Questions answered")).toHaveText("1");
        await expect(statistic("Average points per graded answer")).toHaveText(
            "1.0",
        );
        await expect(
            page.getByText("0 ungraded answers", { exact: false }),
        ).toBeVisible();
        await page.reload();
        await selectNote(page);
        await expect(statistic("Answers submitted")).toHaveText("1");
        await page.getByRole("button", { name: "Start", exact: true }).click();
        await expect
            .poll(
                async () =>
                    (await calls(page)).filter(
                        (call) => call.command === "create_exercise",
                    ).length,
            )
            .toBe(1);
        const request = (await calls(page)).find(
            (call) => call.command === "create_exercise",
        )!.args.request as ExerciseRequest;
        expect(request.questionIds).toEqual(["q1"]);
    });
}

test("practice view fits compact and large windows in both themes", async ({
    page,
}) => {
    await setup(page, true);
    await expect(
        page.getByText("Question 1 of 2", { exact: true }),
    ).toBeVisible();
    for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const [width, height] of [
            [580, 550],
            [860, 780],
            [1200, 900],
        ]) {
            await page.setViewportSize({ width, height });
            await expect(
                page.getByRole("button", {
                    name: "Reveal answer",
                    exact: true,
                }),
            ).toBeInViewport();
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth >
                        window.innerWidth,
                ),
            ).toBe(false);
            await page.screenshot({
                path: `/tmp/obstudy-practice-${test.info().project.name}-${colorScheme}-${width}.png`,
            });
        }
    }
});

test("window launch retry reuses the already prepared exercise", async ({
    page,
}) => {
    await setup(page);
    await selectNote(page);
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failWindow: boolean } }
        ).practiceControls.failWindow = true;
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
        "Unable to open the practice window",
    );
    await page.evaluate(() => {
        (
            window as unknown as { practiceControls: { failWindow: boolean } }
        ).practiceControls.failWindow = false;
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect
        .poll(
            async () =>
                (await calls(page)).filter(
                    (call) => call.command === "open_practice_window",
                ).length,
        )
        .toBe(2);
    expect(
        (await calls(page)).filter(
            (call) => call.command === "create_exercise",
        ),
    ).toHaveLength(1);
});
