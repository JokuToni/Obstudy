import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyCard } from "ts-fsrs";
import type { APIRequestContext } from "@playwright/test";
const password = "a-long-test-password";
async function seed(request: APIRequestContext) {
    const email = `${randomUUID()}@example.com`;
    const registered = await request.post("/v1/auth/register", {
        data: {
            email,
            password,
            deviceId: randomUUID(),
            deviceName: "Desktop test",
        },
    });
    expect(registered.status(), await registered.text()).toBe(201);
    const user = await registered.json();
    const headers = { authorization: `Bearer ${user.token}` };
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
    const library = await request.put("/v1/library", {
        headers,
        data: {
            baseRevision: null,
            catalog: {
                schemaVersion: 1,
                revision: "draft",
                sets: [
                    {
                        id: "note-1",
                        title: "Web study note",
                        isStudying: true,
                        topics: [
                            { id: "topic-1", noteId: "note-1", title: "Topic" },
                        ],
                        questions: [question],
                        cards: [
                            {
                                questionId: question.id,
                                fsrsData: createEmptyCard(
                                    new Date("2026-01-01T00:00:00Z"),
                                ),
                            },
                        ],
                    },
                ],
            },
        },
    });
    expect(library.status(), await library.text()).toBe(200);
    return { email, headers };
}

test("phone web login survives reload, works offline, then synchronizes the queued grade", async ({
    page,
    context,
    request,
}) => {
    const user = await seed(request);
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
        "href",
        "/manifest.webmanifest",
    );
    await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
        page.getByRole("button", { name: /Web study note/ }),
    ).toBeVisible();
    await expect(
        page.getByText("Ready for offline practice.", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: 320, height: 568 });
        await page.emulateMedia({ colorScheme });
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
        ).toBe(true);
        await expect(
            page.getByText("Ready for offline practice.", { exact: true }),
        ).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath("web-home.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(
        page.getByRole("button", { name: /Web study note/ }),
    ).toBeVisible();
    expect(
        (await context.cookies()).some(
            (cookie) => cookie.name === "obstudy_session" && cookie.httpOnly,
        ),
    ).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain(
        "obstudy_session",
    );
    await context.setOffline(true);
    await page.reload();
    await expect(
        page.getByRole("button", { name: /Web study note/ }),
    ).toBeVisible();
    await page.getByText(user.email, { exact: true }).first().click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
        page.getByText(
            "Connect to the internet to sign out. Your account is still signed in.",
            { exact: true },
        ),
    ).toBeVisible();
    await page.getByText(user.email, { exact: true }).first().click();
    await page.getByRole("button", { name: /Web study note/ }).click();
    await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
    await page.getByRole("radio", { name: "A", exact: true }).click();
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect(
        page.getByText("Example answer", { exact: true }).first(),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    await expect(
        page.getByRole("button", { name: /Web study note/ }),
    ).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect
        .poll(
            async () => {
                const response = await request.get("/v1/answers", {
                    headers: user.headers,
                });
                return (await response.json()).answers.length;
            },
            { timeout: 20000 },
        )
        .toBe(1);
    const answer = (
        await (
            await request.get("/v1/answers", { headers: user.headers })
        ).json()
    ).answers[0];
    expect(answer.answer.points).toBe(1);
    const catalog = (
        await (
            await request.get("/v1/library", { headers: user.headers })
        ).json()
    ).catalog;
    expect(catalog.sets[0].cards[0].fsrsData.reps).toBe(1);
    const cached = await page.evaluate(async () => {
        const keys = await caches.keys();
        return (
            await Promise.all(
                keys.map(async (key) =>
                    (await (await caches.open(key)).keys()).map(
                        (request) => request.url,
                    ),
                ),
            )
        ).flat();
    });
    expect(cached.length).toBeGreaterThan(10);
    expect(cached.some((url) => new URL(url).pathname.startsWith("/v1/"))).toBe(
        false,
    );
    const stored = await page.evaluate(() => Object.values(localStorage));
    expect(stored.some((value) => value.includes('"token"'))).toBe(false);
    await page.getByText(user.email, { exact: true }).first().click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.reload();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(
        page.getByRole("button", { name: /Web study note/ }),
    ).toHaveCount(0);
});

test("updates wait during a question and require closing other tabs before activation", async ({
    page,
    context,
    request,
}) => {
    const user = await seed(request);
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
        page.getByText("Ready for offline practice.", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: /Web study note/ }).click();
    await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
    const workerPath = resolve("build-web/service-worker.js");
    const original = await readFile(workerPath, "utf8");
    const newName = `obstudy-web-test-${randomUUID()}`;
    try {
        await writeFile(
            workerPath,
            original.replace(/obstudy-web-[a-f0-9]+/, newName),
        );
        await page.evaluate(async () => {
            await (await navigator.serviceWorker.getRegistration())?.update();
        });
        await expect
            .poll(() =>
                page.evaluate(
                    async () =>
                        !!(await navigator.serviceWorker.getRegistration())
                            ?.waiting,
                ),
            )
            .toBe(true);
        await expect(
            page.getByRole("button", { name: "Reveal answer", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Update app", exact: true }),
        ).toHaveCount(0);
        await page
            .getByRole("button", { name: "Save and exit", exact: true })
            .click();
        await expect(
            page.getByRole("button", { name: "Update app", exact: true }),
        ).toBeVisible();
        const other = await context.newPage();
        await other.goto("/");
        await expect(
            other.getByRole("button", { name: /Web study note/ }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "Update app", exact: true })
            .click();
        await expect(
            page.getByText("Close other Obstudy tabs before updating.", {
                exact: true,
            }),
        ).toBeVisible();
        await other.close();
        await Promise.all([
            page.waitForEvent("load"),
            page
                .getByRole("button", { name: "Update app", exact: true })
                .click(),
        ]);
        await expect
            .poll(() => page.evaluate(() => caches.keys()))
            .toEqual([newName]);
        await expect(
            page.getByRole("button", { name: /Web study note/ }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Update app", exact: true }),
        ).toHaveCount(0);
    } finally {
        await writeFile(workerPath, original);
    }
});
