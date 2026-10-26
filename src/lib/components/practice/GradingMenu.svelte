<script lang="ts">
    import { onMount } from "svelte";
    import type { AnswerGrade } from "$lib/types/exercises";
    import { button } from "$lib/components/ui/styles";
    let {
        onGrade,
        onAi,
        onSkip,
    }: {
        onGrade: (grade: AnswerGrade) => void;
        onAi: () => void;
        onSkip: () => void;
    } = $props();
    let dialog: HTMLDialogElement;
    let skipButton: HTMLButtonElement;
    const levels = [
        { points: 0, label: "Incorrect" },
        { points: 0.5, label: "Partly correct" },
        { points: 1, label: "Correct" },
    ] as const;
    onMount(() => {
        // Keep the example answer scrollable while the compact prompt is open.
        dialog.show();
        skipButton.focus();
        document.addEventListener("keydown", keydown);
        return () => {
            document.removeEventListener("keydown", keydown);
            dialog.close();
        };
    });
    function keydown(event: KeyboardEvent): void {
        if (
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
        )
            return;
        if (
            event.target instanceof Element &&
            event.target.closest("dialog") &&
            !dialog.contains(event.target)
        )
            return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            const buttons = Array.from(
                dialog.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                ),
            );
            const focused = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
            );
            const current = focused < 0 ? buttons.length - 1 : focused;
            buttons[
                (current +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
            ]?.focus();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onSkip();
        } else if (
            event.key === "Enter" &&
            event.target instanceof HTMLButtonElement &&
            dialog.contains(event.target)
        ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat && event.target instanceof HTMLButtonElement)
                event.target.click();
        }
    }
</script>

<dialog
    bind:this={dialog}
    aria-labelledby="grading-menu-title"
    oncancel={(event) => {
        event.preventDefault();
        onSkip();
    }}
    class="fixed inset-auto bottom-24 left-1/2 m-0 w-[calc(100%_-_32px)] max-w-lg -translate-x-1/2 space-y-3 rounded-lg border border-control-border bg-surface p-4 text-text-primary shadow-lg backdrop:bg-transparent"
>
    <div class="flex items-center justify-between gap-3">
        <h2 id="grading-menu-title" class="text-sm font-medium">
            Grade your answer
        </h2>
        <span class="text-xs text-text-muted">← → · Enter</span>
    </div>
    <div class="flex flex-wrap gap-2">
        {#each levels as level}<button
                type="button"
                class={button}
                onclick={() =>
                    onGrade({
                        points: level.points,
                        source: "self",
                        feedback: "",
                    })}>{level.label} · {level.points}</button
            >{/each}
        <button type="button" class={button} onclick={onAi}
            >Grade with AI</button
        >
        <button
            bind:this={skipButton}
            type="button"
            class={button}
            onclick={onSkip}>Skip</button
        >
    </div>
    <p class="text-xs/5 text-text-muted">
        Continue now; skipped answers can be graded in results.
    </p>
</dialog>
