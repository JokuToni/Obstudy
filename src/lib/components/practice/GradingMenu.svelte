<script lang="ts">
    import { drawingAiReason } from "$lib/drawing/answers";
    import { onMount } from "svelte";
    import type { AnswerGrade } from "$lib/types/exercises";
    import { button } from "$lib/components/ui/styles";
    let {
        onGrade,
        onAi,
        onSkip,
        onCancel,
        hasDrawing = false,
    }: {
        onGrade: (grade: AnswerGrade) => void;
        onAi: () => void;
        onSkip: () => void;
        onCancel: () => void;
        hasDrawing?: boolean;
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
            const current = focused < 0 ? buttons.indexOf(skipButton) : focused;
            buttons[
                (current +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
            ]?.focus();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
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

<div
    data-grading-backdrop
    class="pointer-events-none absolute inset-0 z-10 grid place-items-center overflow-hidden bg-scrim/50 p-4 backdrop-blur-sm"
>
    <dialog
        bind:this={dialog}
        aria-labelledby="grading-menu-title"
        oncancel={(event) => {
            event.preventDefault();
            onCancel();
        }}
        class="pointer-events-auto relative inset-auto m-0 max-h-full w-full max-w-lg space-y-3 overflow-y-auto rounded-lg border border-control-border bg-surface p-4 text-text-primary shadow-lg"
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
            <button
                type="button"
                class={button}
                disabled={hasDrawing}
                title={hasDrawing ? drawingAiReason : undefined}
                onclick={onAi}>Grade with AI</button
            >
            <button
                bind:this={skipButton}
                type="button"
                class={button}
                onclick={onSkip}>Skip</button
            >
            <button type="button" class={button} onclick={onCancel}
                >Cancel</button
            >
        </div>
        {#if hasDrawing}<p class="text-xs/5 text-text-muted">
                {drawingAiReason}
            </p>{/if}
        <p class="text-xs/5 text-text-muted">
            Continue now; skipped answers can be graded in results. Cancel stays
            on this question.
        </p>
    </dialog>
</div>
