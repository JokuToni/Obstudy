import { expect, test } from "@playwright/test";
import type { AiConfiguration, AiIntegration } from "../../src/lib/types/ai";

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const configuration: AiConfiguration = JSON.parse(
            sessionStorage.getItem("test-ai-configuration") ??
                '{"integrations":[],"activeIntegrationId":null}',
        );
        const persistConfiguration = () =>
            sessionStorage.setItem(
                "test-ai-configuration",
                JSON.stringify(configuration),
            );
        let account: {
            email: string;
            connected: boolean;
            planEnabled: boolean;
        } | null = null;
        const calls: { command: string; args: Record<string, unknown> }[] = [];
        Object.assign(window, {
            testAiCalls: calls,
            __TAURI_INTERNALS__: {
                invoke: async (
                    command: string,
                    args: Record<string, unknown> = {},
                ) => {
                    calls.push({ command, args });
                    switch (command) {
                        case "plugin:store|load":
                            return 1;
                        case "plugin:store|get":
                            return ["/test/vault", true];
                        case "fetch_obsidian_notes":
                            return { notes: [], warnings: [] };
                        case "get_ai_configuration":
                            return structuredClone(configuration);
                        case "get_last_ai_response":
                            return null;
                        case "get_openai_oauth_account":
                            return (
                                account ??
                                JSON.parse(
                                    sessionStorage.getItem(
                                        "test-oauth-account",
                                    ) ?? "null",
                                )
                            );
                        case "connect_openai_oauth":
                            account = {
                                email: "test@example.com",
                                connected: true,
                                planEnabled: true,
                            };
                            sessionStorage.setItem(
                                "test-oauth-account",
                                JSON.stringify(account),
                            );
                            return account;
                        case "list_openai_oauth_models":
                            return [
                                {
                                    id: "plan-model",
                                    name: "Plan model",
                                    effortLevels: ["low", "medium", "high"],
                                },
                            ];
                        case "list_ai_models":
                        case "discover_ai_models":
                            return [
                                {
                                    id: "api-model",
                                    name: "API model",
                                    effortLevels: ["low", "medium", "high"],
                                },
                                {
                                    id: "plain-model",
                                    name: "Plain model",
                                    effortLevels: [],
                                },
                            ];
                        case "save_ai_integration": {
                            const integration =
                                args.integration as AiIntegration;
                            configuration.integrations =
                                configuration.integrations.filter(
                                    (item) => item.id !== integration.id,
                                );
                            configuration.integrations.push(integration);
                            configuration.activeIntegrationId ??=
                                integration.id;
                            persistConfiguration();
                            return;
                        }
                        case "select_ai_integration":
                            configuration.activeIntegrationId =
                                args.integrationId as string;
                            persistConfiguration();
                            return;
                        default:
                            throw new Error(
                                `Unexpected test command: ${command}`,
                            );
                    }
                },
            },
        });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Open a tab", exact: true }).click();
    await page
        .getByRole("button", { name: "AI integrations", exact: true })
        .click();
});

test("pointer selection switches between OAuth and API-key forms", async ({
    page,
}) => {
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await page
        .getByRole("button", { name: "OpenAI · ChatGPT plan", exact: true })
        .click();
    await expect(
        page.getByRole("button", {
            name: "Continue with ChatGPT",
            exact: true,
        }),
    ).toBeVisible();
    await expect(page.locator("#ai-key")).toHaveCount(0);
    await page
        .getByRole("button", { name: "OpenAI · ChatGPT plan", exact: true })
        .click();
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await expect(page.locator("#ai-key")).toBeVisible();
    await expect(
        page.getByRole("button", {
            name: "Continue with ChatGPT",
            exact: true,
        }),
    ).toHaveCount(0);
});

test("OAuth selection starts native login and saves the selected model", async ({
    page,
}) => {
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await page
        .getByRole("button", { name: "OpenAI · ChatGPT plan", exact: true })
        .click();
    const signIn = page.getByRole("button", {
        name: "Continue with ChatGPT",
        exact: true,
    });
    await expect(signIn).toBeEnabled();
    await signIn.click();
    await expect(
        page.getByText("ChatGPT plan usage is enabled.", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Model", exact: true }),
    ).toHaveText("Plan model");
    await expect(
        page.locator("footer").getByRole("button", {
            name: "OpenAI · ChatGPT plan",
            exact: true,
        }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Effort", exact: true }).click();
    await page.getByRole("button", { name: "high", exact: true }).click();
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    await expect(
        page.locator("footer").getByRole("button", {
            name: "OpenAI · ChatGPT plan",
            exact: true,
        }),
    ).toBeVisible();
    const calls = await page.evaluate(
        () =>
            (
                window as unknown as {
                    testAiCalls: {
                        command: string;
                        args: Record<string, unknown>;
                    }[];
                }
            ).testAiCalls,
    );
    expect(calls.some((call) => call.command === "connect_openai_oauth")).toBe(
        true,
    );
    const saved = calls
        .filter((call) => call.command === "save_ai_integration")
        .at(-1)!.args;
    expect(saved.integration).toMatchObject({
        provider: "openaiOauth",
        model: "plan-model",
        reasoningEffort: "high",
    });
    expect(saved.apiKey).toBeUndefined();
});

test("API-key form discovers models and saves credentials through IPC", async ({
    page,
}) => {
    await page.locator("#ai-key").fill("fake-test-key");
    await page
        .getByRole("button", { name: "Load available models", exact: true })
        .click();
    await expect(
        page.getByText("2 models loaded.", { exact: false }),
    ).toBeVisible();
    await expect(
        page.getByRole("textbox", { name: "Model", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("button", { name: "API model", exact: true }).click();
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    await expect(page.locator("#ai-key")).toHaveValue("");
    await expect(
        page
            .locator("footer")
            .getByRole("button", { name: "OpenAI", exact: true }),
    ).toBeVisible();
    const calls = await page.evaluate(
        () =>
            (
                window as unknown as {
                    testAiCalls: {
                        command: string;
                        args: Record<string, unknown>;
                    }[];
                }
            ).testAiCalls,
    );
    expect(
        calls.find((call) => call.command === "save_ai_integration")!.args,
    ).toMatchObject({
        apiKey: "fake-test-key",
        integration: { provider: "openai", model: "api-model" },
    });
});

test("dropdown still closes on Escape, outside clicks and keyboard focus leaving", async ({
    page,
}) => {
    const trigger = page.getByRole("button", { name: "OpenAI", exact: true });
    const menu = page.locator("#integration-provider-options");
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page
        .getByRole("heading", { name: "AI integrations", exact: true })
        .click();
    await expect(menu).toHaveCount(0);
    await trigger.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(
        page.getByRole("button", { name: "Anthropic", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Anthropic", exact: true }).click();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
});

test("effort is saved, restored, and cleared when switching to an untunable model", async ({
    page,
}) => {
    await page.locator("#ai-key").fill("fake-test-key");
    await page
        .getByRole("button", { name: "Load available models", exact: true })
        .click();
    await page.getByRole("button", { name: "Effort", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "max", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "high", exact: true }).click();
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Effort", exact: true }),
    ).toHaveText("high");
    await expect(
        page.getByRole("button", { name: "Model", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page
        .getByRole("button", { name: "Plain model", exact: true })
        .click();
    await expect(
        page.getByRole("button", { name: "Effort", exact: true }),
    ).toHaveCount(0);
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    const calls = await page.evaluate(
        () =>
            (
                window as unknown as {
                    testAiCalls: {
                        command: string;
                        args: Record<string, unknown>;
                    }[];
                }
            ).testAiCalls,
    );
    const saves = calls.filter(
        (call) => call.command === "save_ai_integration",
    );
    expect(saves[0].args.integration).toMatchObject({
        model: "api-model",
        reasoningEffort: "high",
    });
    expect(saves[1].args.integration).toMatchObject({
        model: "plain-model",
        reasoningEffort: null,
    });
});

test("a signed-in OAuth account is registered and selected without another login", async ({
    page,
}) => {
    await page.locator("#ai-key").fill("fake-test-key");
    await page
        .getByRole("button", { name: "Load available models", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page
            .locator("footer")
            .getByRole("button", { name: "OpenAI", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
        sessionStorage.setItem(
            "test-oauth-account",
            JSON.stringify({
                email: "test@example.com",
                connected: true,
                planEnabled: true,
            }),
        ),
    );
    await page.getByRole("button", { name: "Add new", exact: true }).click();
    await page.getByRole("button", { name: "Anthropic", exact: true }).click();
    await page
        .getByRole("button", { name: "OpenAI · ChatGPT plan", exact: true })
        .click();
    await expect(
        page.locator("footer").getByRole("button", {
            name: "OpenAI · ChatGPT plan",
            exact: true,
        }),
    ).toBeVisible();
    const calls = await page.evaluate(
        () =>
            (
                window as unknown as {
                    testAiCalls: {
                        command: string;
                        args: Record<string, unknown>;
                    }[];
                }
            ).testAiCalls,
    );
    expect(calls.some((call) => call.command === "connect_openai_oauth")).toBe(
        false,
    );
    expect(
        calls.some(
            (call) =>
                call.command === "select_ai_integration" &&
                call.args.integrationId === "openaiOauth",
        ),
    ).toBe(true);
});

test("bottom controls share a height and align left while Start stays right", async ({
    page,
}) => {
    const footer = page.locator("footer");
    const mode = footer
        .getByRole("group", { name: "Session mode", exact: true })
        .locator(":scope > div");
    const ai = footer.getByRole("button", { name: "Select AI", exact: true });
    const start = footer.getByRole("button", { name: "Start", exact: true });
    for (const size of [
        { width: 580, height: 550 },
        { width: 800, height: 600 },
        { width: 1200, height: 800 },
    ]) {
        await page.setViewportSize(size);
        await page.evaluate(
            () =>
                new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        );
        const modeBox = (await mode.boundingBox())!;
        const aiBox = (await ai.boundingBox())!;
        const startBox = (await start.boundingBox())!;
        const footerBox = (await footer.boundingBox())!;
        expect(aiBox.height).toBeCloseTo(modeBox.height, 1);
        expect(aiBox.y).toBeCloseTo(modeBox.y, 1);
        expect(aiBox.x - modeBox.x - modeBox.width).toBeCloseTo(12, 1);
        expect(
            footerBox.x + footerBox.width - startBox.x - startBox.width,
        ).toBeCloseTo(12, 1);
        expect(startBox.x).toBeGreaterThanOrEqual(aiBox.x + aiBox.width);
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
            ),
        ).toBe(true);
    }
});

test("app reload restores the selected OAuth integration without opening login", async ({
    page,
}) => {
    await page.getByRole("button", { name: "OpenAI", exact: true }).click();
    await page
        .getByRole("button", { name: "OpenAI · ChatGPT plan", exact: true })
        .click();
    await page
        .getByRole("button", { name: "Continue with ChatGPT", exact: true })
        .click();
    await expect(
        page
            .locator("footer")
            .getByRole("button", {
                name: "OpenAI · ChatGPT plan",
                exact: true,
            }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Effort", exact: true }).click();
    await page.getByRole("button", { name: "high", exact: true }).click();
    await page
        .getByRole("button", { name: "Save integration", exact: true })
        .click();
    await expect(
        page.getByText("Integration saved.", { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(
        page
            .locator("footer")
            .getByRole("button", {
                name: "OpenAI · ChatGPT plan",
                exact: true,
            }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open a tab", exact: true }).click();
    await page
        .getByRole("button", { name: "AI integrations", exact: true })
        .click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
        page.getByText("ChatGPT plan usage is enabled.", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Effort", exact: true }),
    ).toHaveText("high");
    const calls = await page.evaluate(
        () =>
            (window as unknown as { testAiCalls: { command: string }[] })
                .testAiCalls,
    );
    expect(calls.some((call) => call.command === "connect_openai_oauth")).toBe(
        false,
    );
});
