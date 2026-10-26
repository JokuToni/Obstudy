<script lang="ts">
    import { onMount } from "svelte";
    import { button } from "$lib/components/ui/styles";
    let {
        count,
        onReview,
        onDiscard,
    }: { count: number; onReview: () => void; onDiscard: () => void } =
        $props();
    let dialog: HTMLDialogElement;
    onMount(() => {
        const previous = document.activeElement as HTMLElement | null;
        dialog.showModal();
        return () => {
            dialog.close();
            previous?.focus();
        };
    });
</script>

<dialog
    bind:this={dialog}
    oncancel={(event) => {
        event.preventDefault();
        onReview();
    }}
    aria-labelledby="exit-grading-title"
    class="m-auto w-[calc(100%_-_32px)] max-w-md space-y-4 rounded-lg border border-border bg-canvas p-6 text-text-primary backdrop:bg-canvas/80"
>
    <h2 id="exit-grading-title" class="text-base font-semibold">
        Leave ungraded answers?
    </h2>
    <p class="text-sm/6 text-text-secondary">
        {count}
        {count === 1 ? "answer has" : "answers have"} no grade. Leaving now will permanently
        discard these answers and their saved drafts. Your graded answers will be
        kept.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class={button} onclick={onReview}
            >Review ungraded answers</button
        ><button
            type="button"
            class={[button, "text-danger!"]}
            onclick={onDiscard}>Discard ungraded and exit</button
        >
    </div>
</dialog>
