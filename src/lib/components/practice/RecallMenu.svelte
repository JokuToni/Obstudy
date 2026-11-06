<script lang="ts">
    import { onMount, tick } from "svelte";
    import RecallChoices from "./RecallChoices.svelte";
    import { button } from "$lib/components/ui/styles";
    let {
        points,
        onRate,
        onCancel,
    }: {
        points: number;
        onRate: (rating: 1 | 2 | 3 | 4) => void;
        onCancel: () => void;
    } = $props();
    let dialog: HTMLDialogElement;
    onMount(() => {
        dialog.show();
        void tick().then(() =>
            dialog
                .querySelector<HTMLButtonElement>(
                    `[data-rating="${points === 0 ? 1 : points === 0.5 ? 2 : 3}"]`,
                )
                ?.focus(),
        );
        return () => dialog.close();
    });
</script>

<div
    data-recall-backdrop
    class="absolute inset-0 z-20 flex items-center justify-center overflow-hidden bg-scrim/50 p-4 backdrop-blur-sm"
>
    <dialog
        bind:this={dialog}
        aria-labelledby="recall-menu-title"
        oncancel={(event) => {
            event.preventDefault();
            onCancel();
        }}
        class="relative inset-auto m-0 max-h-full w-full max-w-sm space-y-3 overflow-y-auto rounded-lg border border-control-border bg-surface p-4 text-text-primary shadow-lg"
    >
        <h2 id="recall-menu-title" class="text-sm font-semibold">
            Rate your recall
        </h2>
        <p class="text-xs/5 text-text-muted">
            How well did you remember? This sets the next review date.
        </p>
        <RecallChoices {points} {onRate} autofocus />
        <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-text-muted">↑ ↓ · → Select</span><button
                type="button"
                class={button}
                onclick={onCancel}>Cancel</button
            >
        </div>
    </dialog>
</div>
