import { expect, test } from "@playwright/test";

test("startup keeps the underlying error visible in optional details and retries successfully", async ({
    page,
}) => {
    await page.addInitScript(() => {
        let attempts = 0;
        Object.assign(window, {
            __TAURI_INTERNALS__: {
                transformCallback: () => 1,
                invoke: async (command: string) => {
                    if (command === "plugin:store|load") return 1;
                    if (command === "plugin:store|get")
                        return ["/test/vault", true];
                    if (command === "fetch_obsidian_notes") {
                        if (++attempts === 1)
                            throw "Unable to migrate the database: migration 10 was previously applied but has been modified";
                        return { notes: [], warnings: [] };
                    }
                    if (command === "get_ai_configuration")
                        return { integrations: [], activeIntegrationId: null };
                    return null;
                },
            },
        });
    });
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText(
        "Unable to load settings or synchronize notes",
    );
    const reason = page.getByText(
        "Unable to migrate the database: migration 10 was previously applied but has been modified",
        { exact: true },
    );
    await expect(reason).not.toBeVisible();
    await page.getByText("Error details", { exact: true }).click();
    await expect(reason).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
        page.getByRole("region", { name: "Study workspace", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
});
