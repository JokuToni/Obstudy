import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyCard } from "ts-fsrs";
import { buildApp } from "../../restapi/src/app";
import { loadConfig } from "../../restapi/src/config";
import { createDatabase, migrate } from "../../restapi/src/database";

const temporary = mkdtempSync(join(tmpdir(), "obstudy-app-cloud-"));
const config = loadConfig({
    DATABASE_PATH: join(temporary, "api.db"),
    REGISTRATION_ENABLED: "true",
    LOG_LEVEL: "silent",
    CORS_ORIGINS: "http://127.0.0.1:1420",
});
const database = createDatabase(config);
const api = buildApp(config, database);
let apiUrl: string;
const password = "a-long-test-password";
test.beforeAll(async () => {
    await migrate(database);
    apiUrl = await api.listen({ port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
    await api.close();
    rmSync(temporary, { recursive: true, force: true });
});
function fixture() {
    const question = {
        id: "question-1",
        noteId: "note-1",
        isBasicQuestion: true,
        generatedAt: null,
        generatedWithModel: null,
        generationScope: null,
        text: "Which choice is correct?",
        exampleAnswer: "Choice A.",
        lastAnsweredAt: null,
        averageScore: 0,
        topicIds: ["topic-1"],
        difficulty: 0,
        materials: [],
        format: 0,
        choices: ["A", "B"],
        correctChoiceIndex: 0,
    };
    const card = {
        questionId: question.id,
        fsrsData: JSON.parse(
            JSON.stringify(
                createEmptyCard(new Date("2026-01-01T00:00:00.000Z")),
            ),
        ),
    };
    const set = {
        id: "note-1",
        title: "Cloud note",
        isStudying: true,
        topics: [{ id: "topic-1", noteId: "note-1", title: "Topic" }],
        questions: [question],
        cards: [card],
    };
    return {
        question,
        card,
        set,
        catalog: { schemaVersion: 1, revision: "draft", sets: [set] },
    };
}
async function account() {
    const email = `${randomUUID()}@example.com`;
    const deviceId = randomUUID();
    const response = await api.inject({
        method: "POST",
        url: "/v1/auth/register",
        remoteAddress: `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
        payload: { email, password, deviceId, deviceName: "Desktop test" },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { ...response.json(), email };
}

test("iOS signs in, downloads questions, saves an answer to the API, and isolates the next account", async ({
    page,
}) => {
    const user = await account();
    const f = fixture();
    const published = await api.inject({
        method: "PUT",
        url: "/v1/library",
        headers: { authorization: `Bearer ${user.token}` },
        payload: { baseRevision: null, catalog: f.catalog },
    });
    expect(published.statusCode, published.body).toBe(200);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
        `/?mobile-preview&api-preview=${encodeURIComponent(apiUrl)}`,
    );
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
        page.getByRole("button", { name: /Cloud note/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Cloud note/ }).click();
    await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
    await page.getByRole("radio", { name: "A", exact: true }).click();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect
        .poll(
            async () =>
                (
                    await api.inject({
                        url: "/v1/answers",
                        headers: { authorization: `Bearer ${user.token}` },
                    })
                ).json().answers.length,
        )
        .toBe(1);
    const history = (
        await api.inject({
            url: "/v1/answers",
            headers: { authorization: `Bearer ${user.token}` },
        })
    ).json();
    expect(history.answers[0].answer.points).toBe(1);
    const updated = (
        await api.inject({
            url: "/v1/library",
            headers: { authorization: `Bearer ${user.token}` },
        })
    ).json().catalog;
    expect(updated.sets[0].cards[0].fsrsData.reps).toBe(1);
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await page.getByText(user.email, { exact: true }).first().click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const other = await account();
    await page.getByLabel("Email", { exact: true }).fill(other.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: /Cloud note/ })).toHaveCount(
        0,
    );
});

test("desktop publishes and imports existing history; phone answers flow back into desktop cache", async ({
    page,
}) => {
    const user = await account();
    const f = fixture();
    const local = {
        ...f.set,
        isAvailable: true,
        parseError: null,
        parseWarnings: [],
        syncIssues: [],
        file: { path: "/test/vault/Cloud note.md", text: "Note" },
        savedPracticeSettings: null,
        answers: [],
        exercises: [],
        performances: [],
        questionFsrs: f.set.cards,
        fsrsReviewedAnswerIds: [],
    };
    const initialRecords = [
        {
            noteId: f.set.id,
            question: f.question,
            answer: {
                id: randomUUID(),
                exerciseId: randomUUID(),
                questionId: f.question.id,
                mode: "practice",
                answeredAt: "2025-12-01T12:00:00.000Z",
                text: "B",
                points: 0,
                feedback: "",
            },
        },
    ];
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(
        ({ user, local, apiUrl, initialRecords }) => {
            const callbacks = new Map<number, Function>();
            let callbackId = 0;
            let apiToken = user.token;
            let savedSession: any = null;
            const data = {
                revision: 0,
                state: null as any,
                notes: [local],
                records: [...initialRecords] as any[],
                offlineWrites: false,
                commits: [] as any[],
            };
            Object.assign(window, {
                isTauri: true,
                __TAURI_EVENT_PLUGIN_INTERNALS__: {
                    unregisterListener: () => {},
                },
                __cloudTest: data,
                __TAURI_INTERNALS__: {
                    metadata: {
                        currentWindow: { label: "main" },
                        currentWebview: { label: "main" },
                    },
                    transformCallback: (fn: Function) => {
                        callbacks.set(++callbackId, fn);
                        return callbackId;
                    },
                    invoke: async (command: string, args: any = {}) => {
                        if (command === "plugin:store|load") return 1;
                        if (command === "plugin:store|get")
                            return ["/test/vault", true];
                        if (command === "fetch_obsidian_notes")
                            return { notes: [local], warnings: [] };
                        if (command === "get_ai_configuration")
                            return {
                                integrations: [],
                                activeIntegrationId: null,
                            };
                        if (command === "cloud_sign_in") {
                            const response = await fetch(
                                `${apiUrl}/v1/auth/login`,
                                {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                        email: args.email,
                                        password: args.password,
                                        deviceId: user.deviceId,
                                        deviceName: "Desktop test",
                                    }),
                                },
                            );
                            const account = await response.json();
                            if (!response.ok) throw new Error(account.error);
                            apiToken = account.token;
                            savedSession = {
                                userId: account.userId,
                                deviceId: account.deviceId,
                                email: args.email,
                                expiresAt: account.expiresAt,
                            };
                            return savedSession;
                        }
                        if (command === "cloud_get_session")
                            return savedSession;
                        if (command === "get_question_generation_note")
                            return {
                                ...data.notes[0],
                                answers: data.records.map(
                                    (record: any) => record.answer,
                                ),
                                questionFsrs:
                                    data.state?.catalog?.sets[0]?.cards ??
                                    data.notes[0].questionFsrs,
                            };
                        if (command === "cloud_desktop_snapshot")
                            return structuredClone(data);
                        if (command === "cloud_desktop_commit") {
                            if (args.expectedRevision !== data.revision)
                                throw new Error("Stale cache write");
                            data.state = structuredClone(args.state);
                            data.revision++;
                            data.records.push(
                                ...args.records.filter(
                                    (record: any) =>
                                        !data.records.some(
                                            (old: any) =>
                                                old.answer.id ===
                                                record.answer.id,
                                        ),
                                ),
                            );
                            data.commits.push(args);
                            return data.revision;
                        }
                        if (command === "cloud_request") {
                            if (data.offlineWrites && args.body?.events?.length)
                                return {
                                    status: 503,
                                    body: {
                                        error: "Simulated offline transfer",
                                    },
                                };
                            const response = await fetch(
                                `${apiUrl}${args.path}`,
                                {
                                    method: args.method,
                                    headers: {
                                        Authorization: `Bearer ${apiToken}`,
                                        "Content-Type": "application/json",
                                    },
                                    ...(args.body == null
                                        ? {}
                                        : { body: JSON.stringify(args.body) }),
                                },
                            );
                            return {
                                status: response.status,
                                body:
                                    response.status === 204
                                        ? null
                                        : await response.json(),
                            };
                        }
                        return null;
                    },
                },
            });
        },
        { user, local, apiUrl, initialRecords },
    );
    await page.goto(`/?api-preview=${encodeURIComponent(apiUrl)}`);
    await expect(
        page.getByRole("region", { name: "Study workspace", exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("tab", { name: "Account and sync", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Open a tab", exact: true }).click();
    await page
        .getByRole("button", { name: "Account and sync", exact: true })
        .click();
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Sync now", exact: true }),
    ).toBeEnabled();
    await expect
        .poll(
            async () =>
                (
                    await api.inject({
                        url: "/v1/library",
                        headers: { authorization: `Bearer ${user.token}` },
                    })
                ).statusCode,
        )
        .toBe(200);
    await page.screenshot({
        path: `/tmp/obstudy-cloud-account-${test.info().project.name}.png`,
    });
    await page
        .getByRole("button", { name: "Close Account and sync", exact: true })
        .click();
    const library = (
        await api.inject({
            url: "/v1/library",
            headers: { authorization: `Bearer ${user.token}` },
        })
    ).json().catalog;
    expect(library.sets[0].title).toBe("Cloud note");
    expect(
        (
            await api.inject({
                url: "/v1/answers",
                headers: { authorization: `Bearer ${user.token}` },
            })
        ).json().answers,
    ).toHaveLength(1);
    const localAnswer = {
        id: randomUUID(),
        exerciseId: randomUUID(),
        questionId: f.question.id,
        mode: "study",
        answeredAt: new Date().toISOString(),
        text: "A",
        points: 1,
        feedback: "",
    };
    await page.evaluate(
        ({ question, answer }) => {
            const data = (window as any).__cloudTest;
            data.records.push({ noteId: question.noteId, question, answer });
            data.offlineWrites = true;
        },
        { question: f.question, answer: localAnswer },
    );
    const failed = await page.evaluate(async (user) => {
        const modulePath = "/src/lib/cloud/desktop.ts";
        const { synchronizeDesktop } = await import(
            /* @vite-ignore */ modulePath
        );
        try {
            await synchronizeDesktop("/test/vault", user);
            return "unexpected success";
        } catch (error) {
            return String(error);
        }
    }, user);
    expect(failed).toContain("Simulated offline transfer");
    const queued = await page.evaluate(() =>
        (window as any).__cloudTest.state.outbox.map((event: any) => event.id),
    );
    expect(queued).toHaveLength(1);
    await page.evaluate(() => {
        (window as any).__cloudTest.offlineWrites = false;
    });
    await page.evaluate(async (user) => {
        const modulePath = "/src/lib/cloud/desktop.ts";
        const { synchronizeDesktop } = await import(
            /* @vite-ignore */ modulePath
        );
        await synchronizeDesktop("/test/vault", user);
    }, user);
    expect(
        (
            await api.inject({
                url: "/v1/answers",
                headers: { authorization: `Bearer ${user.token}` },
            })
        ).json().answers,
    ).toHaveLength(2);
    expect(
        await page.evaluate(() => (window as any).__cloudTest.state.outbox),
    ).toEqual([]);
    const login = await api.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
            email: user.email,
            password,
            deviceId: "phone-device",
            deviceName: "Phone",
        },
    });
    expect(login.statusCode).toBe(200);
    const answer = {
        id: randomUUID(),
        exerciseId: randomUUID(),
        questionId: f.question.id,
        mode: "study",
        answeredAt: new Date().toISOString(),
        text: "A",
        points: 1,
        feedback: "",
    };
    const event = {
        id: randomUUID(),
        deviceId: "phone-device",
        occurredAt: answer.answeredAt,
        catalogRevision: library.revision,
        kind: "answer.graded",
        payload: {
            noteId: f.set.id,
            question: library.sets[0].questions[0],
            answer,
        },
    };
    const response = await api.inject({
        method: "POST",
        url: "/v1/sync",
        headers: { authorization: `Bearer ${login.json().token}` },
        payload: {
            schemaVersion: 1,
            deviceId: "phone-device",
            cursor: null,
            events: [event],
        },
    });
    expect(response.statusCode, response.body).toBe(200);
    await page.evaluate(async (user) => {
        const modulePath = "/src/lib/cloud/desktop.ts";
        const { synchronizeDesktop } = await import(
            /* @vite-ignore */ modulePath
        );
        await synchronizeDesktop("/test/vault", user);
    }, user);
    const record = await page.evaluate(
        (id) =>
            (window as any).__cloudTest.records.find(
                (record: any) => record.answer.id === id,
            ),
        answer.id,
    );
    expect(record.answer.id).toBe(answer.id);
    await page.evaluate(() =>
        window.dispatchEvent(new Event("obstudy-cloud-changed")),
    );
    await expect(
        page.getByRole("tab", { name: "Account and sync", exact: true }),
    ).toHaveCount(0);
    const state = await page.evaluate(() => (window as any).__cloudTest.state);
    expect(state.knownAnswerIds).toContain(answer.id);
    expect(state.catalog.sets[0].cards[0].fsrsData.reps).toBe(2);
    const offlineAnswer = {
        ...localAnswer,
        id: randomUUID(),
        exerciseId: randomUUID(),
        questionId: "offline-question",
        answeredAt: new Date().toISOString(),
    };
    const retiredAnswer = {
        ...localAnswer,
        id: randomUUID(),
        exerciseId: randomUUID(),
        questionId: "retired-question",
        answeredAt: new Date().toISOString(),
    };
    await page.evaluate(
        ({ question, card, offlineAnswer, retiredAnswer, closedId }) => {
            const data = (window as any).__cloudTest;
            const offline = { ...question, id: offlineAnswer.questionId };
            data.notes[0].questions.push(offline);
            data.notes[0].questionFsrs.push({
                questionId: offline.id,
                fsrsData: {
                    ...card.fsrsData,
                    reps: 1,
                    state: 1,
                    stability: 1,
                    difficulty: 5,
                    last_review: offlineAnswer.answeredAt,
                },
            });
            data.records.push({
                noteId: question.noteId,
                question: offline,
                answer: offlineAnswer,
            });
            data.records.push({
                noteId: question.noteId,
                question: { ...question, id: retiredAnswer.questionId },
                answer: retiredAnswer,
            });
            data.closedSessions = [
                {
                    exerciseId: closedId,
                    noteId: question.noteId,
                    closedAt: new Date().toISOString(),
                    answerIds: [
                        data.records.find(
                            (record: any) =>
                                record.answer.exerciseId === closedId,
                        ).answer.id,
                    ],
                },
            ];
        },
        {
            question: f.question,
            card: f.card,
            offlineAnswer,
            retiredAnswer,
            closedId: localAnswer.exerciseId,
        },
    );
    await page.evaluate(async (user) => {
        const modulePath = "/src/lib/cloud/desktop.ts";
        const { synchronizeDesktop } = await import(
            /* @vite-ignore */ modulePath
        );
        await synchronizeDesktop("/test/vault", user);
    }, user);
    const finalHistory = (
        await api.inject({
            url: "/v1/answers",
            headers: { authorization: `Bearer ${user.token}` },
        })
    ).json().answers;
    expect(finalHistory).toHaveLength(5);
    expect(
        finalHistory.some(
            (record: any) => record.answer.id === retiredAnswer.id,
        ),
    ).toBe(true);
    const finalCatalog = (
        await api.inject({
            url: "/v1/library",
            headers: { authorization: `Bearer ${user.token}` },
        })
    ).json().catalog;
    expect(
        finalCatalog.sets[0].cards.find(
            (card: any) => card.questionId === offlineAnswer.questionId,
        ).fsrsData.reps,
    ).toBe(1);
    expect(
        finalCatalog.sets[0].questions.some(
            (question: any) => question.id === retiredAnswer.questionId,
        ),
    ).toBe(false);
    expect(
        (
            await database.query(
                "SELECT closed_at FROM exercises WHERE user_id=$1 AND id=$2",
                [user.userId, localAnswer.exerciseId],
            )
        ).rows[0]!.closed_at,
    ).toBeTruthy();
});
