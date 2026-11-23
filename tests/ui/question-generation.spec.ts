import { expect, test, type Page } from "@playwright/test";
import type { SyncedNote } from "../../src/lib/types/notes";
import type { QuestionGenerationBatch } from "../../src/lib/types/questions";

interface GenerationMockOptions {
    showNote?: boolean;
    configured?: boolean;
    pauseAtCall?: number;
    failAtCall?: number;
    emptyResponses?: boolean;
    parseError?: string;
    pendingModel?: boolean;
}

async function mockGeneration(
    page: Page,
    options: GenerationMockOptions = {},
): Promise<void> {
    await page.addInitScript((options: GenerationMockOptions) => {
        let aiCalls = 0;
        const batches: QuestionGenerationBatch[] = [];
        let savedModel = options.pendingModel ? "" : "active-model";
        const managementCalls: Record<string, unknown>[] = [];
        const note: SyncedNote = {
            id: "note",
            isStudying: true,
            file: { path: "/test/vault/Sets.md", text: "Source note" },
            topics: [
                { id: "broad", noteId: "note", title: "Sets" },
                {
                    id: "sub",
                    noteId: "note",
                    broadTopicId: "broad",
                    title: "Membership",
                    text: "A set contains elements.",
                },
            ],
            questions: [],
            questionFsrs: [],
            performances: [],
            answers: [],
            exercises: [],
            savedPracticeSettings: null,
            syncIssues: [],
            isAvailable: true,
            parseError: null,
            parseWarnings: [],
        };
        note.parseError = options.parseError ?? null;
        const controls = {
            pauseAtCall: options.pauseAtCall ?? 0,
            failAtCall: options.failAtCall ?? 0,
            emptyResponses: options.emptyResponses ?? false,
            aiCalls: 0,
            failManagement: false,
        };
        let releaseGeneration: (() => void) | undefined;
        Object.assign(window, {
            generationControls: controls,
            continueGeneration: () => releaseGeneration?.(),
            generationBatches: batches,
            managementCalls,
            __TAURI_INTERNALS__: {
                invoke: async (
                    command: string,
                    args: Record<string, unknown> = {},
                ) => {
                    switch (command) {
                        case "plugin:store|load":
                            return 1;
                        case "plugin:store|get":
                            return ["/test/vault", true];
                        case "fetch_obsidian_notes":
                            return {
                                notes: options.showNote
                                    ? [structuredClone(note)]
                                    : [],
                                warnings: [],
                            };
                        case "get_ai_configuration":
                            return {
                                integrations:
                                    options.configured || options.pendingModel
                                        ? [
                                              {
                                                  id: "active",
                                                  provider: "openaiOauth",
                                                  model: savedModel,
                                                  maxOutputTokens: 2000,
                                              },
                                          ]
                                        : [],
                                activeIntegrationId:
                                    options.configured || options.pendingModel
                                        ? "active"
                                        : null,
                            };
                        case "get_openai_oauth_account":
                            return options.configured || options.pendingModel
                                ? {
                                      email: "test@example.com",
                                      connected: true,
                                      planEnabled: true,
                                  }
                                : null;
                        case "get_last_ai_response":
                            return null;
                        case "list_openai_oauth_models":
                            return [
                                {
                                    id: "active-model",
                                    name: "Active model",
                                    effortLevels: [],
                                },
                            ];
                        case "save_ai_integration":
                            savedModel = (args.integration as { model: string })
                                .model;
                            return;
                        case "select_ai_integration":
                            return;
                        case "manage_note_questions": {
                            managementCalls.push(structuredClone(args));
                            if (controls.failManagement)
                                throw "Simulated storage failure";
                            if (args.action === "remove") {
                                note.questions = [];
                                note.questionFsrs = [];
                            } else {
                                note.questionFsrs = note.questions
                                    .filter(
                                        (question) => question.isBasicQuestion,
                                    )
                                    .map((question) => ({
                                        questionId: question.id,
                                        fsrsData: structuredClone(
                                            args.fsrsData,
                                        ) as SyncedNote["questionFsrs"][number]["fsrsData"],
                                    }));
                            }
                            return structuredClone(note);
                        }
                        case "get_question_generation_note":
                            return structuredClone(note);
                        case "prompt_ai": {
                            aiCalls++;
                            controls.aiCalls = aiCalls;
                            if (aiCalls === controls.pauseAtCall)
                                await new Promise<void>((resolve) => {
                                    releaseGeneration = resolve;
                                });
                            if (aiCalls === controls.failAtCall)
                                throw {
                                    code: "rateLimit",
                                    requestId: "req-generation-test",
                                    status: 429,
                                    message:
                                        "Rate limit reached. Try again shortly.",
                                };
                            const prompt = args.prompt as string;
                            const match = prompt.match(
                                /Generate (\d+) (?:easy|medium-difficulty|hard) questions with difficulty (\d)(?:\s+and)?(?:\s+format| and format)\s+(\d)/,
                            )!;
                            const format = Number(match[3]);
                            const questions = Array.from(
                                { length: Number(match[1]) },
                                (_, i) => ({
                                    text: `Question ${aiCalls}.${i}`,
                                    exampleAnswer: "A supported answer.",
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
                                                  "Identify the concept correctly.",
                                          }),
                                }),
                            );
                            return {
                                text: JSON.stringify({
                                    questions: controls.emptyResponses
                                        ? []
                                        : questions,
                                    warnings: controls.emptyResponses
                                        ? ["Insufficient source content."]
                                        : [],
                                }),
                                model: "active-model",
                                provider: "openaiOauth",
                                integrationId: "active",
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
                            if (args.folderPath !== "/test/vault")
                                throw new Error("Missing vault path");
                            // Emulate JSON IPC serialization, including omission of undefined fields.
                            const batch = JSON.parse(
                                JSON.stringify(args.batch),
                            ) as QuestionGenerationBatch;
                            batches.push(batch);
                            for (const {
                                fsrsData,
                                ...question
                            } of batch.questions) {
                                const id = `q${note.questions.length}`;
                                note.questions.push({
                                    ...question,
                                    id,
                                    noteId: note.id,
                                    isBasicQuestion: batch.isBasicQuestion,
                                    generatedAt: new Date().toISOString(),
                                    generatedWithModel: batch.model,
                                    generationScope: batch.scope,
                                    lastAnsweredAt: null,
                                    averageScore: 0,
                                    materials: [],
                                });
                                if (fsrsData)
                                    note.questionFsrs.push({
                                        questionId: id,
                                        fsrsData,
                                    });
                            }
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
    }, options);
    await page.goto("/");
}

test("generation service uses the shared AI IPC, persists basic cards, and excludes cards from additional questions", async ({
    page,
}) => {
    await mockGeneration(page);
    const result = await page.evaluate(async () => {
        const servicePath = "/src/lib/services/questions.ts";
        const { generateQuestions } = await import(
            /* @vite-ignore */ servicePath
        );
        const first = await Promise.allSettled([
            generateQuestions(1, "note"),
            generateQuestions(1, "note"),
        ]);
        const basic = first.find((item) => item.status === "fulfilled")!;
        const rejected = first.find((item) => item.status === "rejected")!;
        const additional = await generateQuestions(3, "note", ["sub"], 2, 1);
        return {
            basic: basic.status === "fulfilled" ? basic.value : null,
            concurrentError:
                rejected.status === "rejected" ? String(rejected.reason) : "",
            additional,
            batches: (
                window as unknown as {
                    generationBatches: QuestionGenerationBatch[];
                }
            ).generationBatches,
        };
    });
    expect(result.basic).toMatchObject({
        mode: "basic",
        complete: true,
        generatedCount: 7,
    });
    expect(result.basic.note.questionFsrs).toHaveLength(7);
    const basicQuestions = result.basic.note
        .questions as SyncedNote["questions"];
    expect(
        basicQuestions
            .filter((question) => question.difficulty === 0)
            .every((question) => question.format === 0),
    ).toBe(true);
    for (const format of [0, 1]) {
        expect(
            basicQuestions.filter(
                (question) =>
                    question.difficulty === 1 && question.format === format,
            ),
        ).toHaveLength(1);
    }
    expect(result.concurrentError).toContain("already being generated");
    expect(result.additional).toMatchObject({
        mode: "additional",
        complete: true,
        generatedCount: 3,
    });
    expect(result.additional.note.questions).toHaveLength(10);
    expect(result.additional.note.questionFsrs).toHaveLength(7);
    expect(
        result.batches
            .filter((batch) => !batch.isBasicQuestion)
            .every((batch) =>
                batch.questions.every(
                    (question) => !Object.hasOwn(question, "fsrsData"),
                ),
            ),
    ).toBe(true);
    for (const batch of result.batches.filter(
        (batch) => batch.isBasicQuestion,
    )) {
        for (const question of batch.questions) {
            expect(typeof question.fsrsData!.due).toBe("string");
            expect(Object.hasOwn(question.fsrsData!, "last_review")).toBe(
                false,
            );
        }
    }
});

async function openNote(page: Page, manage = true): Promise<void> {
    await page
        .getByRole("button", { name: /^Sets(?: Topic parsing error)?$/ })
        .click();
    await expect(
        page.getByRole("heading", { name: "Sets", exact: true }),
    ).toBeVisible();
    if (manage)
        await page
            .getByRole("button", { name: "Manage questions", exact: true })
            .click();
}

async function releaseGeneration(page: Page): Promise<void> {
    await page.evaluate(() =>
        (
            window as unknown as { continueGeneration: () => void }
        ).continueGeneration(),
    );
}

test("note question management aligns right, stays within the tab body, and restores focus", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true, configured: true });
    await openNote(page, false);
    const trigger = page.getByRole("button", {
        name: "Manage questions",
        exact: true,
    });
    const title = page.getByRole("heading", { name: "Sets", exact: true });
    const dialog = page.getByRole("dialog", {
        name: "Manage questions",
        exact: true,
    });
    await expect(trigger).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Generate questions", exact: true }),
    ).toHaveCount(0);
    const titleBox = (await title.boundingBox())!;
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
    expect(Math.abs(triggerBox.y - titleBox.y)).toBeLessThan(4);
    const row = (await title.locator("..").boundingBox())!;
    expect(
        Math.abs(triggerBox.x + triggerBox.width - row.x - row.width),
    ).toBeLessThan(1);
    await trigger.click();
    await expect(dialog).toBeVisible();
    for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const viewport of [
            { width: 580, height: 550 },
            { width: 1200, height: 900 },
        ]) {
            await page.setViewportSize(viewport);
            const body = (await page.locator("[data-tab-body]").boundingBox())!;
            const backdrop = (await page
                .locator("[data-question-management-backdrop]")
                .boundingBox())!;
            const popup = (await dialog.boundingBox())!;
            const tabbar = (await page
                .getByRole("tablist", { name: "Workspace tabs" })
                .boundingBox())!;
            const footer = (await page.locator("footer").boundingBox())!;
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
            expect(tabbar.y + tabbar.height).toBeLessThanOrEqual(backdrop.y);
            expect(footer.y).toBeGreaterThanOrEqual(
                backdrop.y + backdrop.height,
            );
        }
    }
    await expect(
        dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("tab", { name: "Sets", exact: true }).click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("note tab shows saved progress, survives closing the tab, and offers additional question settings", async ({
    page,
}) => {
    await mockGeneration(page, {
        showNote: true,
        configured: true,
        pauseAtCall: 2,
    });
    await openNote(page);
    const generate = page.getByRole("button", {
        name: "Generate questions",
        exact: true,
    });
    await expect(generate).toBeEnabled();
    await generate.click();
    const bar = page.getByRole("progressbar", {
        name: "Question generation progress",
    });
    await expect(bar).toHaveAttribute("max", "7");
    await expect(bar).toHaveAttribute("value", "3");
    await expect(
        page.getByText("3 of 7 saved · 43%", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Generating…", exact: true }),
    ).toBeDisabled();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("3");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Close Sets", exact: true }).click();
    await openNote(page);
    await expect(bar).toHaveAttribute("value", "3");
    await releaseGeneration(page);
    await expect(
        page.getByText("Generated 7 basic questions.", { exact: true }),
    ).toBeVisible();
    await expect(bar).toHaveAttribute("value", "7");
    await expect(generate).toBeEnabled();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("7");
    await page.getByLabel("Number of questions", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Difficulty", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(
        page.getByRole("dialog", { name: "Manage questions", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Difficulty", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Difficulty", exact: true }).click();
    await page.getByRole("button", { name: "Hard", exact: true }).click();
    await page
        .getByRole("button", { name: "Question format", exact: true })
        .click();
    await page.getByRole("button", { name: "Free text", exact: true }).click();
    await generate.click();
    await expect(
        page.getByText("Generated 3 additional questions.", { exact: true }),
    ).toBeVisible();
    const additional = await page.evaluate(() =>
        (
            window as unknown as {
                generationBatches: QuestionGenerationBatch[];
            }
        ).generationBatches.filter((batch) => !batch.isBasicQuestion),
    );
    expect(additional.flatMap((batch) => batch.questions)).toHaveLength(3);
    expect(
        additional.every(
            (batch) => batch.difficulty === 2 && batch.format === 1,
        ),
    ).toBe(true);
    expect(
        additional.every((batch) =>
            batch.questions.every((question) => !question.fsrsData),
        ),
    ).toBe(true);
    for (const width of [580, 800, 1200]) {
        await page.setViewportSize({
            width,
            height: width === 580 ? 550 : 800,
        });
        await expect(generate).toBeVisible();
        await expect(bar).toBeVisible();
        const overflow = await page
            .getByRole("dialog", { name: "Manage questions", exact: true })
            .evaluate((panel) => panel.scrollWidth > panel.clientWidth);
        expect(overflow).toBe(false);
        const body = (await page.locator("[data-tab-body]").boundingBox())!;
        const popup = (await page
            .getByRole("dialog", { name: "Manage questions", exact: true })
            .boundingBox())!;
        expect(popup.y).toBeGreaterThanOrEqual(body.y);
        expect(popup.y + popup.height).toBeLessThanOrEqual(
            body.y + body.height,
        );
        expect(
            Math.abs(popup.y + popup.height / 2 - (body.y + body.height / 2)),
        ).toBeLessThan(1);
    }
    await page.screenshot({
        path: `/tmp/obstudy-generation-${test.info().project.name}.png`,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 580, height: 550 });
    await bar.scrollIntoViewIfNeeded();
    await page.screenshot({
        path: `/tmp/obstudy-generation-dark-compact-${test.info().project.name}.png`,
    });
});

test("partial basic generation keeps saved questions visible and resumes the missing set", async ({
    page,
}) => {
    await mockGeneration(page, {
        showNote: true,
        configured: true,
        failAtCall: 2,
    });
    await openNote(page);
    const generate = page.getByRole("button", {
        name: "Generate questions",
        exact: true,
    });
    await generate.click();
    await expect(page.getByRole("alert")).toContainText("Rate limit reached");
    await page.getByText("Technical details", { exact: true }).click();
    await expect(
        page.getByText(/Request ID: req-generation-test/),
    ).toBeVisible();
    await expect(
        page.getByText("3 of 7 saved · 43%", { exact: true }),
    ).toBeVisible();
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(
        page.getByText("Generated 4 basic questions.", { exact: true }),
    ).toBeVisible();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("7");
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("additional generation failure prefills only the remaining count for retry", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true, configured: true });
    await openNote(page);
    const generate = page.getByRole("button", {
        name: "Generate questions",
        exact: true,
    });
    await generate.click();
    await expect(
        page.getByText("Generated 7 basic questions.", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Number of questions", { exact: true }).fill("6");
    await page
        .getByRole("button", { name: "Question format", exact: true })
        .click();
    await page.getByRole("button", { name: "Free text", exact: true }).click();
    await page.evaluate(() => {
        const controls = (
            window as unknown as {
                generationControls: { aiCalls: number; failAtCall: number };
            }
        ).generationControls;
        controls.failAtCall = controls.aiCalls + 2;
    });
    await generate.click();
    await expect(page.getByRole("alert")).toContainText("Rate limit reached");
    await expect(
        page.getByText("4 of 6 saved · 67%", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByLabel("Number of questions", { exact: true }),
    ).toHaveValue("2");
    await generate.click();
    await expect(
        page.getByText("Generated 2 additional questions.", { exact: true }),
    ).toBeVisible();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("13");
});

test("missing AI configuration opens integration settings from the Generate button", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true });
    await openNote(page);
    await expect(
        page.getByRole("button", { name: "Generate questions", exact: true }),
    ).toBeEnabled();
    await expect(
        page.getByText(
            "Select an AI integration and model before generating questions.",
            { exact: true },
        ),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Generate questions", exact: true })
        .click();
    await expect(
        page.getByRole("tab", { name: "AI integrations", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
});

test("insufficient source content reports partial completion and generation notices", async ({
    page,
}) => {
    await mockGeneration(page, {
        showNote: true,
        configured: true,
        emptyResponses: true,
    });
    await openNote(page);
    await page
        .getByRole("button", { name: "Generate questions", exact: true })
        .click();
    await expect(
        page.getByText("Saved 0 of 7 questions. Generate again to continue.", {
            exact: true,
        }),
    ).toBeVisible();
    await page.getByText(/Generation notices \(/).click();
    await expect(
        page.getByText("Insufficient source content.", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("progressbar", { name: "Question generation progress" }),
    ).toHaveAttribute("value", "0");
});

test("a note parsing error disables generation before any AI request", async ({
    page,
}) => {
    await mockGeneration(page, {
        showNote: true,
        configured: true,
        parseError: "Missing topic structure",
    });
    await openNote(page);
    await expect(
        page.getByRole("button", { name: "Generate questions", exact: true }),
    ).toBeDisabled();
    await expect(
        page.getByText(
            "Fix this note's topic structure before generating questions.",
            { exact: true },
        ),
    ).toBeVisible();
    const calls = await page.evaluate(
        () =>
            (window as unknown as { generationControls: { aiCalls: number } })
                .generationControls.aiCalls,
    );
    expect(calls).toBe(0);
});

test("signed-in integration without a model opens its editor and generation works after saving a model", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true, pendingModel: true });
    await openNote(page);
    await page
        .getByRole("button", { name: "Generate questions", exact: true })
        .click();
    await expect(
        page.getByRole("heading", { name: "Edit integration", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Model", exact: true }),
    ).toHaveText("Active model");
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Sets", exact: true }).click();
    await page
        .getByRole("button", { name: "Manage questions", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Generate questions", exact: true })
        .click();
    await expect(
        page.getByText("Generated 7 basic questions.", { exact: true }),
    ).toBeVisible();
});

test("removal and reset require confirmation, update the workspace, and disable on an empty note", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true, configured: true });
    await openNote(page);
    const generate = page.getByRole("button", {
        name: "Generate questions",
        exact: true,
    });
    const remove = page.getByRole("button", {
        name: "Remove questions",
        exact: true,
    });
    const reset = page.getByRole("button", {
        name: "Reset study schedule",
        exact: true,
    });
    await expect(remove).toBeDisabled();
    await expect(reset).toBeDisabled();
    await generate.click();
    await expect(
        page.getByText("Generated 7 basic questions.", { exact: true }),
    ).toBeVisible();
    await expect(remove).toBeEnabled();
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(
        page.getByRole("group", { name: "Confirm schedule reset" }),
    ).toContainText("7 basic questions");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
        await page.evaluate(
            () =>
                (window as unknown as { managementCalls: unknown[] })
                    .managementCalls.length,
        ),
    ).toBe(0);
    await reset.click();
    await page
        .getByRole("button", { name: "Reset schedule", exact: true })
        .click();
    await expect(
        page.getByText(
            "Study schedule reset. Basic questions are ready to study again.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("7");
    await expect(
        page.getByRole("progressbar", { name: "Question generation progress" }),
    ).toHaveCount(0);
    const resetCall = await page.evaluate(
        () =>
            (
                window as unknown as {
                    managementCalls: {
                        action: string;
                        fsrsData: { state: number; reps: number; due: string };
                    }[];
                }
            ).managementCalls[0],
    );
    expect(resetCall.action).toBe("reset");
    expect(resetCall.fsrsData).toMatchObject({ state: 0, reps: 0 });
    expect(typeof resetCall.fsrsData.due).toBe("string");
    await remove.click();
    await expect(
        page.getByRole("group", { name: "Confirm question removal" }),
    ).toContainText("Remove all 7 questions");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await remove.click();
    await page
        .getByRole("button", { name: "Remove all questions", exact: true })
        .click();
    await expect(
        page.getByText(
            "Questions removed. Past answers and results are preserved.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("0");
    await expect(remove).toBeDisabled();
    await expect(reset).toBeDisabled();
    await expect(generate).toBeEnabled();
});

test("maintenance failure preserves the saved question count and releases controls for retry", async ({
    page,
}) => {
    await mockGeneration(page, { showNote: true, configured: true });
    await openNote(page);
    await page
        .getByRole("button", { name: "Generate questions", exact: true })
        .click();
    await expect(
        page.getByText("Generated 7 basic questions.", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
        (
            window as unknown as {
                generationControls: { failManagement: boolean };
            }
        ).generationControls.failManagement = true;
    });
    await page
        .getByRole("button", { name: "Remove questions", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Remove all questions", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText(
        "Simulated storage failure",
    );
    await expect(
        page
            .getByText("Questions", { exact: true })
            .locator("..")
            .locator("dd"),
    ).toHaveText("7");
    await expect(
        page.getByRole("button", { name: "Remove questions", exact: true }),
    ).toBeEnabled();
});
