import { test, expect } from "@playwright/test";

test("desktop unlinks the selected account offline, preserves server accounts, and can link another login", async ({
    page,
    context,
}) => {
    await page.addInitScript(() => {
        const base = "http://127.0.0.1:3999";
        let session: any = {
            userId: "signed-in",
            deviceId: "device",
            email: "current@example.com",
            expiresAt: "2099-01-01T00:00:00Z",
        };
        let link: any = {
            userId: "original-account",
            serverUrl: base,
            revision: 7,
            pendingCount: 2,
        };
        let state: any = null;
        let catalog: any = null;
        const calls: { command: string; args: any }[] = [];
        const callbacks = new Map<number, Function>();
        let callbackId = 0;
        Object.assign(window, {
            isTauri: true,
            __unlinkCalls: calls,
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
            __TAURI_INTERNALS__: {
                metadata: {
                    currentWindow: { label: "main" },
                    currentWebview: { label: "main" },
                },
                transformCallback: (callback: Function) => {
                    callbacks.set(++callbackId, callback);
                    return callbackId;
                },
                invoke: async (command: string, args: any = {}) => {
                    calls.push({ command, args: structuredClone(args) });
                    if (command === "plugin:store|load") return 1;
                    if (command === "plugin:store|get")
                        return ["/test/vault", true];
                    if (command === "fetch_obsidian_notes")
                        return { notes: [], warnings: [] };
                    if (command === "get_ai_configuration")
                        return { integrations: [], activeIntegrationId: null };
                    if (command === "cloud_get_session") return session;
                    if (command === "cloud_desktop_link")
                        return structuredClone(link);
                    if (command === "cloud_forget_session") {
                        if (args.expectedUserId !== session?.userId)
                            throw new Error("Account changed");
                        session = null;
                        return;
                    }
                    if (command === "cloud_desktop_unlink") {
                        if (
                            args.userId !== link?.userId ||
                            args.serverUrl !== link?.serverUrl ||
                            args.expectedRevision !== link?.revision
                        )
                            throw new Error("Wrong folder link");
                        if ((window as any).__unlinkFail)
                            throw new Error("Storage is busy. Try again.");
                        link = null;
                        return;
                    }
                    if (command === "cloud_sign_in") {
                        session = {
                            userId: "new-account",
                            deviceId: "device",
                            email: args.email,
                            expiresAt: "2099-01-01T00:00:00Z",
                        };
                        return session;
                    }
                    if (command === "cloud_desktop_snapshot") {
                        if (link && link.userId !== args.userId)
                            throw new Error(
                                "This folder is linked to another account. Use Unlink folder.",
                            );
                        return {
                            revision: link?.revision ?? 0,
                            state,
                            notes: [],
                            records: [],
                            closedSessions: [],
                        };
                    }
                    if (command === "cloud_desktop_commit") {
                        state = structuredClone(args.state);
                        link = {
                            userId: args.userId,
                            serverUrl: args.serverUrl,
                            revision: (link?.revision ?? 0) + 1,
                            pendingCount: 0,
                        };
                        return link.revision;
                    }
                    if (command === "cloud_request") {
                        if (
                            args.expectedUserId &&
                            args.expectedUserId !== session?.userId
                        )
                            return {
                                status: 409,
                                body: { error: "Account changed" },
                            };
                        if (args.path === "/v1/capabilities")
                            return {
                                status: 200,
                                body: {
                                    features: [
                                        "history-import",
                                        "schedule-reset",
                                    ],
                                },
                            };
                        if (
                            args.path === "/v1/library" &&
                            args.method === "PUT"
                        ) {
                            catalog = {
                                ...args.body.catalog,
                                revision: "new-library",
                            };
                            return { status: 200, body: { catalog } };
                        }
                        if (args.path === "/v1/sync")
                            return {
                                status: 200,
                                body: {
                                    cursor: "0",
                                    acknowledgedIds: [],
                                    events: [],
                                    hasMore: false,
                                    catalog,
                                },
                            };
                    }
                    return null;
                },
            },
        });
    });
    await page.goto("/?api-preview=http%3A%2F%2F127.0.0.1%3A3999");
    await page.getByRole("button", { name: "Open a tab", exact: true }).click();
    await page
        .getByRole("button", { name: "Account and sync", exact: true })
        .click();
    const panel = page.getByRole("region", {
        name: "Notes folder link",
        exact: true,
    });
    await expect(
        panel.getByText("original-account", { exact: true }),
    ).toBeVisible();
    await panel
        .getByRole("button", { name: "Unlink folder", exact: true })
        .click();
    await expect(panel.getByRole("alertdialog")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
        await page.evaluate(
            () =>
                (window as any).__unlinkCalls.filter(
                    (entry: any) => entry.command === "cloud_desktop_unlink",
                ).length,
        ),
    ).toBe(0);
    await page.evaluate(() => ((window as any).__unlinkFail = true));
    await panel
        .getByRole("button", { name: "Unlink folder", exact: true })
        .click();
    await panel
        .getByRole("alertdialog")
        .getByRole("button", { name: "Unlink folder", exact: true })
        .click();
    await expect(panel.getByRole("alert")).toHaveText(
        "Storage is busy. Try again.",
    );
    await expect(
        panel.getByText("original-account", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.evaluate(() => ((window as any).__unlinkFail = false));
    await context.setOffline(true);
    await panel
        .getByRole("button", { name: "Unlink folder", exact: true })
        .click();
    await panel
        .getByRole("alertdialog")
        .getByRole("button", { name: "Unlink folder", exact: true })
        .click();
    await expect(panel.getByText(/Folder unlinked/)).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    const calls = await page.evaluate(() => (window as any).__unlinkCalls);
    const removed = calls.filter(
        (entry: any) => entry.command === "cloud_desktop_unlink",
    );
    expect(removed).toHaveLength(2);
    expect(removed[0].args).toEqual({
        folderPath: "/test/vault",
        userId: "original-account",
        serverUrl: "http://127.0.0.1:3999",
        expectedRevision: 7,
    });
    expect(calls.some((entry: any) => entry.command === "cloud_sign_out")).toBe(
        false,
    );
    await context.setOffline(false);
    await page.getByLabel("Email", { exact: true }).fill("next@example.com");
    await page
        .getByLabel("Password", { exact: true })
        .fill("a-long-test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
        panel.getByText("next@example.com", { exact: true }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Sync now", exact: true }),
    ).toBeEnabled();
});
