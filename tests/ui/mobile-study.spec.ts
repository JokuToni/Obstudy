import { expect, test, type Page } from "@playwright/test";
import type { MobileState } from "../../src/lib/mobile/types";

test.use({ timezoneId: "Europe/Helsinki" });
async function stored(page: Page): Promise<MobileState> {
    return page.evaluate(async () => {
        const path = "/src/lib/mobile/repository.ts";
        const { BrowserMobileRepository } = await import(
            /* @vite-ignore */ path
        );
        return (await new BrowserMobileRepository().load()).state;
    });
}
async function nextQuestion(page: Page) {
    await page
        .getByRole("button", { name: "Next question", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Current question", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
}
async function openSample(page: Page, mode: "Study" | "Practice" = "Study") {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?mobile-preview");
    await page
        .getByRole("button", { name: "Try sample questions", exact: true })
        .click();
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
    await page.getByLabel("Number of questions", { exact: true }).fill("3");
    await page
        .getByRole("dialog", { name: "Quick tweak", exact: true })
        .getByRole("button", { name: "Start session", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Current question", exact: true }),
    ).toBeVisible();
}

test("phone shell is limited, saves draft answers across reloads, self grades, and schedules Study cards", async ({
    page,
}) => {
    await openSample(page);
    await expect(
        page.getByRole("button", { name: "Manage questions", exact: true }),
    ).toHaveCount(0);
    await expect(
        page.getByRole("button", { name: "Grade with AI", exact: true }),
    ).toHaveCount(0);
    await expect(
        page.getByRole("tab", { name: "Draw", exact: true }),
    ).toHaveCount(0);
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("The endpoint is excluded.");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect
        .poll(
            async () => (await stored(page)).sessions[0].draftAnswers[0]?.text,
        )
        .toBe("The endpoint is excluded.");
    await page.reload();
    await page.getByRole("button", { name: /Resume/ }).click();
    await expect(answer).toHaveValue("The endpoint is excluded.");
    await page
        .getByRole("button", { name: "Reveal answer", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Example answer", exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Partly correct", exact: true })
        .click();
    await expect(page.getByRole("radio").first()).toBeVisible();
    await expect
        .poll(async () => (await stored(page)).answers[0]?.points)
        .toBe(0.5);
    await page.getByRole("radio").first().check();

    await expect(
        page.getByText("Graded · 1 / 1", { exact: true }),
    ).toBeVisible();
    await nextQuestion(page);
    await page.getByRole("radio").nth(2).check();

    await page
        .getByRole("button", { name: "Review answers", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Session results", exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Finish session", exact: true })
        .click();
    await expect(
        page.getByRole("heading", { name: "Study sets", exact: true }),
    ).toBeVisible();
    const saved = await stored(page);
    expect(saved.answers.map((answer) => answer.points)).toEqual([0.5, 1, 0]);
    expect(saved.reviewedAnswerIds).toHaveLength(3);
    expect(saved.outbox).toHaveLength(0);
    expect(saved.sessions[0].closedAt).not.toBeNull();
    await page.reload();
    await expect(page.getByRole("button", { name: /Resume/ })).toHaveCount(0);
    expect((await stored(page)).answers).toHaveLength(3);
});

test("phone exit keeps graded work and discards ungraded answers only after confirmation", async ({
    page,
}) => {
    await openSample(page, "Practice");
    const before = structuredClone((await stored(page)).cards);
    // The shuffled Practice order may start with either question type.
    if (await page.getByRole("radio").count()) {
        await page.getByRole("radio").first().check();

        await nextQuestion(page);
        if (await page.getByRole("radio").count()) {
            await page.getByRole("radio").first().check();

            await nextQuestion(page);
        }
    }
    await page
        .getByLabel("Your answer", { exact: true })
        .fill("An ungraded draft");
    await page
        .getByRole("button", { name: "Save and exit", exact: true })
        .click();
    const confirmation = page.getByRole("dialog", {
        name: "Leave ungraded answers?",
        exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation
        .getByRole("button", { name: "Review ungraded answers", exact: true })
        .click();
    await expect(
        page.getByRole("region", { name: "Session results", exact: true }),
    ).toBeVisible();
    await page
        .getByRole("button", { name: "Finish session", exact: true })
        .click();
    await confirmation
        .getByRole("button", { name: "Discard ungraded and exit", exact: true })
        .click();
    await expect(
        page.getByRole("heading", { name: "Study sets", exact: true }),
    ).toBeVisible();
    const saved = await stored(page);
    expect(saved.cards).toEqual(before);
    expect(JSON.stringify(saved.sessions[0].draftAnswers)).not.toContain(
        "An ungraded draft",
    );
    expect(
        saved.outbox.filter((event) => event.kind === "review.applied"),
    ).toHaveLength(0);
});

test("phone layout fits small screens and both themes with reachable touch controls", async ({
    page,
}) => {
    await openSample(page);
    for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const size of [
            { width: 320, height: 568 },
            { width: 390, height: 844 },
            { width: 390, height: 420 },
        ]) {
            await page.setViewportSize(size);
            await expect(
                page.getByRole("button", {
                    name: "Reveal answer",
                    exact: true,
                }),
            ).toBeInViewport();
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                ),
            ).toBe(true);
            expect(
                (await page
                    .getByRole("button", { name: "Save and exit", exact: true })
                    .boundingBox())!.height,
            ).toBeGreaterThanOrEqual(44);
            await page.screenshot({
                path: `/tmp/obstudy-ios-${test.info().project.name}-${colorScheme}-${size.width}-${size.height}.png`,
            });
        }
    }
});
