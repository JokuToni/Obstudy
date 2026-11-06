<script lang="ts">
    import { onMount } from "svelte";
    import { button } from "$lib/components/ui/styles";
    let {
        points,
        onRate,
        autofocus = false,
        disabled = false,
    }: {
        points: number;
        onRate: (rating: 1 | 2 | 3 | 4) => void;
        autofocus?: boolean;
        disabled?: boolean;
    } = $props();
    let root: HTMLDivElement;
    const suggested = $derived(points === 0 ? 1 : points === 0.5 ? 2 : 3);
    const choices = [
        { value: 1, label: "Again", hint: "Could not recall" },
        { value: 2, label: "Hard", hint: "Recalled with difficulty" },
        { value: 3, label: "Good", hint: "Recalled normally" },
        { value: 4, label: "Easy", hint: "Recalled effortlessly" },
    ] as const;
    onMount(() => {
        if (autofocus)
            root.querySelector<HTMLButtonElement>(
                `[data-rating="${suggested}"]`,
            )?.focus();
    });
    function keydown(event: KeyboardEvent): void {
        if (
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.isComposing
        )
            return;
        const buttons = Array.from(
            root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
        );
        if (current < 0) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            buttons[
                (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
            ]?.focus();
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) buttons[current]?.click();
        }
    }
</script>

<div
    bind:this={root}
    role="group"
    aria-label="Recall rating"
    class="grid gap-2"
>
    {#each choices as choice}<button
            type="button"
            onkeydown={keydown}
            data-rating={choice.value}
            {disabled}
            class={[
                button,
                "flex items-center justify-between gap-3 text-left",
                choice.value === suggested ? "border-accent!" : "",
            ]}
            onclick={() => onRate(choice.value)}
            ><span>{choice.label}</span><span class="text-xs text-text-muted"
                >{choice.hint}</span
            ></button
        >{/each}
</div>
